// Kelay ID token helpers (contract §4). Services verify user tokens against the Kelay ID JWKS
// and caller tokens with the shared HS256 secret. Dev signers exist for tests and local runs only.
import {
  SignJWT,
  createLocalJWKSet,
  createRemoteJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from 'jose';
import type { CallerClaims, KelayClaims } from '@kelay/contracts';

export type { CallerClaims, KelayClaims };

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenError';
  }
}

export function remoteJwks(url: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(url));
}

export function localJwks(jwks: JSONWebKeySet): JWTVerifyGetKey {
  return createLocalJWKSet(jwks);
}

export interface VerifyOptions {
  jwks: JWTVerifyGetKey;
  issuer: string;
  /** When set, `aud` must contain one of these values. */
  audience?: string | string[];
  /** When set, the `app` claim must equal it. */
  app?: string;
}

const REQUIRED = ['sub', 'app', 'org', 'role', 'plan'] as const;

export async function verifyKelayToken(token: string, opts: VerifyOptions): Promise<KelayClaims> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, opts.jwks, {
      issuer: opts.issuer,
      ...(opts.audience ? { audience: opts.audience } : {}),
    }));
  } catch (e) {
    throw new TokenError(`invalid token: ${(e as Error).message}`);
  }
  for (const k of REQUIRED) {
    if (typeof payload[k] !== 'string' || payload[k] === '') throw new TokenError(`missing claim: ${k}`);
  }
  if (opts.app && payload.app !== opts.app) throw new TokenError('token is for another app');
  return payload as unknown as KelayClaims;
}

export interface DevSigner {
  issuer: string;
  jwks: JSONWebKeySet;
  verifier: JWTVerifyGetKey;
  sign(claims: Omit<KelayClaims, 'iss' | 'iat' | 'exp'> & { exp?: number }, ttlSeconds?: number): Promise<string>;
}

/** Ed25519 signer with an in-memory key. Matches better-auth's default JWT algorithm (EdDSA). */
export async function createDevSigner(issuer = 'http://localhost:4001'): Promise<DevSigner> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'dev', alg: 'EdDSA', use: 'sig' };
  const jwks: JSONWebKeySet = { keys: [jwk] };
  return {
    issuer,
    jwks,
    verifier: createLocalJWKSet(jwks),
    async sign(claims, ttlSeconds = 600) {
      const { aud, sub, exp, ...rest } = claims;
      const jwt = new SignJWT({ ...rest })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'dev' })
        .setIssuer(issuer)
        .setSubject(sub)
        .setAudience(aud)
        .setIssuedAt();
      return exp ? jwt.setExpirationTime(exp).sign(privateKey) : jwt.setExpirationTime(`${ttlSeconds}s`).sign(privateKey);
    },
  };
}

const enc = new TextEncoder();

export async function signCallerToken(claims: CallerClaims, secret: string, ttlSeconds = 300): Promise<string> {
  if (secret.length < 32) throw new TokenError('caller secret must be at least 32 characters');
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('kelay:caller')
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(enc.encode(secret));
}

export async function verifyCallerToken(token: string, secret: string): Promise<CallerClaims> {
  try {
    const { payload } = await jwtVerify(token, enc.encode(secret), { issuer: 'kelay:caller', algorithms: ['HS256'] });
    if (payload.kind !== 'app-runtime' && payload.kind !== 'service') throw new Error('bad kind');
    return payload as unknown as CallerClaims;
  } catch (e) {
    throw new TokenError(`invalid caller token: ${(e as Error).message}`);
  }
}
