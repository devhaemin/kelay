// Every finished run becomes one record: a JSON log line, and a row in the control API's `runs`
// table (POST /internal/v1/runs, contract §9), which is what Monitoring reads.
import { CALLER_HEADER } from '@kelay/contracts';
import { signCallerToken } from '@kelay/tokens';
import type { Run } from './store.ts';

/** Body item of `POST /internal/v1/runs`. */
export interface RunRecord {
  app: string;
  env: 'dev' | 'prod';
  action: string;
  status: 'ok' | 'error';
  userId: string;
  args?: string;
  ms: number;
  caller: Run['caller'];
  note?: string;
  costUsd?: number;
  nodes: { node: string; status: string; ms: number; attempt?: number; loop?: number; costUsd?: number }[];
  at: string;
}

export type RunRecorder = (record: RunRecord) => void | Promise<void>;

const ARGS_MAX = 500;
const NOTE_MAX = 1000;
const NODES_MAX = 200;

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function toRecord(run: Run): RunRecord {
  let args: string | undefined;
  try {
    args = run.input == null ? undefined : JSON.stringify(run.input);
  } catch {
    args = undefined;
  }
  const note = run.error ? `${run.error.node ? `${run.error.node}: ` : ''}${run.error.name}: ${run.error.message}` : undefined;
  return {
    app: run.app,
    env: run.env,
    action: run.action,
    status: run.status === 'succeeded' ? 'ok' : 'error',
    userId: run.sub,
    ...(args ? { args: cut(args, ARGS_MAX) } : {}),
    ms: run.ms ?? 0,
    caller: run.caller,
    ...(note ? { note: cut(note, NOTE_MAX) } : {}),
    ...(run.costUsd === undefined ? {} : { costUsd: run.costUsd }),
    nodes: run.trace.slice(0, NODES_MAX).map((t) => ({
      node: t.node,
      status: t.status,
      ms: Math.round(t.ms),
      ...(t.attempt === undefined ? {} : { attempt: t.attempt }),
      ...(t.loop === undefined ? {} : { loop: t.loop }),
      ...(t.costUsd === undefined ? {} : { costUsd: t.costUsd }),
    })),
    at: run.startedAt.toISOString(),
  };
}

export const stdoutRecorder: RunRecorder = (record) => {
  process.stdout.write(`${JSON.stringify({ type: 'run', ...record })}\n`);
};

export interface ControlApiRecorderOptions {
  /** CONTROL_API_URL */
  controlApiUrl: string;
  /** KELAY_CALLER_SECRET */
  callerSecret: string;
  fetch?: typeof fetch;
  /** Tries per record, the first included. @default 3 */
  attempts?: number;
  /** Wait before the second try; doubles for each later one. @default 500 */
  retryMs?: number;
}

/** Posts one record per run. A 4xx is final; a 5xx or an unreachable control API is tried again, then reported. */
export function createControlApiRecorder(opts: ControlApiRecorderOptions): RunRecorder {
  const url = `${opts.controlApiUrl.replace(/\/+$/, '')}/internal/v1/runs`;
  const doFetch = opts.fetch ?? fetch;
  const attempts = opts.attempts ?? 3;
  return async (record) => {
    let failure: Error | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, (opts.retryMs ?? 500) * 2 ** (attempt - 2)));
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [CALLER_HEADER]: await signCallerToken({ kind: 'service', svc: 'runner' }, opts.callerSecret) },
          body: JSON.stringify({ runs: [record] }),
        });
        if (res.ok) return;
        failure = new Error(`control API answered HTTP ${res.status} to a run record`);
        if (res.status < 500) break;
      } catch (e) {
        failure = e as Error;
      }
    }
    throw failure ?? new Error('run record was not sent');
  };
}

/** Feeds every record to each recorder; one failing does not stop the others. */
export const teeRecorder =
  (...recorders: RunRecorder[]): RunRecorder =>
  async (record) => {
    const results = await Promise.allSettled(recorders.map(async (r) => r(record)));
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw (failed as PromiseRejectedResult).reason;
  };
