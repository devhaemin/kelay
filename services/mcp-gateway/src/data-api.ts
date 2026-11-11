// Client for the Data API query endpoint (contract §5). Every call carries the user's own token, so RLS applies,
// plus a service caller token that identifies the gateway.
import { CALLER_HEADER, ErrorCode, type QueryRequest } from '@kelay/contracts';
import { signCallerToken } from '@kelay/tokens';
import { z } from 'zod';

export type DataResult =
  | { ok: true; rows: Record<string, unknown>[]; count: number }
  | { ok: false; code: ErrorCode | 'unreachable'; message: string };

export interface DataApi {
  query(app: string, userToken: string, request: QueryRequest): Promise<DataResult>;
}

const Success = z.object({ rows: z.array(z.record(z.string(), z.unknown())), count: z.number() });
const Failure = z.object({ error: z.object({ code: ErrorCode, message: z.string() }) });

const CALLER_TTL_SECONDS = 300;
const CALLER_REFRESH_MS = 60_000;

export interface DataApiOptions {
  baseUrl: string;
  callerSecret: string;
  fetch: typeof fetch;
  now: () => number;
}

export function createDataApi(opts: DataApiOptions): DataApi {
  const base = opts.baseUrl.replace(/\/+$/, '');
  let caller: { token: string; expiresAt: number } | undefined;

  async function callerToken(): Promise<string> {
    const now = opts.now();
    if (!caller || caller.expiresAt - now < CALLER_REFRESH_MS) {
      const token = await signCallerToken({ kind: 'service', svc: 'mcp-gateway' }, opts.callerSecret, CALLER_TTL_SECONDS);
      caller = { token, expiresAt: now + CALLER_TTL_SECONDS * 1000 };
    }
    return caller.token;
  }

  return {
    async query(app, userToken, request) {
      let res: Response;
      try {
        res = await opts.fetch(`${base}/v1/apps/${encodeURIComponent(app)}/query`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${userToken}`,
            [CALLER_HEADER]: await callerToken(),
            'content-type': 'application/json',
          },
          body: JSON.stringify(request),
        });
      } catch (e) {
        return { ok: false, code: 'unreachable', message: (e as Error).message };
      }
      const body: unknown = await res.json().catch(() => undefined);
      if (res.ok) {
        const parsed = Success.safeParse(body);
        return parsed.success
          ? { ok: true, ...parsed.data }
          : { ok: false, code: 'internal', message: 'Data API returned an unexpected body' };
      }
      const failure = Failure.safeParse(body);
      return failure.success
        ? { ok: false, ...failure.data.error }
        : { ok: false, code: 'internal', message: `Data API answered HTTP ${res.status}` };
    },
  };
}
