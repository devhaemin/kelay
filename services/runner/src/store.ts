// Runs live in this process's memory: the orchestrator is one process, and the lasting record of a
// run is the row the control API keeps (contract §9). Finished runs stay readable for a while.
import type { NodeInvocation } from '@kelay/contracts';
import type { NodeTrace, RunError } from './driver.ts';

/** Who started the run, as Monitoring names it: the app's own screen, a member's assistant, or another app. */
export interface RunCaller {
  kind: 'user' | 'agent' | 'app';
  /** MCP client id for `agent`, source app slug for `app`. */
  id?: string;
  name?: string;
}

export type RunEvent = { seq: number; at: string } & (
  | { type: 'run_started'; runId: string; app: string; graph: string }
  | { type: 'node_started'; node: string; attempt: number; loop: number }
  | ({ type: 'node_finished' } & NodeTrace)
  | { type: 'run_finished'; status: 'succeeded' | 'failed'; ms: number; output?: unknown; error?: RunError }
);

export type RunEventBody = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, 'seq' | 'at'> : never) : never;

export interface Run {
  id: string;
  app: string;
  env: NodeInvocation['env'];
  graph: string;
  /** What Monitoring lists the run as: the action that started it, or the graph name. */
  action: string;
  /** The user the run acts as. */
  sub: string;
  caller: RunCaller;
  status: 'running' | 'succeeded' | 'failed';
  input: unknown;
  output?: unknown;
  error?: RunError;
  trace: NodeTrace[];
  costUsd?: number;
  startedAt: Date;
  finishedAt?: Date;
  ms?: number;
  events: RunEvent[];
}

export interface RunStore {
  create(run: Omit<Run, 'status' | 'trace' | 'events'>): Run;
  get(id: string): Run | undefined;
  remove(id: string): void;
  /** Runs of this user that have not finished, across every app. */
  running(sub: string): number;
  emit(run: Run, event: RunEventBody): void;
  /** Calls `listener` for every later event of the run. Returns the unsubscribe function. */
  subscribe(id: string, listener: (event: RunEvent) => void): () => void;
  /** Resolves when the run has finished, or after `ms`, whichever comes first. */
  wait(id: string, ms: number): Promise<void>;
}

export interface RunStoreOptions {
  now?: () => Date;
  /** How long a finished run stays readable. @default 3_600_000 */
  retainMs?: number;
  /** Finished runs beyond this many are dropped, oldest first. @default 2000 */
  maxFinished?: number;
}

export function createRunStore(opts: RunStoreOptions = {}): RunStore {
  const now = opts.now ?? (() => new Date());
  const retainMs = opts.retainMs ?? 60 * 60 * 1000;
  const maxFinished = opts.maxFinished ?? 2000;
  const runs = new Map<string, Run>();
  const listeners = new Map<string, Set<(event: RunEvent) => void>>();

  // Insertion order is start order, so the first finished runs found are the oldest.
  function prune(): void {
    const cutoff = now().getTime() - retainMs;
    let finished = 0;
    for (const run of runs.values()) if (run.status !== 'running') finished++;
    for (const run of runs.values()) {
      if (run.status === 'running') continue;
      if (finished <= maxFinished && (run.finishedAt?.getTime() ?? 0) >= cutoff) continue;
      runs.delete(run.id);
      finished--;
    }
  }

  return {
    create(init) {
      prune();
      const run: Run = { ...init, status: 'running', trace: [], events: [] };
      runs.set(run.id, run);
      return run;
    },
    get: (id) => runs.get(id),
    remove(id) {
      runs.delete(id);
      listeners.delete(id);
    },
    running(sub) {
      let n = 0;
      for (const run of runs.values()) if (run.status === 'running' && run.sub === sub) n++;
      return n;
    },
    emit(run, body) {
      const event = { ...body, seq: run.events.length + 1, at: now().toISOString() } as RunEvent;
      run.events.push(event);
      for (const listener of listeners.get(run.id) ?? []) listener(event);
      if (event.type === 'run_finished') listeners.delete(run.id);
    },
    subscribe(id, listener) {
      const set = listeners.get(id) ?? new Set();
      listeners.set(id, set);
      set.add(listener);
      return () => set.delete(listener);
    },
    wait(id, ms) {
      const run = runs.get(id);
      if (!run || run.status !== 'running' || ms <= 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        };
        const timer = setTimeout(finish, ms);
        const unsubscribe = this.subscribe(id, (event) => {
          if (event.type === 'run_finished') finish();
        });
      });
    },
  };
}
