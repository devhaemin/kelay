// Runs a graph on the state machine the control API's aws deploy driver created for it:
// `kelay-app-<app>-<env>-<graph>`, with execution input `{ input, userToken }` (contract §10).
// Express machines answer in one synchronous call; Standard ones are started, polled, and their
// history gives the per-node trace. Express executions keep no history, so their trace is empty.
import {
  DescribeExecutionCommand,
  DescribeStateMachineCommand,
  GetExecutionHistoryCommand,
  SFNClient,
  StartExecutionCommand,
  StartSyncExecutionCommand,
  StateMachineDoesNotExist,
  type HistoryEvent,
} from '@aws-sdk/client-sfn';
import type { GraphExecutionInput } from '@kelay/contracts';
import { UnknownGraphError, type NodeTrace, type RunDriver, type RunResult, type RunStart, type StartedRun } from '../driver.ts';

export interface SfnDriverOptions {
  /** `arn:aws:states:<region>:<account>:stateMachine:` — the machine name is appended to it. */
  stateMachineArnPrefix: string;
  sfn?: SFNClient;
  region?: string;
  /** How often a Standard execution is polled. @default 1000 */
  pollMs?: number;
  /** A Standard execution still running after this long is reported as failed (it keeps running in AWS). @default 900 */
  maxRunSeconds?: number;
}

export const stateMachineName = (app: string, env: string, graph: string) => `kelay-app-${app}-${env}-${graph}`;

const RUN_TIMEOUT_ERROR = 'Kelay.RunTimeout';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isMissing = (e: unknown) => e instanceof StateMachineDoesNotExist || (e as Error)?.name === 'StateMachineDoesNotExist';

function parseOutput(output: string | undefined): unknown {
  if (output === undefined) return null;
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

const failure = (error: string | undefined, cause: string | undefined, status: string): RunResult['error'] => ({
  name: error ?? `States.${status}`,
  message: cause ?? `the execution ended as ${status}`,
});

/** Task states are the graph's nodes; every other state of the compiled machine is plumbing. */
export function traceFromHistory(events: HistoryEvent[], failed: boolean): NodeTrace[] {
  const trace: NodeTrace[] = [];
  const open = new Map<string, { entry: NodeTrace; at: number }[]>();
  let last = 0;
  for (const e of events) {
    const at = e.timestamp?.getTime() ?? last;
    last = Math.max(last, at);
    if (e.type === 'TaskStateEntered' && e.stateEnteredEventDetails?.name) {
      const node = e.stateEnteredEventDetails.name;
      const entry: NodeTrace = { node, status: 'aborted', ms: 0, startedAt: new Date(at).toISOString() };
      trace.push(entry);
      open.set(node, [...(open.get(node) ?? []), { entry, at }]);
    } else if (e.type === 'TaskStateExited' && e.stateExitedEventDetails?.name) {
      const started = open.get(e.stateExitedEventDetails.name)?.shift();
      if (started) Object.assign(started.entry, { status: 'ok', ms: at - started.at });
    }
  }
  for (const pending of open.values()) {
    for (const { entry, at } of pending) Object.assign(entry, { status: failed ? 'error' : 'aborted', ms: last - at });
  }
  return trace;
}

export class SfnRunDriver implements RunDriver {
  readonly name = 'sfn';
  private readonly sfn: SFNClient;
  private readonly types = new Map<string, 'EXPRESS' | 'STANDARD'>();

  constructor(private readonly opts: SfnDriverOptions) {
    this.sfn = opts.sfn ?? new SFNClient(opts.region ? { region: opts.region } : {});
  }

  async start(run: RunStart): Promise<StartedRun> {
    const arn = `${this.opts.stateMachineArnPrefix}${stateMachineName(run.app, run.env, run.graph)}`;
    let type = this.types.get(arn);
    if (!type) {
      try {
        type = (await this.sfn.send(new DescribeStateMachineCommand({ stateMachineArn: arn }))).type === 'EXPRESS' ? 'EXPRESS' : 'STANDARD';
      } catch (e) {
        if (isMissing(e)) throw new UnknownGraphError(run.app, run.graph, run.env);
        throw e;
      }
      this.types.set(arn, type);
    }
    const execution = { stateMachineArn: arn, name: run.runId, input: JSON.stringify({ input: run.input, userToken: run.userToken } satisfies GraphExecutionInput) };

    if (type === 'EXPRESS') {
      const done = this.sfn.send(new StartSyncExecutionCommand(execution)).then(
        (res): RunResult =>
          res.status === 'SUCCEEDED'
            ? { status: 'succeeded', output: parseOutput(res.output), trace: [] }
            : { status: 'failed', error: failure(res.error, res.cause, res.status ?? 'FAILED'), trace: [] },
        (e: unknown): RunResult => this.failed(arn, e),
      );
      return { done };
    }

    let executionArn: string;
    try {
      executionArn = (await this.sfn.send(new StartExecutionCommand(execution))).executionArn ?? '';
    } catch (e) {
      if (isMissing(e)) {
        this.types.delete(arn);
        throw new UnknownGraphError(run.app, run.graph, run.env);
      }
      throw e;
    }
    return { done: this.follow(executionArn).catch((e: unknown): RunResult => this.failed(arn, e)) };
  }

  private failed(arn: string, e: unknown): RunResult {
    // The machine may have been deleted or replaced since its type was cached.
    if (isMissing(e)) this.types.delete(arn);
    return { status: 'failed', error: { name: e instanceof Error ? e.name : 'Error', message: e instanceof Error ? e.message : String(e) }, trace: [] };
  }

  private async follow(executionArn: string): Promise<RunResult> {
    const deadline = Date.now() + (this.opts.maxRunSeconds ?? 900) * 1000;
    for (;;) {
      const res = await this.sfn.send(new DescribeExecutionCommand({ executionArn }));
      if (res.status && res.status !== 'RUNNING' && res.status !== 'PENDING_REDRIVE') {
        const ok = res.status === 'SUCCEEDED';
        const trace = await this.history(executionArn, !ok);
        return ok
          ? { status: 'succeeded', output: parseOutput(res.output), trace }
          : { status: 'failed', error: failure(res.error, res.cause, res.status), trace };
      }
      if (Date.now() > deadline) {
        return {
          status: 'failed',
          error: { name: RUN_TIMEOUT_ERROR, message: `the run did not finish within ${this.opts.maxRunSeconds ?? 900}s` },
          trace: await this.history(executionArn, false),
        };
      }
      await sleep(this.opts.pollMs ?? 1000);
    }
  }

  private async history(executionArn: string, failed: boolean): Promise<NodeTrace[]> {
    const events: HistoryEvent[] = [];
    let nextToken: string | undefined;
    try {
      do {
        const page = await this.sfn.send(new GetExecutionHistoryCommand({ executionArn, includeExecutionData: false, maxResults: 1000, nextToken }));
        events.push(...(page.events ?? []));
        nextToken = page.nextToken;
      } while (nextToken);
    } catch {
      // The outcome is known; a missing trace must not turn a finished run into a failed one.
      return [];
    }
    return traceFromHistory(events, failed);
  }
}
