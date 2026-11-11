// Runs a graph in this process with @kelay/graph's `runLocal`: same semantics as the compiled state
// machine. The node code comes from modules the server loads at start (RUNNER_LOCAL_NODES).
import type { GraphSpec, NodeInvocation } from '@kelay/contracts';
import { GraphRunError, runLocal, type TraceEntry } from '@kelay/graph';
import { signCallerToken } from '@kelay/tokens';
import {
  UnknownGraphError,
  sumCost,
  type DriverEvent,
  type NodeStatus,
  type NodeTrace,
  type RunDriver,
  type RunResult,
  type RunStart,
  type StartedRun,
} from '../driver.ts';

/** What the platform hands a node next to its invocation; in AWS the function's environment holds the same. */
export interface LocalNodeHost {
  /** App-runtime caller token for this app × env (contract §4). */
  callerToken: string;
  signal: AbortSignal;
}

export interface LocalNodeResult {
  output: unknown;
  usage?: { llmCalls?: number; costUsd?: number };
}

/** An app's agent nodes, loaded into the runner. `createLocalNodes` in @kelay/runtime builds one. */
export interface LocalNodes {
  graphs: GraphSpec[];
  invoke(invocation: NodeInvocation, host: LocalNodeHost): Promise<LocalNodeResult>;
}

export interface LocalDriverOptions {
  /** App slug → its nodes. */
  apps: Record<string, LocalNodes>;
  /** KELAY_CALLER_SECRET: the runner mints the app-runtime token the nodes call the Data API with. */
  callerSecret: string;
  /** Lifetime of that token; it must outlive the run. */
  callerTokenTtlSeconds?: number;
}

const key = (node: string, attempt: number, loop: number) => `${node}#${attempt}@${loop}`;

// An entry still `running` when the run ends belongs to a branch that was abandoned after its sibling failed.
const STATUS: Record<TraceEntry['status'], NodeStatus> = { ok: 'ok', error: 'error', timeout: 'timeout', running: 'aborted' };

export class LocalRunDriver implements RunDriver {
  readonly name = 'local';

  constructor(private readonly opts: LocalDriverOptions) {}

  async start(run: RunStart, emit: (event: DriverEvent) => void): Promise<StartedRun> {
    const nodes = Object.hasOwn(this.opts.apps, run.app) ? this.opts.apps[run.app] : undefined;
    const spec = nodes?.graphs.find((g) => g.name === run.graph);
    if (!nodes || !spec) throw new UnknownGraphError(run.app, run.graph, run.env);
    const callerToken = await signCallerToken(
      { kind: 'app-runtime', app: run.app, env: run.env },
      this.opts.callerSecret,
      this.opts.callerTokenTtlSeconds ?? 3600,
    );

    const usage = new Map<string, NonNullable<LocalNodeResult['usage']>>();
    const toTrace = (entries: TraceEntry[]): NodeTrace[] =>
      entries.map((t) => ({
        node: t.node,
        attempt: t.attempt,
        loop: t.loop,
        status: STATUS[t.status],
        ms: t.ms ?? Date.now() - t.startedAt,
        startedAt: new Date(t.startedAt).toISOString(),
        ...(t.error ? { error: t.error } : {}),
        ...(t.message ? { message: t.message } : {}),
        ...usage.get(key(t.node, t.attempt, t.loop)),
      }));

    const handler = async (invocation: NodeInvocation, ctx: { signal: AbortSignal }): Promise<unknown> => {
      const { node, attempt, loop } = invocation;
      const started = Date.now();
      emit({ type: 'node_started', node, attempt, loop });
      const finished = (rest: Pick<NodeTrace, 'status' | 'error' | 'message' | 'llmCalls' | 'costUsd'>) => {
        // After a timeout or a failed sibling the graph has moved on; a late answer is not an event of this run.
        if (ctx.signal.aborted) return;
        emit({ type: 'node_finished', node, attempt, loop, ms: Date.now() - started, startedAt: new Date(started).toISOString(), ...rest });
      };
      try {
        const result = await nodes.invoke(invocation, { callerToken, signal: ctx.signal });
        if (result.usage) usage.set(key(node, attempt, loop), result.usage);
        finished({ status: 'ok', ...result.usage });
        return result.output;
      } catch (e) {
        finished({ status: 'error', error: e instanceof Error ? e.name : 'Error', message: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    };

    const withCost = (trace: NodeTrace[]) => {
      const costUsd = sumCost(trace);
      return { trace, ...(costUsd === undefined ? {} : { costUsd }) };
    };
    const done = runLocal(spec, handler, { input: run.input, userToken: run.userToken, app: run.app, env: run.env, runId: run.runId }).then(
      (result): RunResult => ({ status: 'succeeded', output: result.output, ...withCost(toTrace(result.trace)) }),
      (e: unknown): RunResult => {
        if (e instanceof GraphRunError) {
          // GraphRunError's own message repeats the node and error name; the cause carries what the node said.
          const message = e.cause instanceof Error ? e.cause.message : e.message;
          return { status: 'failed', error: { name: e.error, message, node: e.node }, ...withCost(toTrace(e.trace)) };
        }
        return { status: 'failed', error: { name: e instanceof Error ? e.name : 'Error', message: e instanceof Error ? e.message : String(e) }, trace: [] };
      },
    );
    return { done };
  }
}
