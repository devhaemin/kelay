import { describe, expect, it } from 'vitest';
import aslValidator from 'asl-validator';
import type { GraphSpec, NodeInvocation } from '@kelay/contracts';
import {
  compileToAsl,
  DONE_STATE,
  fanOutStateName,
  GraphError,
  INIT_STATE,
  INVALID_REVIEW_ERROR,
  INVALID_REVIEW_STATE,
  LAMBDA_TRANSIENT_RETRY,
  reviewStateName,
  type AslParallel,
  type AslStateMachine,
  type AslTask,
} from './index.ts';
import { overdueSummaryGraph } from './testing/fixtures.ts';
import { AslFailure, interpretAsl } from './testing/interpret-asl.ts';

const ARN = 'arn:aws:lambda:ap-northeast-2:123456789012:function:kelay-ticket-board-prod-nodes:live';
const opts = { app: 'ticket-board', env: 'prod', functionArn: ARN } as const;

const validate = (m: AslStateMachine) => aslValidator(structuredClone(m));

describe('compileToAsl', () => {
  const asl = compileToAsl(overdueSummaryGraph(), opts);

  it('matches the snapshot for the ticket-board fixture', async () => {
    await expect(`${JSON.stringify(asl, null, 2)}\n`).toMatchFileSnapshot('./__snapshots__/overdue-summary.asl.json');
  });

  it('passes asl-validator, including JSONata syntax, transitions, reachability and terminals', () => {
    const result = validate(asl);
    expect(result.errorsText('\n')).toBe('');
    expect(result.isValid).toBe(true);
  });

  it('is rejected by asl-validator when a transition target is missing', () => {
    const broken = structuredClone(asl);
    (broken.States['Fan out from collect'] as AslParallel).Next = 'nowhere';
    expect(validate(broken).isValid).toBe(false);
  });

  it('wires states as the graph describes', () => {
    expect(asl.QueryLanguage).toBe('JSONata');
    expect(asl.StartAt).toBe(INIT_STATE);
    expect(asl.States[INIT_STATE]).toMatchObject({ Type: 'Pass', Assign: { loop: 0, rejects_review: 0 }, Next: 'collect' });
    expect(asl.States.collect).toMatchObject({ Type: 'Task', TimeoutSeconds: 30, Next: fanOutStateName('collect') });

    const fan = asl.States[fanOutStateName('collect')] as AslParallel;
    expect(fan.Type).toBe('Parallel');
    expect(fan.Next).toBe('review');
    expect(fan.Branches.map((b) => b.StartAt)).toEqual(['summarize', 'prioritize']);
    for (const b of fan.Branches) expect(b.States[b.StartAt]).toMatchObject({ Type: 'Task', End: true });
    expect(asl.States.summarize).toBeUndefined();

    expect(asl.States.review).toMatchObject({ Type: 'Task', Next: reviewStateName('review') });
    expect(asl.States[reviewStateName('review')]).toEqual({
      Type: 'Choice',
      Choices: [
        { Condition: "{% $not($type($states.input.approved) = 'boolean') %}", Next: INVALID_REVIEW_STATE },
        {
          Condition: '{% $states.input.approved = false and $rejects_review < 2 %}',
          Assign: { rejects_review: '{% $rejects_review + 1 %}', loop: '{% $loop + 1 %}' },
          Next: 'collect',
        },
      ],
      Default: DONE_STATE,
    });
    expect(asl.States[DONE_STATE]).toEqual({ Type: 'Succeed' });
    expect(asl.States[INVALID_REVIEW_STATE]).toMatchObject({ Type: 'Fail', Error: INVALID_REVIEW_ERROR });
  });

  it('builds a NodeInvocation payload and maps retry and timeout', () => {
    const summarize = (asl.States[fanOutStateName('collect')] as AslParallel).Branches[0]!.States.summarize as AslTask;
    expect(summarize.Resource).toBe('arn:aws:states:::lambda:invoke');
    expect(summarize.Arguments.FunctionName).toBe(ARN);
    expect(summarize.Arguments.Payload).toEqual({
      runId: '{% $states.context.Execution.Name %}',
      app: 'ticket-board',
      env: 'prod',
      graph: 'overdue-summary',
      node: 'summarize',
      attempt: '{% $states.context.State.RetryCount + 1 %}',
      loop: '{% $loop %}',
      input: '{% $states.input %}',
      userToken: '{% $states.context.Execution.Input.userToken %}',
    } satisfies Record<keyof NodeInvocation, unknown>);
    expect(summarize.Output).toBe('{% $states.result.Payload %}');
    expect(summarize.Retry).toEqual([
      LAMBDA_TRANSIENT_RETRY,
      { ErrorEquals: ['States.ALL'], MaxAttempts: 2, IntervalSeconds: 2, BackoffRate: 2 },
    ]);
    expect(summarize.TimeoutSeconds).toBeUndefined();
    expect((asl.States.collect as AslTask).Retry).toEqual([LAMBDA_TRANSIENT_RETRY]);
  });

  it('rounds retry intervals up to whole seconds and applies ASL defaults', () => {
    const m = compileToAsl({ name: 'g1', start: 'a', nodes: { a: { retry: { maxAttempts: 3, intervalSeconds: 0.2 } } } }, opts);
    expect((m.States.a as AslTask).Retry[1]).toEqual({ ErrorEquals: ['States.ALL'], MaxAttempts: 3, IntervalSeconds: 1, BackoffRate: 2 });
  });

  it('resolves a function ARN per node', () => {
    const m = compileToAsl(overdueSummaryGraph(), { ...opts, functionArn: (node) => `arn:aws:lambda:ap-northeast-2:1:function:${node}` });
    const fan = m.States[fanOutStateName('collect')] as AslParallel;
    expect((fan.Branches[1]!.States.prioritize as AslTask).Arguments.FunctionName).toBe('arn:aws:lambda:ap-northeast-2:1:function:prioritize');
    expect((m.States.review as AslTask).Arguments.FunctionName).toBe('arn:aws:lambda:ap-northeast-2:1:function:review');
  });

  it('ends a linear graph on its last task without review states', () => {
    const m = compileToAsl({ name: 'g1', start: 'a', nodes: { a: { next: 'b' }, b: {} } }, opts);
    expect(Object.keys(m.States)).toEqual([INIT_STATE, 'a', 'b']);
    expect(m.States.b).toMatchObject({ End: true });
    expect(validate(m).isValid).toBe(true);
  });

  it('continues an approved or exhausted review to its next node, including a fan-out', () => {
    const spec: GraphSpec = {
      name: 'g1',
      start: 'draft',
      nodes: {
        draft: { next: 'check' },
        check: { next: ['a', 'b'], review: { onReject: 'draft', maxLoops: 1 } },
        a: { next: 'merge' },
        b: { next: 'merge' },
        merge: {},
      },
    };
    const m = compileToAsl(spec, opts);
    expect(m.States[reviewStateName('check')]).toMatchObject({ Default: fanOutStateName('check') });
    expect(m.States[DONE_STATE]).toBeUndefined();
    expect(validate(m).isValid).toBe(true);
  });

  it('refuses an invalid graph', () => {
    expect(() => compileToAsl({ name: 'g1', start: 'a', nodes: { a: { next: 'a' } } }, opts)).toThrow(GraphError);
  });
});

describe('compiled ASL executed with real JSONata', () => {
  const asl = compileToAsl(overdueSummaryGraph(), opts);
  const userToken = 'user.jwt';

  const run = (review: (inv: NodeInvocation) => unknown) => {
    const calls: NodeInvocation[] = [];
    const lambda = (fn: string, payload: unknown) => {
      expect(fn).toBe(ARN);
      const inv = payload as NodeInvocation;
      calls.push(inv);
      if (inv.node === 'review') return review(inv);
      return { from: inv.node, loop: inv.loop };
    };
    return { calls, done: interpretAsl(asl, { input: { since: '2026-11-01' }, userToken }, lambda, 'run-42') };
  };

  it('carries run id, user token and input, and joins branch outputs in order', async () => {
    const { calls, done } = run(() => ({ approved: true }));
    expect(await done).toEqual({ approved: true });
    expect(calls.map((c) => c.node)).toEqual(['collect', 'summarize', 'prioritize', 'review']);
    expect(calls[0]).toEqual({
      runId: 'run-42',
      app: 'ticket-board',
      env: 'prod',
      graph: 'overdue-summary',
      node: 'collect',
      attempt: 1,
      loop: 0,
      input: { since: '2026-11-01' },
      userToken,
    });
    expect(calls[3]!.input).toEqual([
      { from: 'summarize', loop: 0 },
      { from: 'prioritize', loop: 0 },
    ]);
  });

  it('loops back to onReject with the review output, then stops after maxLoops', async () => {
    const { calls, done } = run((inv) => ({ approved: false, note: `try ${inv.loop}` }));
    expect(await done).toEqual({ approved: false, note: 'try 2' });
    const collects = calls.filter((c) => c.node === 'collect');
    expect(collects.map((c) => [c.loop, c.input])).toEqual([
      [0, { since: '2026-11-01' }],
      [1, { approved: false, note: 'try 0' }],
      [2, { approved: false, note: 'try 1' }],
    ]);
  });

  it('fails on a review output without a boolean approved', async () => {
    const { done } = run(() => ({ approved: 'yes' }));
    await expect(done).rejects.toMatchObject({ error: INVALID_REVIEW_ERROR } satisfies Partial<AslFailure>);
  });
});
