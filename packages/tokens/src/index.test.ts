import { describe, expect, it } from 'vitest';
import { audienceForApp } from '@kelay/contracts';
import { TokenError, createDevSigner, signCallerToken, verifyCallerToken, verifyKelayToken } from './index.ts';

const base = { sub: 'u_1', app: 'ticket-board', org: 'orum', role: 'member', plan: 'free', aud: audienceForApp('ticket-board') };

describe('kelay tokens', () => {
  it('signs and verifies a user token', async () => {
    const s = await createDevSigner();
    const t = await s.sign(base);
    const c = await verifyKelayToken(t, { jwks: s.verifier, issuer: s.issuer, app: 'ticket-board' });
    expect(c.role).toBe('member');
  });
  it('rejects a token for another app, another audience, or a missing claim', async () => {
    const s = await createDevSigner();
    const t = await s.sign(base);
    await expect(verifyKelayToken(t, { jwks: s.verifier, issuer: s.issuer, app: 'wiki' })).rejects.toThrow(TokenError);
    await expect(verifyKelayToken(t, { jwks: s.verifier, issuer: s.issuer, audience: 'kelay:app:wiki' })).rejects.toThrow(TokenError);
    const bad = await s.sign({ ...base, role: '' });
    await expect(verifyKelayToken(bad, { jwks: s.verifier, issuer: s.issuer })).rejects.toThrow(/role/);
  });
  it('rejects a token from another signer', async () => {
    const a = await createDevSigner();
    const b = await createDevSigner();
    await expect(verifyKelayToken(await a.sign(base), { jwks: b.verifier, issuer: a.issuer })).rejects.toThrow(TokenError);
  });
  it('round-trips caller tokens and rejects a wrong secret', async () => {
    const secret = 'x'.repeat(32);
    const t = await signCallerToken({ kind: 'service', svc: 'mcp-gateway' }, secret);
    expect((await verifyCallerToken(t, secret)).svc).toBe('mcp-gateway');
    await expect(verifyCallerToken(t, 'y'.repeat(32))).rejects.toThrow(TokenError);
  });
});
