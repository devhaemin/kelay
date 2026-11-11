// Tells the control API which assistant a person connected to which app. The control API owns the
// `consents` table: the builder's Agent tab and the person's connect screen list and revoke from it.
import { CALLER_HEADER } from '@kelay/contracts';
import { signCallerToken } from '@kelay/tokens';

export interface ConsentRecord {
  userId: string;
  app: string;
  /** The MCP client id: the URL of its Client ID Metadata Document. */
  clientId: string;
  clientName: string;
  scopes: string[];
}

export interface ConsentRecorder {
  /** Creates the consent or updates the active one. Rejects when the control API did not store it. */
  record(consent: ConsentRecord): Promise<void>;
}

export interface ControlApiConsentsOptions {
  /** CONTROL_API_URL. */
  controlApiUrl: string;
  /** KELAY_CALLER_SECRET: signs the `service` caller token (contract §4). */
  callerSecret: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** @default 5000 */
  timeoutMs?: number;
}

export function controlApiConsents(opts: ControlApiConsentsOptions): ConsentRecorder {
  const url = `${opts.controlApiUrl.replace(/\/+$/, '')}/internal/v1/consents`;
  const send = opts.fetch ?? ((input, init) => fetch(input, init));
  return {
    async record(consent) {
      const res = await send(url, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          [CALLER_HEADER]: await signCallerToken({ kind: 'service', svc: 'identity' }, opts.callerSecret),
        },
        body: JSON.stringify(consent),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      });
      if (!res.ok) throw new Error(`control API answered ${res.status} to PUT /internal/v1/consents`);
    },
  };
}
