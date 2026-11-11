// What the orchestrator asks of an execution backend. `local` runs the graph in this process with
// @kelay/graph; `sfn` hands it to the app's Step Functions state machine.
import type { NodeInvocation } from '@kelay/contracts';

export type NodeStatus = 'ok' | 'error' | 'timeout' | 'aborted';

/** One invocation of one node. A retried node has one entry per attempt. */
export interface NodeTrace {
  node: string;
  /** 1 on the first try. Absent when the backend does not report it. */
  attempt?: number;
  /** Review rejections before this invocation. Absent when the backend does not report it. */
  loop?: number;
  status: NodeStatus;
  ms: number;
  startedAt: string;
  /** Error name as Step Functions reports it, e.g. `States.Timeout`. */
  error?: string;
  message?: string;
  /** Model calls the node made, when the node runtime reported them. */
  llmCalls?: number;
  /** What those calls cost, when the LLM gateway priced them. */
  costUsd?: number;
}

export interface RunError {
  name: string;
  message: string;
  node?: string;
}

export interface RunStart {
  runId: string;
  app: string;
  env: NodeInvocation['env'];
  graph: string;
  input: unknown;
  /** The user's Kelay ID token; every node acts as that user. */
  userToken: string;
}

export type DriverEvent =
  | { type: 'node_started'; node: string; attempt: number; loop: number }
  | ({ type: 'node_finished' } & NodeTrace);

export interface RunResult {
  status: 'succeeded' | 'failed';
  output?: unknown;
  error?: RunError;
  trace: NodeTrace[];
  /** Model cost of the whole run, when known. */
  costUsd?: number;
}

export interface StartedRun {
  /** Settles when the run is over. A failed run resolves with `status: 'failed'`; it never rejects. */
  done: Promise<RunResult>;
}

export interface RunDriver {
  readonly name: string;
  /** Rejects with UnknownGraphError when the app has no such graph; otherwise the run has started. */
  start(run: RunStart, emit: (event: DriverEvent) => void): Promise<StartedRun>;
}

export class UnknownGraphError extends Error {
  constructor(app: string, graph: string, env: string) {
    super(`app ${app} has no agent graph "${graph}" in ${env}`);
    this.name = 'UnknownGraphError';
  }
}

export const sumCost = (trace: NodeTrace[]): number | undefined => {
  const priced = trace.filter((t) => t.costUsd !== undefined);
  return priced.length === 0 ? undefined : priced.reduce((total, t) => total + t.costUsd!, 0);
};
