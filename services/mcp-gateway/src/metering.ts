// One record per tool call (contract §7). Monitoring reads these lines to list "personal agent" calls.
import { CALLER_HEADER, type McpCallRecord } from '@kelay/contracts';
import { signCallerToken } from '@kelay/tokens';

export type { McpCallRecord };

export type MeterSink = (record: McpCallRecord) => void;

export const stdoutMeter: MeterSink = (record) => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};

export interface ControlApiMeterOptions {
  /** CONTROL_API_URL */
  controlApiUrl: string;
  /** KELAY_CALLER_SECRET */
  callerSecret: string;
  fetch?: typeof fetch;
  /** Send once this many records are waiting. @default 50 */
  maxBatch?: number;
  /** Send at most this long after the first waiting record. @default 2000 */
  flushMs?: number;
  /** Records kept while the control API is unreachable; older ones are dropped beyond it. @default 5000 */
  maxBuffered?: number;
  onError?: (error: Error) => void;
}

export interface ControlApiMeter {
  sink: MeterSink;
  /** Sends what is waiting; resolves when the request has finished, whatever its outcome. */
  flush(): Promise<void>;
}

const INGEST_LIMIT = 500;

/**
 * Posts call records to the control API (`POST /internal/v1/mcp-calls`) in batches. The sink only
 * appends to a buffer, so a slow or failing control API never delays a tool call; a failed batch is
 * put back and sent again after `flushMs`.
 */
export function createControlApiMeter(opts: ControlApiMeterOptions): ControlApiMeter {
  const url = `${opts.controlApiUrl.replace(/\/+$/, '')}/internal/v1/mcp-calls`;
  const doFetch = opts.fetch ?? fetch;
  const maxBatch = Math.min(opts.maxBatch ?? 50, INGEST_LIMIT);
  const maxBuffered = opts.maxBuffered ?? 5000;
  let buffer: McpCallRecord[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending: Promise<void> | undefined;

  async function send(): Promise<void> {
    const batch = buffer.splice(0, INGEST_LIMIT);
    if (batch.length === 0) return;
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [CALLER_HEADER]: await signCallerToken({ kind: 'service', svc: 'mcp-gateway' }, opts.callerSecret),
        },
        body: JSON.stringify({ calls: batch }),
      });
      // A 4xx will not succeed on retry, so those records are dropped rather than resent forever.
      if (res.status >= 500) throw new Error(`control API answered HTTP ${res.status}`);
      if (!res.ok) opts.onError?.(new Error(`control API rejected ${batch.length} call records with HTTP ${res.status}`));
    } catch (e) {
      buffer = [...batch, ...buffer].slice(-maxBuffered);
      opts.onError?.(e as Error);
    }
  }

  function schedule(): void {
    if (timer) return;
    timer = setTimeout(() => void flush(), opts.flushMs ?? 2000);
    timer.unref?.();
  }

  function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    sending ??= send().finally(() => {
      sending = undefined;
      // Records that arrived during the request, or a batch that was put back.
      if (buffer.length > 0) schedule();
    });
    return sending;
  }

  return {
    sink(record) {
      buffer.push({ ...record, at: record.at ?? new Date().toISOString() });
      if (buffer.length > maxBuffered) buffer.shift();
      if (buffer.length >= maxBatch) void flush();
      else schedule();
    },
    flush,
  };
}

/** Feeds every record to each sink. */
export const teeMeter =
  (...sinks: MeterSink[]): MeterSink =>
  (record) => {
    for (const sink of sinks) sink(record);
  };
