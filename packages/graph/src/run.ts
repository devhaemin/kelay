// In-process graph executor for dev and tests. Same semantics as the compiled state machine (see compileToAsl).
import type { GraphNode, GraphSpec, NodeInvocation } from '@kelay/contracts';
import { INVALID_REVIEW_ERROR } from './compile.ts';
import { retryDelaySeconds, retryPolicy } from './retry.ts';
import { validateGraph } from './validate.ts';

export type NodeHandler = (invocation: NodeInvocation, ctx: { signal: AbortSignal }) => unknown;

export interface RunOptions {
  input: unknown;
  userToken: string;
  app: string;
  env: NodeInvocation['env'];
  runId?: string;
}

export interface TraceEntry {
  node: string;
  attempt: number;
  loop: number;
  input: unknown;
  status: 'running' | 'ok' | 'error' | 'timeout';
  output?: unknown;
  /** Error name as Step Functions reports it, e.g. `States.Timeout`. */
  error?: string;
  message?: string;
  startedAt: number;
  ms?: number;
}

export interface RunResult {
  runId: string;
  output: unknown;
  trace: TraceEntry[];
}

export class GraphRunError extends Error {
  readonly node: string;
  readonly error: string;
  readonly trace: TraceEntry[];
  constructor(node: string, error: string, message: string, trace: TraceEntry[], cause?: unknown) {
    super(`node ${node} failed with ${error}: ${message}`, cause === undefined ? undefined : { cause });
    this.name = 'GraphRunError';
    this.node = node;
    this.error = error;
    this.trace = trace;
  }
}

class NodeTimeout extends Error {
  constructor(seconds: number) {
    super(`timed out after ${seconds}s`);
    this.name = 'States.Timeout';
  }
}

/** Step Functions passes JSON between states; round-tripping keeps local runs honest about that. */
const asJson = (v: unknown): unknown => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runLocal(
  spec: GraphSpec,
  handlers: Record<string, NodeHandler> | NodeHandler,
  opts: RunOptions,
): Promise<RunResult> {
  const g = validateGraph(spec);
  if (typeof handlers !== 'function') {
    const missing = Object.keys(g.nodes).filter((n) => typeof handlers[n] !== 'function');
    if (missing.length > 0) throw new TypeError(`runLocal: no handler for node(s) ${missing.join(', ')}`);
  }
  const handlerFor = (n: string): NodeHandler => (typeof handlers === 'function' ? handlers : handlers[n]!);
  const runId = opts.runId ?? crypto.randomUUID();
  const trace: TraceEntry[] = [];

  const invoke = async (name: string, node: GraphNode, input: unknown, loop: number, group?: AbortSignal) => {
    const policy = retryPolicy(node);
    for (let attempt = 1; ; attempt++) {
      const entry: TraceEntry = { node: name, attempt, loop, input, status: 'running', startedAt: Date.now() };
      trace.push(entry);
      const attemptAbort = new AbortController();
      const signal = group ? AbortSignal.any([group, attemptAbort.signal]) : attemptAbort.signal;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const call = Promise.resolve().then(() =>
          handlerFor(name)(
            { runId, app: opts.app, env: opts.env, graph: g.name, node: name, attempt, loop, input: asJson(input), userToken: opts.userToken },
            { signal },
          ),
        );
        const seconds = node.timeoutSeconds;
        const output = asJson(
          await (seconds === undefined
            ? call
            : Promise.race([call, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new NodeTimeout(seconds)), seconds * 1000)))])),
        );
        Object.assign(entry, { status: 'ok', output, ms: Date.now() - entry.startedAt });
        return output;
      } catch (e) {
        attemptAbort.abort();
        const timeout = e instanceof NodeTimeout;
        const error = timeout ? 'States.Timeout' : e instanceof Error ? e.name : 'Error';
        const message = e instanceof Error ? e.message : String(e);
        Object.assign(entry, { status: timeout ? 'timeout' : 'error', error, message, ms: Date.now() - entry.startedAt });
        const retry = policy !== undefined && attempt <= policy.maxAttempts && !group?.aborted;
        if (retry) await sleep(retryDelaySeconds(policy, attempt) * 1000);
        // A failed sibling branch fails the whole Parallel state, as in Step Functions.
        if (!retry || group?.aborted) throw new GraphRunError(name, error, message, trace, e);
      } finally {
        clearTimeout(timer);
      }
    }
  };

  const rejects = new Map<string, number>();
  let loop = 0;
  let name = g.start;
  let data = asJson(opts.input);
  for (;;) {
    const node = g.nodes[name]!;
    const output = await invoke(name, node, data, loop);
    if (node.review) {
      const approved = (output as { approved?: unknown } | null)?.approved;
      if (typeof approved !== 'boolean') {
        throw new GraphRunError(name, INVALID_REVIEW_ERROR, 'review output must contain a boolean "approved"', trace);
      }
      const used = rejects.get(name) ?? 0;
      if (!approved && used < node.review.maxLoops) {
        rejects.set(name, used + 1);
        loop++;
        name = node.review.onReject;
        data = output;
        continue;
      }
    }
    if (node.next === undefined) return { runId, output, trace };
    if (typeof node.next === 'string') {
      name = node.next;
      data = output;
      continue;
    }
    const branches = node.next;
    const group = new AbortController();
    try {
      data = await Promise.all(branches.map((b) => invoke(b, g.nodes[b]!, output, loop, group.signal)));
    } catch (e) {
      group.abort();
      throw e;
    }
    name = g.nodes[branches[0]!]!.next as string;
  }
}
