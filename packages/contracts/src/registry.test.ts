import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { CALLER_HEADER, type AppRegistryEntry } from './index.ts';
import { RegistryUnavailableError, controlApiRegistrySource, loadAppRegistry, registrySourceFromEnv, staticRegistrySource } from './registry.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/apps.local.json', import.meta.url));
const board = loadAppRegistry(FIXTURE).apps['ticket-board']!;
const callerToken = async () => 'caller-token';

/** A control API that knows ticket-board in prod only, and records what it was asked. */
function fakeControlApi() {
  const calls: { url: string; caller: string | null }[] = [];
  const state = { down: false, entry: board as AppRegistryEntry };
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, caller: new Headers(init.headers).get(CALLER_HEADER) });
    if (state.down) throw new Error('connect ECONNREFUSED');
    const { pathname, searchParams } = new URL(url);
    const env = searchParams.get('env');
    if (pathname === '/internal/v1/apps') return Response.json({ apps: env === 'prod' ? [{ app: 'ticket-board', handle: state.entry.handle }] : [] });
    if (pathname === '/internal/v1/apps/ticket-board' && env === 'prod') return Response.json(state.entry);
    return Response.json({ error: { code: 'unknown_app', message: 'no such app' } }, { status: 404 });
  };
  return { calls, state, fetch };
}

describe('file registry source', () => {
  it('serves the entries of the file for any env', async () => {
    const source = staticRegistrySource(loadAppRegistry(FIXTURE));
    expect(source.kind).toBe('file');
    expect((await source.get('ticket-board'))?.schema.app).toBe('ticket-board');
    expect(await source.get('ticket-board', 'dev')).toBe(await source.get('ticket-board', 'prod'));
    expect(await source.get('nope')).toBeUndefined();
    expect(await source.get('constructor')).toBeUndefined();
    expect(await source.list()).toEqual([{ app: 'ticket-board', handle: board.handle }]);
  });
});

describe('control API registry source', () => {
  it('asks the control API as a service caller and caches the answer', async () => {
    const api = fakeControlApi();
    const source = controlApiRegistrySource({ controlApiUrl: 'http://control.internal:4003/', callerToken, fetch: api.fetch });
    expect(source.kind).toBe('control-api');
    expect(await source.get('ticket-board')).toEqual(board);
    expect(await source.get('ticket-board', 'prod')).toEqual(board);
    expect(api.calls).toEqual([{ url: 'http://control.internal:4003/internal/v1/apps/ticket-board?env=prod', caller: 'caller-token' }]);
  });

  it('keeps dev and prod apart, and caches "no such app"', async () => {
    const api = fakeControlApi();
    const source = controlApiRegistrySource({ controlApiUrl: 'http://control.internal:4003', callerToken, fetch: api.fetch });
    expect(await source.get('ticket-board', 'dev')).toBeUndefined();
    expect(await source.get('ticket-board', 'dev')).toBeUndefined();
    expect(await source.get('ticket-board', 'prod')).toEqual(board);
    expect(api.calls.map((c) => c.url)).toEqual([
      'http://control.internal:4003/internal/v1/apps/ticket-board?env=dev',
      'http://control.internal:4003/internal/v1/apps/ticket-board?env=prod',
    ]);
  });

  it('never sends a name that is not a slug', async () => {
    const api = fakeControlApi();
    const source = controlApiRegistrySource({ controlApiUrl: 'http://control.internal:4003', callerToken, fetch: api.fetch });
    expect(await source.get('../consents')).toBeUndefined();
    expect(await source.get('prod:ticket-board')).toBeUndefined();
    expect(api.calls).toHaveLength(0);
  });

  it('asks again once the TTL has passed', async () => {
    const api = fakeControlApi();
    const source = controlApiRegistrySource({ controlApiUrl: 'http://control.internal:4003', callerToken, fetch: api.fetch, ttlMs: 40 });
    await source.get('ticket-board');
    await source.get('ticket-board');
    expect(api.calls).toHaveLength(1);
    api.state.entry = { ...board, handle: 'moved' };
    await sleep(60);
    expect((await source.get('ticket-board'))?.handle).toBe('moved');
    expect(api.calls).toHaveLength(2);
  });

  it('serves the last answer while the control API is down, and fails when it has none', async () => {
    const api = fakeControlApi();
    const source = controlApiRegistrySource({ controlApiUrl: 'http://control.internal:4003', callerToken, fetch: api.fetch, ttlMs: 40 });
    await source.get('ticket-board');
    await source.list();
    api.state.down = true;
    await sleep(60);
    expect(await source.get('ticket-board')).toEqual(board);
    expect(await source.list()).toEqual([{ app: 'ticket-board', handle: board.handle }]);
    expect(api.calls.length).toBeGreaterThan(2);
    await expect(source.get('wiki')).rejects.toBeInstanceOf(RegistryUnavailableError);
  });

  it('fails on an answer that is neither an entry nor a 404', async () => {
    const source = controlApiRegistrySource({
      controlApiUrl: 'http://control.internal:4003',
      callerToken,
      fetch: async () => Response.json({ error: { code: 'forbidden_caller', message: 'no' } }, { status: 403 }),
    });
    await expect(source.get('ticket-board')).rejects.toThrow(/answered 403/);
    await expect(source.list()).rejects.toThrow(/answered 403/);
  });

  it('lists the apps of an env', async () => {
    const api = fakeControlApi();
    const source = controlApiRegistrySource({ controlApiUrl: 'http://control.internal:4003', callerToken, fetch: api.fetch });
    expect(await source.list()).toEqual([{ app: 'ticket-board', handle: board.handle }]);
    expect(await source.list('dev')).toEqual([]);
  });
});

describe('registrySourceFromEnv', () => {
  it('reads the file by default', async () => {
    const source = registrySourceFromEnv({ KELAY_APPS_FILE: 'apps.local.json' }, { callerToken, resolvePath: () => FIXTURE });
    expect(source.kind).toBe('file');
    expect(await source.get('ticket-board')).toEqual(board);
    expect(registrySourceFromEnv({ KELAY_APPS_SOURCE: 'file', KELAY_APPS_FILE: FIXTURE }, { callerToken }).kind).toBe('file');
  });

  it('uses the control API when asked to, without a file', () => {
    const source = registrySourceFromEnv({ KELAY_APPS_SOURCE: 'control-api', CONTROL_API_URL: 'http://control.internal:4003' }, { callerToken });
    expect(source.kind).toBe('control-api');
  });

  it('names what is missing or wrong', () => {
    expect(() => registrySourceFromEnv({}, { callerToken })).toThrow(/KELAY_APPS_FILE is required/);
    expect(() => registrySourceFromEnv({ KELAY_APPS_SOURCE: 'control-api' }, { callerToken })).toThrow(/CONTROL_API_URL is required/);
    expect(() => registrySourceFromEnv({ KELAY_APPS_SOURCE: 'db' }, { callerToken })).toThrow(/file or control-api/);
    expect(() =>
      registrySourceFromEnv({ KELAY_APPS_SOURCE: 'control-api', CONTROL_API_URL: 'http://c', KELAY_APPS_TTL_SECONDS: '0' }, { callerToken }),
    ).toThrow(/KELAY_APPS_TTL_SECONDS/);
  });
});
