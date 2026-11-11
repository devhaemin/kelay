import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audienceForApp } from '@kelay/contracts';
import { createDevSigner, signCallerToken } from '@kelay/tokens';
import { CONSOLE_APP } from '../src/auth.ts';
import { createHarness, seedApp, type Harness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await seedApp(h, 'owner', 'ticket-board');
});
afterAll(() => h.close());

describe('auth rules', () => {
  it('serves healthz without auth', async () => {
    const res = await h.req('GET', '/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, db: 'ok', deployDriver: 'local', improvementQueue: 'postgres' });
  });

  it('builder routes need a console token with a builder or admin role', async () => {
    expect((await h.req('GET', '/v1/apps')).body.error.code).toBe('unauthenticated');

    const appToken = await h.appUser('ticket-board', 'owner');
    const wrongApp = await h.req('GET', '/v1/apps', { token: appToken });
    expect(wrongApp.status).toBe(401);

    const member = await h.signer.sign({ sub: 'owner', app: CONSOLE_APP, aud: audienceForApp(CONSOLE_APP), org: 'kelay', role: 'member', plan: 'free' });
    const denied = await h.req('GET', '/v1/apps', { token: member });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('denied');

    const wrongAud = await h.signer.sign({ sub: 'owner', app: CONSOLE_APP, aud: 'kelay:app:other', org: 'kelay', role: 'builder', plan: 'free' });
    expect((await h.req('GET', '/v1/apps', { token: wrongAud })).status).toBe(401);

    const admin = await h.builder('owner', 'admin');
    expect((await h.req('GET', '/v1/apps', { token: admin })).status).toBe(200);
  });

  it('rejects tokens from another issuer key', async () => {
    const other = await createDevSigner(h.signer.issuer);
    const forged = await other.sign({ sub: 'owner', app: CONSOLE_APP, aud: audienceForApp(CONSOLE_APP), org: 'kelay', role: 'builder', plan: 'pro' });
    expect((await h.req('GET', '/v1/apps', { token: forged })).status).toBe(401);
  });

  it('scopes builders to apps they own', async () => {
    const stranger = await h.builder('stranger');
    const res = await h.req('GET', '/v1/apps/ticket-board', { token: stranger });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('denied');
    expect((await h.req('GET', '/v1/apps', { token: stranger })).body.apps).toEqual([]);
    expect((await h.req('PATCH', '/v1/apps/ticket-board', { token: stranger, body: { name: 'mine now' } })).status).toBe(403);
    expect((await h.req('GET', '/v1/apps/nope', { token: stranger })).body.error.code).toBe('unknown_app');
  });

  it('end-user routes need an app-scoped token plus the same app runtime caller', async () => {
    const user = await h.appUser('ticket-board', 'u1');
    const body = { text: 'I only want to see my tickets' };

    const noCaller = await h.req('POST', '/v1/apps/ticket-board/feedback', { token: user, body });
    expect(noCaller.status).toBe(403);
    expect(noCaller.body.error.code).toBe('forbidden_caller');

    const otherRuntime = await h.req('POST', '/v1/apps/ticket-board/feedback', { token: user, caller: await h.appCaller('team-wiki'), body });
    expect(otherRuntime.body.error.code).toBe('forbidden_caller');

    const serviceCaller = await h.req('POST', '/v1/apps/ticket-board/feedback', { token: user, caller: await h.service(), body });
    expect(serviceCaller.body.error.code).toBe('forbidden_caller');

    const badSecret = await signCallerToken({ kind: 'app-runtime', app: 'ticket-board', env: 'prod' }, 'z'.repeat(32));
    expect((await h.req('POST', '/v1/apps/ticket-board/feedback', { token: user, caller: badSecret, body })).status).toBe(403);

    const otherAppUser = await h.appUser('team-wiki', 'u1');
    const wrongToken = await h.req('POST', '/v1/apps/ticket-board/feedback', { token: otherAppUser, caller: await h.appCaller('ticket-board'), body });
    expect(wrongToken.status).toBe(401);

    const ok = await h.req('POST', '/v1/apps/ticket-board/feedback', { token: user, caller: await h.appCaller('ticket-board'), body });
    expect(ok.status).toBe(201);
  });

  it('internal routes need a service caller', async () => {
    const builder = await h.builder('owner');
    expect((await h.req('GET', '/internal/v1/apps/ticket-board', { token: builder })).body.error.code).toBe('forbidden_caller');
    const runtime = await h.req('GET', '/internal/v1/apps/ticket-board', { caller: await h.appCaller('ticket-board') });
    expect(runtime.status).toBe(403);
    expect(runtime.body.error.code).toBe('forbidden_caller');
  });

  it('lets a service caller run scheduled work but not builder-only actions', async () => {
    const svc = await h.service('scheduler');
    expect((await h.req('POST', '/v1/apps/ticket-board/tickets/triage', { caller: svc })).status).toBe(200);
    expect((await h.req('GET', '/v1/apps/ticket-board/tickets', { caller: svc })).status).toBe(401);
  });

  it('returns contract-shaped errors for bad input and unknown routes', async () => {
    const token = await h.builder('owner');
    const bad = await h.req('POST', '/v1/apps', { token, body: { slug: 'Bad Slug!', name: '' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_request');
    expect((await h.req('GET', '/v1/nowhere')).status).toBe(404);
  });
});
