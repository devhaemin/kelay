// Who may see a dev preview. A preview is loaded by a browser frame, which cannot send the builder's
// Kelay ID token, so the console asks the Builder for a ticket (after the Control API confirmed the
// builder owns the app), puts it in the frame's URL, and the proxy trades it for a cookie on its own
// origin. Tickets and cookies are signed with a key only the Builder has and name one app.
import { createHmac } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

const AUDIENCE = 'kelay:preview';
/** A ticket only has to survive the page load that carries it. */
export const TICKET_TTL_SECONDS = 120;
/** A session lasts a working day; the console's next page load starts a new one. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export const TICKET_PARAM = 'kelay_preview_token';
const SESSION_COOKIE_PREFIX = 'kelay_ps_';
export const sessionCookie = (app: string) => `${SESSION_COOKIE_PREFIX}${app}`;
/** In path mode: the app whose preview the browser is looking at, for requests that name none. */
export const CURRENT_APP_COOKIE = 'kelay_pc';

type Use = 'ticket' | 'session';

export interface PreviewGrant {
  app: string;
  /** The builder the grant was issued to. */
  sub: string;
}

export class PreviewSessions {
  private readonly key: Uint8Array;

  /** `secret` is the Builder's caller secret; the signing key is derived from it and used for nothing else. */
  constructor(secret: string) {
    if (secret.length < 32) throw new Error('the preview signing secret must be at least 32 characters');
    this.key = createHmac('sha256', secret).update('kelay-builder-preview-v1').digest();
  }

  private sign(use: Use, grant: PreviewGrant, ttlSeconds: number): Promise<string> {
    return new SignJWT({ app: grant.app, use }).setProtectedHeader({ alg: 'HS256' }).setSubject(grant.sub).setAudience(AUDIENCE).setIssuedAt().setExpirationTime(`${ttlSeconds}s`).sign(this.key);
  }

  ticket(grant: PreviewGrant, ttlSeconds = TICKET_TTL_SECONDS): Promise<string> {
    return this.sign('ticket', grant, ttlSeconds);
  }

  session(grant: PreviewGrant, ttlSeconds = SESSION_TTL_SECONDS): Promise<string> {
    return this.sign('session', grant, ttlSeconds);
  }

  /** The grant a token carries, or null when it is not a valid `use` token for `app`. */
  async verify(use: Use, app: string, token: string | undefined): Promise<PreviewGrant | null> {
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.key, { audience: AUDIENCE, algorithms: ['HS256'] });
      if (payload.use !== use || payload.app !== app || typeof payload.sub !== 'string') return null;
      return { app, sub: payload.sub };
    } catch {
      return null;
    }
  }
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) cookies.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return cookies;
}

/** The request's cookies without the proxy's own, which the app in the workspace must never see. */
export function withoutPreviewCookies(header: string | undefined): string | undefined {
  const kept = [...parseCookies(header)].filter(([name]) => !name.startsWith(SESSION_COOKIE_PREFIX) && name !== CURRENT_APP_COOKIE);
  return kept.length > 0 ? kept.map(([name, value]) => `${name}=${value}`).join('; ') : undefined;
}
