import { describe, expect, it, vi } from 'vitest';
import { createHttpApi } from './api/http';
import { mergeEvents, threadFromEvents, turnsOf, type BuilderEvent } from './builder';

const scripted = { kind: 'scripted' as const, model: null };
let id = 0;
const event = (turn: string, body: Record<string, unknown>): BuilderEvent => ({ id: ++id, at: `2026-11-12T00:00:${String(id).padStart(2, '0')}.000Z`, app: 'team-board', turn, ...body }) as BuilderEvent;

const build: BuilderEvent[] = [
  event('t1', { type: 'turn.started', kind: 'build', prompt: 'A ticket board', context: null, agent: scripted }),
  event('t1', { type: 'step', key: 'workspace', text: 'Creating the workspace', status: 'running' }),
  event('t1', { type: 'step', key: 'workspace', text: 'Creating the workspace', status: 'done' }),
  event('t1', { type: 'step', key: 'agent-1', text: 'Generated the board screen', status: 'running' }),
  event('t1', { type: 'file', path: 'app/page.tsx', change: 'modified' }),
  event('t1', { type: 'assistant.text', text: 'I built a **Ticket Board**.' }),
  event('t1', { type: 'step', key: 'agent-1', text: 'Generated the board screen', status: 'done' }),
  event('t1', { type: 'step', key: 'deploy', text: 'Deploying to Development', status: 'running' }),
  event('t1', { type: 'deploy', ok: true, env: 'dev', version: 'v1', versionId: 'x', error: null }),
  event('t1', { type: 'step', key: 'deploy', text: 'Deploying to Development', status: 'done' }),
  event('t1', { type: 'preview', url: 'http://localhost:4321' }),
  event('t1', { type: 'turn.finished', status: 'succeeded', error: null }),
];

describe('Builder events in the console', () => {
  it('folds a turn’s events into steps, texts and its outcome', () => {
    const [turn] = turnsOf(build);
    expect(turn).toMatchObject({ kind: 'build', status: 'succeeded', previewUrl: 'http://localhost:4321', version: 'v1', agent: scripted });
    expect(turn!.steps).toEqual([
      { key: 'workspace', text: 'Creating the workspace', status: 'done' },
      { key: 'agent-1', text: 'Generated the board screen', status: 'done' },
      { key: 'deploy', text: 'Deploying to Development', status: 'done' },
    ]);
    expect(turnsOf(build.slice(0, 4))[0]).toMatchObject({ status: 'running', steps: [{ status: 'done' }, { status: 'running' }] });
  });

  it('builds the chat thread, and says which agent answered', () => {
    expect(threadFromEvents(build)).toEqual([
      { id: 't1-request', role: 'user', author: null, parts: [{ kind: 'text', text: 'A ticket board' }] },
      {
        id: 't1-reply',
        role: 'agent',
        author: 'Builder · scripted demo',
        parts: [
          { kind: 'step', text: 'Creating the workspace', done: true },
          { kind: 'step', text: 'Generated the board screen', done: true },
          { kind: 'text', text: 'I built a **Ticket Board**.' },
          { kind: 'step', text: 'Deploying to Development', done: true },
        ],
      },
    ]);
  });

  it('shows a turn in progress, a failed one, and an improvement run', () => {
    const failing = [
      event('t2', { type: 'turn.started', kind: 'message', prompt: 'Add labels', context: 'Screen', agent: { kind: 'claude', model: 'claude-opus-5-5' } }),
      event('t2', { type: 'step', key: 'check', text: 'Checking data and access rules', status: 'running' }),
    ];
    expect(threadFromEvents(failing.slice(0, 1))[1]).toMatchObject({ author: 'Builder', parts: [{ kind: 'step', text: 'Working', done: false }] });
    expect(threadFromEvents(failing)[1]!.parts).toEqual([{ kind: 'step', text: 'Checking data and access rules', done: false }]);

    const failed = [...failing, event('t2', { type: 'step', key: 'check', text: 'Checking data and access rules', status: 'failed' }), event('t2', { type: 'turn.finished', status: 'failed', error: 'Nothing was deployed.' })];
    expect(threadFromEvents(failed)[1]!.parts).toEqual([{ kind: 'text', text: '_Stopped at: Checking data and access rules_' }, { kind: 'text', text: 'Nothing was deployed.' }]);

    const improvement = [event('t3', { type: 'turn.started', kind: 'improvement', prompt: 'Let people set a priority\n\nThree asked.', context: null, agent: scripted })];
    expect(threadFromEvents(improvement)[0]).toMatchObject({ role: 'agent', author: 'Self-Improvement Agent', parts: [{ text: 'Approved proposal: **Let people set a priority**' }] });
  });

  it('merges replayed events without repeating them', () => {
    expect(mergeEvents(build.slice(0, 5), build.slice(3, 8))).toEqual(build.slice(0, 8));
    const known = build.slice(0, 5);
    expect(mergeEvents(known, build.slice(0, 3))).toBe(known);
  });
});

describe('ConsoleApi over the Control API and the Builder', () => {
  function apis(builderRoutes: Record<string, () => { status?: number; json: unknown }>) {
    const calls: { url: string; method: string; auth: string | null; body: unknown }[] = [];
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      calls.push({ url: url.toString(), method, auth: new Headers(init?.headers).get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const route = url.host === 'builder.test' ? builderRoutes[`${method} ${url.pathname}`] : undefined;
      const res = route ? route() : { status: 404, json: { error: { code: 'not_found', message: 'This app has no Builder workspace yet.' } } };
      return new Response(JSON.stringify(res.json), { status: res.status ?? 200, headers: { 'content-type': 'application/json' } });
    });
    return { api: createHttpApi({ baseUrl: 'http://control.test', builderUrl: 'http://builder.test', token: 'builder-token', fetch }), calls };
  }
  const workspace = { app: 'team-board', state: 'idle', driver: 'local', agent: scripted, previewUrl: 'http://localhost:4321', version: 'v1', lastEventId: build.length };

  it('reads the dev preview, the session and the thread from the Builder with the builder token', async () => {
    const { api, calls } = apis({
      'GET /v1/workspaces/team-board': () => ({ json: { workspace } }),
      'GET /v1/workspaces/team-board/events': () => ({ json: { events: build } }),
    });
    expect(await api.getPreview('team-board')).toEqual({ kind: 'url', url: 'http://localhost:4321' });
    const session = await api.getBuilderSession('team-board');
    expect(session).toMatchObject({ workspace: { state: 'idle', agent: scripted, version: 'v1' }, events: build });
    expect(await api.getBuilderThread('team-board', 'screen')).toHaveLength(2);
    expect(calls.every((c) => c.auth === 'Bearer builder-token')).toBe(true);
    expect(calls.find((c) => c.url.includes('/events'))?.url).toBe('http://builder.test/v1/workspaces/team-board/events?format=json');
  });

  it('has no preview, session or thread for an app without a workspace, or without a Builder', async () => {
    const { api } = apis({});
    expect(await api.getPreview('ticket-board')).toBeNull();
    expect(await api.getBuilderSession('ticket-board')).toBeNull();
    expect(await api.getBuilderThread('ticket-board', 'screen')).toEqual([]);
    await expect(api.sendBuilderMessage('ticket-board', 'screen', 'hi')).rejects.toMatchObject({ status: 404, message: 'This app has no Builder workspace yet.' });

    const fetch = vi.fn();
    const alone = createHttpApi({ baseUrl: 'http://control.test', token: 't', fetch });
    expect(await alone.getPreview('ticket-board')).toBeNull();
    await expect(alone.sendBuilderMessage('ticket-board', 'screen', 'hi')).rejects.toMatchObject({ status: 501 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('starts a chat turn with the tab as context', async () => {
    const { api, calls } = apis({
      'POST /v1/workspaces/team-board/messages': () => ({ status: 202, json: { workspace, turn: 't2' } }),
      'GET /v1/workspaces/team-board': () => ({ json: { workspace } }),
      'GET /v1/workspaces/team-board/events': () => ({ json: { events: build } }),
    });
    expect(await api.sendBuilderMessage('team-board', 'access', 'Members only see their own tickets')).toHaveLength(2);
    expect(calls[0]).toMatchObject({ method: 'POST', body: { text: 'Members only see their own tickets', context: 'access' } });
  });
});
