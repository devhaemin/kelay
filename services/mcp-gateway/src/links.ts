// App-to-app links (docs/infrastructure.md §4.4): one app may call another only over a grant the
// target's owner allowed. The grants live in the control DB; the gateway asks the control API.
import { CALLER_HEADER } from '@kelay/contracts';
import { signCallerToken } from '@kelay/tokens';
import { z } from 'zod';

export type LinkKind = 'MCP' | 'A2A';

export interface AppLinks {
  /** Whether `fromApp` holds a connected grant of this kind to `toApp`. Rejects when that cannot be found out. */
  connected(fromApp: string, toApp: string, kind: LinkKind): Promise<boolean>;
  /** Counts one call on the grant. Never throws into the request. */
  recordCall(fromApp: string, toApp: string, kind: LinkKind): void;
}

/** Without a control API nothing is connected, so every app-to-app call is refused. */
export const noAppLinks: AppLinks = {
  connected: async () => false,
  recordCall: () => {},
};

export interface ControlApiLinksOptions {
  /** CONTROL_API_URL */
  controlApiUrl: string;
  /** KELAY_CALLER_SECRET */
  callerSecret: string;
  fetch?: typeof fetch;
  onError?: (error: Error) => void;
}

const Check = z.object({ connected: z.boolean() });

export function createControlApiLinks(opts: ControlApiLinksOptions): AppLinks {
  const base = opts.controlApiUrl.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const caller = () => signCallerToken({ kind: 'service', svc: 'mcp-gateway' }, opts.callerSecret);

  return {
    async connected(fromApp, toApp, kind) {
      const query = new URLSearchParams({ fromApp, toApp, kind });
      const res = await doFetch(`${base}/internal/v1/grants?${query}`, { headers: { [CALLER_HEADER]: await caller() } });
      // A slug the control API does not accept names no app, so nothing links it.
      if (res.status === 400 || res.status === 404) return false;
      const body = Check.safeParse(await res.json().catch(() => undefined));
      if (!res.ok || !body.success) throw new Error(`control API answered HTTP ${res.status} to a grant check`);
      return body.data.connected;
    },
    recordCall(fromApp, toApp, kind) {
      void (async () => {
        const res = await doFetch(`${base}/internal/v1/grants/calls`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [CALLER_HEADER]: await caller() },
          body: JSON.stringify({ fromApp, toApp, kind, count: 1 }),
        });
        if (!res.ok) throw new Error(`control API answered HTTP ${res.status} to a grant call count`);
      })().catch((e: unknown) => opts.onError?.(e as Error));
    },
  };
}
