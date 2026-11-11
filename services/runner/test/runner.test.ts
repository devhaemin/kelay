import { describe, expect, it, vi } from 'vitest';
import { verifyCallerToken } from '@kelay/tokens';
import { createControlApiRecorder, type RunRecord } from '../src/index.ts';
import { APP, CALLER_SECRET, GRAPH, defaultNodes, gate, setup } from './harness.ts';

describe('starting and reading a run', () => {
  it('runs the graph as the user and answers with output and a per-node trace', async () => {
    const { start, get, invocations, userToken } = await setup();
    const token = await userToken();
    const started = await start({ graph: GRAPH, input: { since: '2026-11-01' } }, { token });
    expect(started.status).toBe(202);
    expect(started.body.runId).toMatch(/^[0-9a-f-]{36}$/);

    const { status, body } = await get(started.body.runId, { token });
    expect(status).toBe(200);
    expect(body.run).toMatchObject({
      id: started.body.runId,
      app: APP,
      env: 'prod',
      graph: GRAPH,
      action: GRAPH,
      status: 'succeeded',
      caller: { kind: 'user' },
      output: { approved: true, branches: [{ summary: '2 overdue' }, { order: ['t2', 't1'] }] },
      error: null,
    });
    expect(body.run.costUsd).toBeCloseTo(0.006);
    expect(body.run.ms).toBeGreaterThanOrEqual(0);
    expect(body.run.trace.map((t: { node: string; status: string }) => [t.node, t.status])).toEqual([
      ['collect', 'ok'],
      ['summarize', 'ok'],
      ['prioritize', 'ok'],
      ['review', 'ok'],
    ]);
    expect(body.run.trace[1]).toMatchObject({ attempt: 1, loop: 0, llmCalls: 1, costUsd: 0.004 });
    expect(body.run).not.toHaveProperty('input');

    // Every node got the user's own token and an app-runtime caller token for this app and env.
    expect(invocations).toHaveLength(4);
    expect(invocations[0]!.invocation).toMatchObject({ runId: started.body.runId, app: APP, env: 'prod', graph: GRAPH, node: 'collect', input: { since: '2026-11-01' }, userToken: token });
    expect(await verifyCallerToken(invocations[0]!.host.callerToken, CALLER_SECRET)).toMatchObject({ kind: 'app-runtime', app: APP, env: 'prod' });
  });

  it('goes back to collect when the review rejects, counting the loop', async () => {
    const { start, get } = await setup({
      nodes: { review: (inv) => ({ output: { approved: inv.loop > 0 } }) },
    });
    const { body } = await get((await start()).body.runId);
    expect(body.run.status).toBe('succeeded');
    expect(body.run.trace.map((t: { node: string; loop: number }) => `${t.node}@${t.loop}`)).toEqual([
      'collect@0',
      'summarize@0',
      'prioritize@0',
      'review@0',
      'collect@1',
      'summarize@1',
      'prioritize@1',
      'review@1',
    ]);
  });

  it('reports a failed node with its name and error, and keeps the trace', async () => {
    const { start, get, records } = await setup({
      nodes: {
        prioritize: () => {
          throw new TypeError('no tickets to rank');
        },
      },
    });
    const { body } = await get((await start()).body.runId);
    expect(body.run).toMatchObject({ status: 'failed', output: null, error: { name: 'TypeError', message: 'no tickets to rank', node: 'prioritize' } });
    expect(body.run.trace.find((t: { node: string }) => t.node === 'prioritize')).toMatchObject({ status: 'error', error: 'TypeError', message: 'no tickets to rank' });
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0]).toMatchObject({ status: 'error', note: 'prioritize: TypeError: no tickets to rank' });
  });

  it('answers a run that is still going, and waits for it when asked', async () => {
    const hold = gate();
    const { start, get } = await setup({ nodes: { collect: async () => (await hold.wait(), defaultNodes.collect!({} as never, {} as never)) } });
    const { runId } = (await start()).body;
    const early = await get(runId, {}, '');
    expect(early.body.run).toMatchObject({ status: 'running', output: null, finishedAt: null, ms: null });
    const waiting = get(runId, {}, '?wait=5');
    hold.open();
    expect((await waiting).body.run.status).toBe('succeeded');
  });

  it('streams the run as server-sent events, replaying what already happened', async () => {
    const hold = gate();
    const { runner, start, headers } = await setup({ nodes: { review: async () => (await hold.wait(), { output: { approved: true } }) } });
    const { runId } = (await start()).body;
    const res = await runner.request(`/v1/runs/${runId}/events`, { headers: await headers() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    hold.open();
    const text = await res.text();
    const events = [...text.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]);
    expect(events[0]).toBe('run_started');
    expect(events.at(-1)).toBe('run_finished');
    expect(events.filter((e) => e === 'node_started')).toHaveLength(4);
    expect(events.filter((e) => e === 'node_finished')).toHaveLength(4);
    const last = JSON.parse(text.trim().split('\n').filter((l) => l.startsWith('data: ')).at(-1)!.slice(6));
    expect(last).toMatchObject({ status: 'succeeded', output: { approved: true } });

    // A finished run replays in full and closes; Last-Event-ID skips what the client already has.
    const replay = await runner.request(`/v1/runs/${runId}/events`, { headers: { ...(await headers()), 'last-event-id': String(events.length - 1) } });
    expect([...(await replay.text()).matchAll(/^event: (\S+)$/gm)].map((m) => m[1])).toEqual(['run_finished']);
  });
});

describe('who may start and read runs', () => {
  it('needs the user token and a caller token, both for this app', async () => {
    const { start, userToken, appCaller } = await setup();
    expect((await start(undefined, { token: null })).body).toMatchObject({ error: { code: 'unauthenticated' } });
    expect((await start(undefined, { caller: null })).body).toMatchObject({ error: { code: 'forbidden_caller' } });
    expect((await start(undefined, { caller: 'not-a-token' })).status).toBe(403);
    expect((await start(undefined, { caller: await appCaller('team-wiki') })).body).toMatchObject({ error: { code: 'forbidden_caller' } });
    const wikiToken = await userToken({ app: 'team-wiki' });
    expect((await start(undefined, { token: wikiToken })).status).toBe(401);
  });

  it('takes the env from the app runtime, and the caller kind only from a platform service', async () => {
    const { start, get, appCaller, serviceCaller, records } = await setup();
    const dev = await start(undefined, { caller: await appCaller(APP, 'dev') });
    expect((await get(dev.body.runId)).body.run).toMatchObject({ env: 'dev', caller: { kind: 'user' } });

    const spoof = await start({ graph: GRAPH, caller: { kind: 'app', id: 'docs' } });
    expect(spoof.status).toBe(400);
    expect(spoof.body.error.message).toContain('only platform services');

    const service = await serviceCaller();
    const viaAgent = await start(
      { graph: GRAPH, action: 'summarize_overdue', caller: { kind: 'agent', id: 'https://assistant.example/client.json' } },
      { caller: service },
    );
    expect((await get(viaAgent.body.runId, { caller: service })).body.run).toMatchObject({
      action: 'summarize_overdue',
      caller: { kind: 'agent', id: 'https://assistant.example/client.json' },
    });
    await vi.waitFor(() => expect(records).toHaveLength(2));
    expect(records[1]).toMatchObject({
      app: APP,
      env: 'prod',
      action: 'summarize_overdue',
      status: 'ok',
      userId: 'u_junho',
      caller: { kind: 'agent', id: 'https://assistant.example/client.json' },
    });
  });

  it('answers 404 for an unknown graph or app without holding a run slot', async () => {
    const { start } = await setup({ maxConcurrentPerUser: 1 });
    expect((await start({ graph: 'no-such-graph' })).body).toMatchObject({ error: { code: 'not_found' } });
    expect((await start({ graph: 'Not A Slug' })).status).toBe(400);
    expect((await start({ graph: GRAPH })).status).toBe(202);
  });

  it('hides a run from everyone but the user who started it', async () => {
    const { start, get, userToken, appCaller } = await setup();
    const { runId } = (await start()).body;
    expect((await get(runId, { token: await userToken({ sub: 'u_mina' }) })).body).toMatchObject({ error: { code: 'not_found' } });
    expect((await get(runId, { caller: await appCaller('team-wiki') })).status).toBe(403);
    expect((await get('no-such-run')).status).toBe(404);
    expect((await get(runId, { token: null })).status).toBe(401);
  });
});

describe('concurrent run cap', () => {
  it('refuses a third run while two are in progress, per user, and frees the slot when one ends', async () => {
    const hold = gate();
    const { start, get, userToken } = await setup({ nodes: { collect: async () => (await hold.wait(), { output: {} }) } });
    const first = await start();
    const second = await start();
    expect([first.status, second.status]).toEqual([202, 202]);

    const third = await start();
    expect(third.status).toBe(429);
    expect(third.body).toMatchObject({ error: { code: 'rate_limited' } });
    expect(third.headers.get('retry-after')).toBe('5');

    // Another person is not held back by Junho's runs.
    const mina = await userToken({ sub: 'u_mina' });
    expect((await start(undefined, { token: mina })).status).toBe(202);

    hold.open();
    await get(first.body.runId);
    await get(second.body.runId);
    expect((await start()).status).toBe(202);
  });

  it('follows the configured cap', async () => {
    const hold = gate();
    const { start } = await setup({ maxConcurrentPerUser: 1, nodes: { collect: async () => (await hold.wait(), { output: {} }) } });
    expect((await start()).status).toBe(202);
    expect((await start()).status).toBe(429);
    hold.open();
  });
});

describe('recording', () => {
  it('records each run with status, duration, caller, node metrics and model cost', async () => {
    const { start, get, records } = await setup();
    await get((await start({ graph: GRAPH, input: { since: '2026-11-01' } })).body.runId);
    await vi.waitFor(() => expect(records).toHaveLength(1));
    const [record] = records;
    expect(record).toMatchObject({ app: APP, env: 'prod', action: GRAPH, status: 'ok', userId: 'u_junho', caller: { kind: 'user' }, args: '{"since":"2026-11-01"}' });
    expect(record!.costUsd).toBeCloseTo(0.006);
    expect(record!.nodes.map((n) => [n.node, n.status, n.attempt, n.loop])).toEqual([
      ['collect', 'ok', 1, 0],
      ['summarize', 'ok', 1, 0],
      ['prioritize', 'ok', 1, 0],
      ['review', 'ok', 1, 0],
    ]);
    expect(record!.nodes[1]).toMatchObject({ costUsd: 0.004 });
    expect(Number.isInteger(record!.ms)).toBe(true);
    expect(Date.parse(record!.at)).not.toBeNaN();
  });

  it('leaves the cost out when no node reported one', async () => {
    const { start, get, records } = await setup({ nodes: { summarize: () => ({ output: {} }), prioritize: () => ({ output: {} }) } });
    const { body } = await get((await start()).body.runId);
    expect(body.run.costUsd).toBeNull();
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0]).not.toHaveProperty('costUsd');
  });

  it('posts the record to the control API as the runner service, and tries again after a 5xx', async () => {
    const seen: { url: string; caller: unknown; body: unknown }[] = [];
    let failures = 1;
    const record = createControlApiRecorder({
      controlApiUrl: 'http://control.test/',
      callerSecret: CALLER_SECRET,
      retryMs: 1,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const req = new Request(input, init);
        seen.push({ url: req.url, caller: await verifyCallerToken(req.headers.get('x-kelay-caller')!, CALLER_SECRET), body: await req.json() });
        return failures-- > 0 ? new Response('{}', { status: 503 }) : Response.json({ recorded: 1, skipped: 0 }, { status: 201 });
      }) as typeof fetch,
    });
    const run = { app: APP, env: 'prod', action: GRAPH, status: 'ok', userId: 'u_junho', ms: 12, caller: { kind: 'user' }, nodes: [], at: new Date().toISOString() } satisfies RunRecord;
    await record(run);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ url: 'http://control.test/internal/v1/runs', caller: { kind: 'service', svc: 'runner' }, body: { runs: [run] } });

    const rejected = createControlApiRecorder({ controlApiUrl: 'http://control.test', callerSecret: CALLER_SECRET, retryMs: 1, fetch: (async () => new Response('{}', { status: 400 })) as typeof fetch });
    await expect(rejected(run)).rejects.toThrow('HTTP 400');
  });
});
