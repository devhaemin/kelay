// An app built by the Builder works with real data in its dev preview. The builder creates an app,
// the Builder's scripted agent builds it and deploys it to Development, and the preview's own
// /api/kelay route serves the SDK's calls: it trades the browser's Kelay ID session for the person's
// token for that app and adds the caller token the deploy minted. Nothing but the builder's
// membership is seeded, so a person who is not a member is refused.
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { KelayError, createKelayClient } from '@kelay/sdk';
import { BUILDER, CONSOLE_APP, HANDLE, ORG, PASSWORD, TEAM } from '../scripts/lib/data.ts';
import { KelayIdSession } from '../scripts/lib/session.ts';

const { config, users, builderId } = inject('stack');
const APP = `e2e-board-${Math.random().toString(36).slice(2, 8)}`;
const BUILD_TIMEOUT = 240_000;

interface Json {
  status: number;
  body: any;
}

let builder: KelayIdSession;
let builderToken: string;
let previewUrl: string;

async function call(base: string, method: string, path: string, body?: unknown): Promise<Json> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${builderToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}

/** The app's SDK client as a browser of `session` runs it: calls go to the preview's own proxy with the session's cookies. */
function previewClient(session: KelayIdSession | null) {
  const signedInByProxy = () => 'added-on-the-server';
  return createKelayClient({
    dataApiUrl: `${previewUrl}/api/kelay`,
    app: APP,
    getUserToken: signedInByProxy,
    getCallerToken: signedInByProxy,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      // What the template's client really sends is of no use to anyone: the proxy replaces both.
      headers.delete('authorization');
      // Cookies ignore the port, so the browser sends Kelay ID's session cookie to the preview too.
      const cookie = session ? await session.jar.getCookieString(String(input)) : '';
      if (cookie) headers.set('cookie', cookie);
      return fetch(input, { ...init, headers });
    },
  });
}

beforeAll(async () => {
  builder = new KelayIdSession(config.issuer);
  expect(await builder.signIn(BUILDER.email, PASSWORD)).toBe(builderId);
  builderToken = await builder.appToken(CONSOLE_APP);
});

describe('an app built by the Builder', () => {
  it('is built by the scripted agent, deployed to Development and previewed', async () => {
    const created = await call(config.controlApiUrl, 'POST', '/v1/apps', { slug: APP, name: 'E2E Board' });
    expect(created.status).toBe(201);
    expect(created.body.app).toMatchObject({ slug: APP, handle: HANDLE });

    const started = await call(config.builderUrl, 'POST', '/v1/workspaces', { app: APP, prompt: 'A ticket board for my team' });
    expect(started.status).toBe(202);
    expect(started.body.workspace.agent).toEqual({ kind: 'scripted', model: null });

    let events: { type: string; turn: string; status?: string; error?: string | null }[] = [];
    await expect
      .poll(
        async () => {
          events = (await call(config.builderUrl, 'GET', `/v1/workspaces/${APP}/events?format=json`)).body.events;
          return events.find((e) => e.type === 'turn.finished' && e.turn === started.body.turn) ?? null;
        },
        { timeout: BUILD_TIMEOUT, interval: 500 },
      )
      .toMatchObject({ status: 'succeeded', error: null });
    expect(events.find((e) => e.type === 'deploy')).toMatchObject({ ok: true, env: 'dev', version: 'v1' });

    const { workspace } = (await call(config.builderUrl, 'GET', `/v1/workspaces/${APP}`)).body;
    expect(workspace).toMatchObject({ state: 'idle', version: 'v1' });
    previewUrl = workspace.previewUrl;
    expect(previewUrl).toMatch(/^http:\/\/localhost:\d+$/);
  }, BUILD_TIMEOUT + 30_000);

  it('has the builder as its only member, an admin', async () => {
    const { body } = await call(config.controlApiUrl, 'GET', `/v1/apps/${APP}/members`);
    expect(body.members.map((m: { userId: string; org: string; role: string; status: string }) => ({ userId: m.userId, org: m.org, role: m.role, status: m.status }))).toEqual([
      { userId: builderId, org: ORG, role: 'admin', status: 'active' },
    ]);
  });

  it('lets the signed-in builder create a ticket through the preview and list it back', async () => {
    const tickets = previewClient(builder).collection('tickets');
    expect(await tickets.list()).toEqual([]);
    const made = await tickets.create({ title: 'Ship the first version', status: 'todo' });
    expect(made).toMatchObject({ title: 'Ship the first version', status: 'todo', org_id: ORG, owner_id: builderId });
    expect(await tickets.list()).toEqual([made]);
    expect(await tickets.update(String(made.id), { status: 'doing' })).toMatchObject({ id: made.id, status: 'doing' });
  }, 60_000);

  it('asks a visitor without a Kelay ID session to sign in', async () => {
    const attempt = previewClient(null).collection('tickets').list();
    await expect(attempt).rejects.toBeInstanceOf(KelayError);
    await expect(attempt).rejects.toMatchObject({ code: 'unauthenticated', status: 401 });

    const signIn = await fetch(`${previewUrl}/api/kelay/signin`, { redirect: 'manual' });
    expect(signIn.status).toBe(302);
    expect(signIn.headers.get('location')).toBe(`${config.issuer}/login?${new URLSearchParams({ return_to: `${previewUrl}/` })}`);
    // Kelay ID sends a signed-in person straight back to the preview.
    const back = await builder.get(new URL(signIn.headers.get('location')!).pathname + new URL(signIn.headers.get('location')!).search);
    expect(back.status).toBe(303);
    expect(back.headers.get('location')).toBe(`${previewUrl}/`);
  });

  it('denies a signed-in person who is not a member of the app', async () => {
    const junho = new KelayIdSession(config.issuer);
    expect(await junho.signIn(TEAM.find((p) => p.key === 'junho')!.email, PASSWORD)).toBe(users.junho);
    const tickets = previewClient(junho).collection('tickets');
    for (const attempt of [tickets.list(), tickets.create({ title: 'Let me in', status: 'todo' })]) {
      await expect(attempt).rejects.toBeInstanceOf(KelayError);
      await expect(attempt).rejects.toMatchObject({ code: 'denied', status: 403 });
    }
    // Nothing of his reached the app's database.
    expect((await previewClient(builder).collection('tickets').list()).map((t) => t.title)).toEqual(['Ship the first version']);
  });
});
