import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DescribeExecutionCommand,
  DescribeStateMachineCommand,
  GetExecutionHistoryCommand,
  SFNClient,
  StartExecutionCommand,
  StartSyncExecutionCommand,
  StateMachineDoesNotExist,
} from '@aws-sdk/client-sfn';
import { SfnRunDriver, UnknownGraphError, stateMachineName, type RunStart } from '../src/index.ts';
import { APP, GRAPH, setup } from './harness.ts';

const PREFIX = 'arn:aws:states:ap-northeast-2:123456789012:stateMachine:';
const MACHINE = `${PREFIX}kelay-app-ticket-board-prod-overdue-summary`;
const EXECUTION = 'arn:aws:states:ap-northeast-2:123456789012:execution:kelay-app-ticket-board-prod-overdue-summary:run-1';

const client = new SFNClient({ region: 'ap-northeast-2' });
const sfn = mockClient(client);
const driver = () => new SfnRunDriver({ stateMachineArnPrefix: PREFIX, sfn: client, pollMs: 1 });
const run: RunStart = { runId: 'run-1', app: APP, env: 'prod', graph: GRAPH, input: { since: '2026-11-01' }, userToken: 'user.jwt' };
const at = (seconds: number) => new Date(Date.UTC(2026, 10, 11, 9, 0, seconds));

beforeEach(() => sfn.reset());

describe('SfnRunDriver', () => {
  it('names the state machine after the app, env and graph', () => {
    expect(stateMachineName('ticket-board', 'dev', 'overdue-summary')).toBe('kelay-app-ticket-board-dev-overdue-summary');
  });

  it('runs an Express machine synchronously with { input, userToken } and the run id as the execution name', async () => {
    sfn.on(DescribeStateMachineCommand).resolves({ type: 'EXPRESS' });
    sfn.on(StartSyncExecutionCommand).resolves({ status: 'SUCCEEDED', output: JSON.stringify({ approved: true }) });
    const d = driver();
    expect(await (await d.start(run)).done).toEqual({ status: 'succeeded', output: { approved: true }, trace: [] });

    expect(sfn.commandCalls(DescribeStateMachineCommand)[0]!.args[0].input).toEqual({ stateMachineArn: MACHINE });
    const sent = sfn.commandCalls(StartSyncExecutionCommand)[0]!.args[0].input;
    expect(sent).toMatchObject({ stateMachineArn: MACHINE, name: 'run-1' });
    expect(JSON.parse(sent.input!)).toEqual({ input: { since: '2026-11-01' }, userToken: 'user.jwt' });

    // The machine's type is looked up once.
    await (await d.start({ ...run, runId: 'run-2' })).done;
    expect(sfn.commandCalls(DescribeStateMachineCommand)).toHaveLength(1);
  });

  it('reports a failed Express execution with the error and cause Step Functions gives', async () => {
    sfn.on(DescribeStateMachineCommand).resolves({ type: 'EXPRESS' });
    sfn.on(StartSyncExecutionCommand).resolves({ status: 'FAILED', error: 'Kelay.InvalidReviewOutput', cause: 'A review node must output an object with a boolean "approved" field.' });
    expect(await (await driver().start(run)).done).toEqual({
      status: 'failed',
      error: { name: 'Kelay.InvalidReviewOutput', message: 'A review node must output an object with a boolean "approved" field.' },
      trace: [],
    });

    sfn.on(StartSyncExecutionCommand).rejects(new Error('throttled'));
    expect(await (await driver().start(run)).done).toMatchObject({ status: 'failed', error: { message: 'throttled' } });
  });

  it('starts a Standard machine, polls it, and builds the node trace from its history', async () => {
    sfn.on(DescribeStateMachineCommand).resolves({ type: 'STANDARD' });
    sfn.on(StartExecutionCommand).resolves({ executionArn: EXECUTION });
    sfn
      .on(DescribeExecutionCommand)
      .resolvesOnce({ status: 'RUNNING' })
      .resolves({ status: 'SUCCEEDED', output: JSON.stringify({ approved: true, summary: 'ok' }) });
    sfn
      .on(GetExecutionHistoryCommand)
      .resolvesOnce({
        nextToken: 'page-2',
        events: [
          { id: 1, type: 'ExecutionStarted', timestamp: at(0) },
          { id: 2, type: 'PassStateEntered', timestamp: at(0), stateEnteredEventDetails: { name: 'Init' } },
          { id: 3, type: 'TaskStateEntered', timestamp: at(1), stateEnteredEventDetails: { name: 'collect' } },
          { id: 4, type: 'TaskStateExited', timestamp: at(3), stateExitedEventDetails: { name: 'collect' } },
          { id: 5, type: 'ParallelStateEntered', timestamp: at(3), stateEnteredEventDetails: { name: 'Fan out from collect' } },
          { id: 6, type: 'TaskStateEntered', timestamp: at(3), stateEnteredEventDetails: { name: 'summarize' } },
          { id: 7, type: 'TaskStateEntered', timestamp: at(3), stateEnteredEventDetails: { name: 'prioritize' } },
        ],
      })
      .resolves({
        events: [
          { id: 8, type: 'TaskStateExited', timestamp: at(4), stateExitedEventDetails: { name: 'prioritize' } },
          { id: 9, type: 'TaskStateExited', timestamp: at(8), stateExitedEventDetails: { name: 'summarize' } },
          { id: 10, type: 'TaskStateEntered', timestamp: at(8), stateEnteredEventDetails: { name: 'review' } },
          { id: 11, type: 'TaskStateExited', timestamp: at(9), stateExitedEventDetails: { name: 'review' } },
          { id: 12, type: 'ExecutionSucceeded', timestamp: at(9) },
        ],
      });

    const result = await (await driver().start(run)).done;
    expect(result).toMatchObject({ status: 'succeeded', output: { approved: true, summary: 'ok' } });
    expect(result.trace.map((t) => [t.node, t.status, t.ms])).toEqual([
      ['collect', 'ok', 2000],
      ['summarize', 'ok', 5000],
      ['prioritize', 'ok', 1000],
      ['review', 'ok', 1000],
    ]);
    expect(sfn.commandCalls(StartExecutionCommand)[0]!.args[0].input).toMatchObject({ stateMachineArn: MACHINE, name: 'run-1' });
    expect(sfn.commandCalls(DescribeExecutionCommand)).toHaveLength(2);
    expect(sfn.commandCalls(GetExecutionHistoryCommand)[1]!.args[0].input).toMatchObject({ executionArn: EXECUTION, nextToken: 'page-2' });
  });

  it('marks the node that never finished when a Standard execution fails', async () => {
    sfn.on(DescribeStateMachineCommand).resolves({ type: 'STANDARD' });
    sfn.on(StartExecutionCommand).resolves({ executionArn: EXECUTION });
    sfn.on(DescribeExecutionCommand).resolves({ status: 'FAILED', error: 'States.Timeout', cause: 'collect timed out' });
    sfn.on(GetExecutionHistoryCommand).resolves({
      events: [
        { id: 1, type: 'TaskStateEntered', timestamp: at(0), stateEnteredEventDetails: { name: 'collect' } },
        { id: 2, type: 'TaskTimedOut', timestamp: at(30) },
        { id: 3, type: 'ExecutionFailed', timestamp: at(30) },
      ],
    });
    expect(await (await driver().start(run)).done).toMatchObject({
      status: 'failed',
      error: { name: 'States.Timeout', message: 'collect timed out' },
      trace: [{ node: 'collect', status: 'error', ms: 30_000 }],
    });
  });

  it('rejects with UnknownGraphError when the app has no such state machine', async () => {
    sfn.on(DescribeStateMachineCommand).rejects(new StateMachineDoesNotExist({ message: 'State Machine Does Not Exist', $metadata: {} }));
    await expect(driver().start(run)).rejects.toBeInstanceOf(UnknownGraphError);

    const { start } = await setup({ driver: driver() });
    expect((await start({ graph: 'no-such-graph' })).body).toMatchObject({ error: { code: 'not_found' } });
  });

  it('serves a run through the orchestrator', async () => {
    sfn.on(DescribeStateMachineCommand).resolves({ type: 'EXPRESS' });
    sfn.on(StartSyncExecutionCommand).resolves({ status: 'SUCCEEDED', output: '{"approved":true}' });
    const { start, get, userToken } = await setup({ driver: driver() });
    const token = await userToken();
    const { runId } = (await start({ graph: GRAPH, input: 7 }, { token })).body;
    expect((await get(runId, { token })).body.run).toMatchObject({ status: 'succeeded', output: { approved: true }, trace: [] });
    const sent = sfn.commandCalls(StartSyncExecutionCommand)[0]!.args[0].input;
    expect(sent.name).toBe(runId);
    expect(JSON.parse(sent.input!)).toEqual({ input: 7, userToken: token });
  });
});
