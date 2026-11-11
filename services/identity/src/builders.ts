// Who becomes a builder. A builder is a member of the console (`kelay-console`) with the role
// `builder`; the control API owns `app_members` (contract §9), so the membership is created there.
import { CALLER_HEADER } from '@kelay/contracts';
import { signCallerToken } from '@kelay/tokens';

export const CONSOLE_APP = 'kelay-console';

export interface BuilderSignup {
  /** KELAY_BUILDER_ALLOWLIST: the emails that become builders when they sign up. */
  allowlist: string[];
  /** KELAY_OPEN_SIGNUP=true: everyone who signs up becomes a builder. */
  open: boolean;
  /**
   * Whether an allowlisted email counts only once its owner proved it, which a social provider does
   * and an email-and-password sign-up does not. Without this, whoever signs up first with someone
   * else's allowlisted address would get their console.
   */
  requireVerifiedEmail: boolean;
  /** Creates the person's `kelay-console` membership. Rejects when the control API did not store it. */
  enroll(userId: string): Promise<void>;
}

export function mayBecomeBuilder(signup: BuilderSignup, user: { email: string; emailVerified: boolean }): boolean {
  if (signup.open) return true;
  if (signup.requireVerifiedEmail && !user.emailVerified) return false;
  const email = user.email.trim().toLowerCase();
  return signup.allowlist.some((allowed) => allowed.trim().toLowerCase() === email);
}

/** Reads KELAY_BUILDER_ALLOWLIST (comma-separated emails) and KELAY_OPEN_SIGNUP. */
export function builderSignupFromEnv(env: Record<string, string | undefined>): Pick<BuilderSignup, 'allowlist' | 'open'> {
  return {
    allowlist: (env.KELAY_BUILDER_ALLOWLIST ?? '').split(',').map((v) => v.trim()).filter(Boolean),
    open: env.KELAY_OPEN_SIGNUP === 'true',
  };
}

export interface ControlApiBuildersOptions {
  /** CONTROL_API_URL. */
  controlApiUrl: string;
  /** KELAY_CALLER_SECRET: signs the `service` caller token (contract §4). */
  callerSecret: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** @default 5000 */
  timeoutMs?: number;
}

/**
 * `enroll` over the control API's member route. A new builder gets an org of their own, named after
 * their user id: `org` is what separates one team's rows from another's in every app (contract §3).
 */
export function controlApiBuilders(opts: ControlApiBuildersOptions): BuilderSignup['enroll'] {
  const base = opts.controlApiUrl.replace(/\/+$/, '');
  const send = opts.fetch ?? ((input, init) => fetch(input, init));
  return async (userId) => {
    const path = `/internal/v1/apps/${CONSOLE_APP}/members/${encodeURIComponent(userId)}`;
    const res = await send(`${base}${path}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        [CALLER_HEADER]: await signCallerToken({ kind: 'service', svc: 'identity' }, opts.callerSecret),
      },
      body: JSON.stringify({ org: userId, role: 'builder' }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
    if (!res.ok) throw new Error(`control API answered ${res.status} to PUT ${path}`);
  };
}
