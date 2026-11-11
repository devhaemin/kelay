// OAuth resource-server side of the gateway (contract §7): Kelay ID issues the tokens, the gateway verifies them
// and tells unauthenticated clients where to find the authorization server (RFC 9728).
import type { KelayClaims } from '@kelay/contracts';
import { verifyKelayToken, type VerifyOptions } from '@kelay/tokens';

/** Scopes advertised to MCP clients, with the wording used where a client shows them. */
export const SCOPES: Record<string, string> = {
  openid: 'Sign in with your Kelay ID',
  profile: 'See your name and profile picture',
  email: 'See your email address',
  offline_access: 'Stay connected without signing in again',
};

export interface AppUrls {
  /** The MCP endpoint; also the resource identifier tokens must carry as `aud`. */
  resource: string;
  resourceMetadata: string;
  agentCard: string;
  a2a: string;
}

export function appUrls(publicBaseUrl: string, handle: string, app: string): AppUrls {
  const base = publicBaseUrl.replace(/\/+$/, '');
  return {
    resource: `${base}/${handle}/${app}/mcp`,
    resourceMetadata: `${base}/.well-known/oauth-protected-resource/${handle}/${app}/mcp`,
    agentCard: `${base}/${handle}/${app}/.well-known/agent-card.json`,
    a2a: `${base}/${handle}/${app}/a2a`,
  };
}

export function protectedResourceMetadata(urls: AppUrls, issuer: string, app: string) {
  return {
    resource: urls.resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: Object.keys(SCOPES),
    resource_name: `${app} on Kelay`,
  };
}

export type AuthResult =
  | { ok: true; token: string; claims: KelayClaims & { azp: string }; scopes: string[] }
  | { ok: false; reason: 'missing' | 'invalid'; message: string };

const BEARER = /^Bearer[ \t]+(\S+)$/i;

export async function authenticate(
  authorization: string | undefined,
  opts: { jwks: VerifyOptions['jwks']; issuer: string; resource: string; app: string },
): Promise<AuthResult> {
  if (!authorization) return { ok: false, reason: 'missing', message: 'Bearer token required' };
  const token = BEARER.exec(authorization)?.[1];
  if (!token) return { ok: false, reason: 'invalid', message: 'Authorization header must be "Bearer <token>"' };
  let claims: KelayClaims;
  try {
    claims = await verifyKelayToken(token, { jwks: opts.jwks, issuer: opts.issuer, audience: opts.resource, app: opts.app });
  } catch (e) {
    return { ok: false, reason: 'invalid', message: (e as Error).message };
  }
  const { azp } = claims;
  if (typeof azp !== 'string' || azp === '') return { ok: false, reason: 'invalid', message: 'token has no client (azp)' };
  const scope = (claims as unknown as { scope?: unknown }).scope;
  const scopes = typeof scope === 'string' ? scope.split(' ').filter(Boolean) : [];
  return { ok: true, token, claims: { ...claims, azp }, scopes };
}

const quoted = (value: string): string => `"${value.replaceAll(/[\\"]/g, '\\$&').replaceAll(/[^\x20-\x7e]/g, ' ')}"`;

/**
 * RFC 6750 §3: a request without credentials gets a bare challenge; a rejected token adds `error="invalid_token"`.
 * `resource_metadata` (RFC 9728 §5.1) is what lets an MCP client discover Kelay ID.
 */
export function challengeHeader(resourceMetadataUrl: string, failure: Extract<AuthResult, { ok: false }>): string {
  const params = [`resource_metadata=${quoted(resourceMetadataUrl)}`];
  if (failure.reason === 'invalid') params.push('error="invalid_token"', `error_description=${quoted(failure.message)}`);
  return `Bearer ${params.join(', ')}`;
}
