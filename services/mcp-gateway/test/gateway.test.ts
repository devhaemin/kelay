import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { audienceForApp, type AppRegistryEntry } from '@kelay/contracts';
import { RegistryUnavailableError, type AppRegistrySource } from '@kelay/contracts/registry';
import { createDevSigner } from '@kelay/tokens';
import type { ActionRunner, buildAgentCard } from '../src/index.ts';
import { BASE, CLIENT_ID, METADATA_URL, OAUTH, RESOURCE, denied, registry, setup } from './harness.ts';

type AgentCard = ReturnType<typeof buildAgentCard>;

const TICKET_ID = '3f2b8c1e-7a4d-4e9b-9c1a-2d5e6f708192';
const ticket = { id: TICKET_ID, title: 'Fix login', status: 'todo', assignee_id: 'u_1', shared: false };

const textOf = (result: { content?: unknown }): string => {
  const [first] = (result.content ?? []) as { type: string; text?: string }[];
  return first?.text ?? '';
};

describe('authentication and discovery', () => {
  it('answers a call without a token with 401 and the resource metadata challenge', async () => {
    const { rpc } = await setup();
    const res = await rpc(undefined, 'tools/list');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${METADATA_URL}"`);
    expect(await res.json()).toMatchObject({ error: { code: 'unauthenticated' } });
  });

  it('serves the RFC 9728 protected resource metadata document', async () => {
    const { gateway, signer } = await setup();
    const res = await gateway.request('/.well-known/oauth-protected-resource/orum/ticket-board/mcp');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { scopes_supported: string[] };
    expect(doc).toMatchObject({
      resource: RESOURCE,
      authorization_servers: [signer.issuer],
      bearer_methods_supported: ['header'],
    });
    expect(doc.scopes_supported).toEqual(['offline_access']);
  });

  it('rejects screen tokens, other resources, other apps, missing azp and foreign signers', async () => {
    const { rpc, token } = await setup();
    const stranger = await createDevSigner();
    const bad = {
      screenToken: await token({ aud: audienceForApp('ticket-board') }),
      otherResource: await token({ aud: `${BASE}/orum/wiki/mcp` }),
      otherApp: await token({ app: 'wiki' }),
      noClient: await token({ azp: undefined }),
      foreign: await stranger.sign({ sub: 'u_1', app: 'ticket-board', org: 'orum', role: 'member', plan: 'free', aud: RESOURCE, azp: CLIENT_ID }),
    };
    for (const [name, t] of Object.entries(bad)) {
      const res = await rpc(t, 'tools/list');
      expect(res.status, name).toBe(401);
      const challenge = res.headers.get('www-authenticate') ?? '';
      expect(challenge, name).toMatch(/^Bearer resource_metadata="[^"]+", error="invalid_token", error_description="/);
      expect(challenge, name).toContain(METADATA_URL);
    }
    expect((await rpc('not-a-jwt', 'tools/list')).status).toBe(401);
  });

  it('answers 404 when the handle does not own the app, and 405 for non-POST methods', async () => {
    const { gateway, rpc, token } = await setup();
    expect((await rpc(await token(), 'tools/list', '/someone-else/ticket-board/mcp')).status).toBe(404);
    expect((await rpc(await token(), 'tools/list', '/orum/no-such-app/mcp')).status).toBe(404);
    expect((await gateway.request('/.well-known/oauth-protected-resource/someone-else/ticket-board/mcp')).status).toBe(404);
    const get = await gateway.request('/orum/ticket-board/mcp');
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
  });

  it('reports health', async () => {
    const { gateway } = await setup();
    expect(await (await gateway.request('/healthz')).json()).toEqual({ ok: true });
  });
});

describe('apps from the control API', () => {
  const board = registry.apps['ticket-board']!;

  /** A registry whose answer for ticket-board in prod the test changes, as deploys do. */
  function liveRegistry() {
    const state: { entry: AppRegistryEntry | undefined; down: boolean; asked: string[] } = { entry: undefined, down: false, asked: [] };
    const source: AppRegistrySource = {
      kind: 'control-api',
      list: async () => [],
      async get(app, env) {
        state.asked.push(`${app}:${env}`);
        if (state.down) throw new RegistryUnavailableError('registry: the control API did not answer');
        return app === 'ticket-board' ? state.entry : undefined;
      },
    };
    return { state, source };
  }

  it('serves an app published after the gateway started, from its production deployment', async () => {
    const { state, source } = liveRegistry();
    const { gateway, connect, token } = await setup({ registry: source });
    expect((await gateway.request('/.well-known/oauth-protected-resource/orum/ticket-board/mcp')).status).toBe(404);

    state.entry = board;
    expect((await gateway.request('/.well-known/oauth-protected-resource/orum/ticket-board/mcp')).status).toBe(200);
    const client = await connect(await token());
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
    expect(new Set(state.asked)).toEqual(new Set(['ticket-board:prod']));
  });

  it('offers the tools of the schema that is deployed now', async () => {
    const { state, source } = liveRegistry();
    const { connect, token } = await setup({ registry: source });
    state.entry = board;
    const before = await connect(await token());
    const names = (await before.listTools()).tools.map((t) => t.name);
    await before.close();

    const [first, ...rest] = board.schema.collections;
    state.entry = { ...board, schema: { ...board.schema, collections: rest } };
    const after = await connect(await token());
    const remaining = (await after.listTools()).tools.map((t) => t.name);
    await after.close();
    expect(names.some((n) => n.startsWith(`${first!.name}_`) || n.includes(first!.name.replace(/s$/, '')))).toBe(true);
    expect(remaining.length).toBeLessThan(names.length);
  });

  it('answers 500 while the registry cannot be reached, not "no such app"', async () => {
    const { state, source } = liveRegistry();
    const { gateway, errors } = await setup({ registry: source });
    state.down = true;
    const res = await gateway.request('/orum/ticket-board/.well-known/agent-card.json');
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: 'internal' } });
    expect(errors.map((e) => e.name)).toEqual(['RegistryUnavailableError']);
  });
});

describe('generated tools', () => {
  it('lists five tools per collection plus one per action, with JSON Schema inputs', async () => {
    const { connect, token } = await setup();
    const client = await connect(await token());
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(tools.map((t) => t.name)).toEqual([
      ...['projects', 'tickets', 'comments'].flatMap((c) => ['list', 'get', 'create', 'update', 'delete'].map((op) => `${c}_${op}`)),
      'action_summarize_overdue',
    ]);

    const create = byName.get('tickets_create')!;
    expect(create.inputSchema).toMatchObject({
      type: 'object',
      required: ['title', 'status'],
      additionalProperties: false,
      properties: {
        title: { type: 'string' },
        status: { type: 'string', description: 'todo | doing | review | done' },
        assignee_id: { type: ['string', 'null'] },
        due_on: { type: ['string', 'null'], format: 'date-time' },
        project_id: { type: ['string', 'null'], format: 'uuid', description: 'Id of a project.' },
        shared: { type: ['boolean', 'null'] },
      },
    });
    expect(Object.keys(byName.get('projects_create')!.inputSchema.properties ?? {})).toEqual(['name', 'starts_on', 'ends_on']);

    expect(byName.get('tickets_update')!.inputSchema).toMatchObject({
      required: ['id', 'values'],
      properties: { id: { type: 'string', format: 'uuid' }, values: { type: 'object', minProperties: 1 } },
    });
    const list = byName.get('tickets_list')!.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect((list.where!.propertyNames as { enum: string[] }).enum).toEqual(
      expect.arrayContaining(['id', 'owner_id', 'created_at', 'shared', 'title', 'status', 'assignee_id', 'project_id']),
    );
    expect(list.limit).toMatchObject({ type: 'integer', maximum: 500 });
    expect(byName.get('comments_get')!.inputSchema).toMatchObject({ required: ['id'] });
    expect(byName.get('action_summarize_overdue')).toMatchObject({ description: 'Summarize my overdue tickets', inputSchema: { type: 'object' } });
    expect(byName.get('tickets_list')!.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.get('tickets_delete')!.annotations).toMatchObject({ destructiveHint: true });
    await client.close();
  });

  it('runs list as a select with the user token and a service caller token', async () => {
    const { connect, token, data } = await setup();
    const userToken = await token();
    data.reply(() => Response.json({ rows: [ticket], count: 1 }));
    const client = await connect(userToken);
    const result = await client.callTool({ name: 'tickets_list', arguments: { where: { status: { in: ['todo', 'doing'] } }, limit: 5 } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ rows: [ticket], count: 1 });
    expect(data.queries).toEqual([
      {
        app: 'ticket-board',
        authorization: `Bearer ${userToken}`,
        caller: expect.objectContaining({ kind: 'service', svc: 'mcp-gateway' }),
        body: {
          op: 'select',
          collection: 'tickets',
          where: { status: { in: ['todo', 'doing'] } },
          orderBy: [{ field: 'created_at', dir: 'desc' }],
          limit: 5,
        },
      },
    ]);
    await client.close();
  });

  it('maps create, update, get and delete to Data API queries', async () => {
    const { connect, token, data } = await setup();
    data.reply((q) => Response.json({ rows: q.op === 'select' ? [] : [ticket], count: q.op === 'select' ? 0 : 1 }));
    const client = await connect(await token());

    const created = await client.callTool({ name: 'tickets_create', arguments: { title: 'Fix login', status: 'todo' } });
    expect(created.structuredContent).toEqual(ticket);
    const updated = await client.callTool({ name: 'tickets_update', arguments: { id: TICKET_ID, values: { status: 'done', assignee_id: null } } });
    expect(updated.isError).toBeFalsy();
    const missing = await client.callTool({ name: 'tickets_get', arguments: { id: TICKET_ID } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toBe(`No ticket with id ${TICKET_ID} is visible to you.`);
    const deleted = await client.callTool({ name: 'tickets_delete', arguments: { id: TICKET_ID } });
    expect(textOf(deleted)).toBe(`Deleted ticket ${TICKET_ID}.`);

    expect(data.queries.map((q) => q.body)).toEqual([
      { op: 'insert', collection: 'tickets', values: { title: 'Fix login', status: 'todo' } },
      { op: 'update', collection: 'tickets', where: { id: TICKET_ID }, values: { status: 'done', assignee_id: null } },
      { op: 'select', collection: 'tickets', where: { id: TICKET_ID }, limit: 1 },
      { op: 'delete', collection: 'tickets', where: { id: TICKET_ID } },
    ]);
    await client.close();
  });

  it('turns a denied Data API answer into an isError result with a plain sentence', async () => {
    const { connect, token, data } = await setup();
    data.reply(() => denied());
    const client = await connect(await token({ role: 'guest' }));
    const result = await client.callTool({ name: 'tickets_update', arguments: { id: TICKET_ID, values: { status: 'done' } } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("You don't have permission to update this ticket.");
    const create = await client.callTool({ name: 'projects_create', arguments: { name: 'Q4' } });
    expect(textOf(create)).toBe("You don't have permission to create projects.");
    await client.close();
  });

  it('rejects invalid arguments as a metered, rate-limited tool error without calling the Data API', async () => {
    const { connect, token, data, calls } = await setup({ ratePerMin: 5 });
    const client = await connect(await token());
    for (const args of [{ title: 'No status' }, { title: 'x', status: 'todo', owner_id: 'u_2' }, { title: 'x', status: 'todo', due_on: 'tomorrow' }]) {
      const result = await client.callTool({ name: 'tickets_create', arguments: args });
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(textOf(result)).toMatch(/^Invalid arguments for tickets_create: /);
    }
    const badId = await client.callTool({ name: 'tickets_get', arguments: { id: 'not-a-uuid' } });
    expect(badId.isError).toBe(true);
    expect(data.queries).toHaveLength(0);
    expect(calls.map((c) => [c.tool, c.ok])).toEqual([
      ['tickets_create', false],
      ['tickets_create', false],
      ['tickets_create', false],
      ['tickets_get', false],
    ]);
    const limited = await client.callTool({ name: 'tickets_get', arguments: { id: 'still-not-a-uuid' } });
    expect(textOf(limited)).toMatch(/^Rate limit reached/);
    await client.close();
  });

  it('passes the Data API message through for other rejections, and hides internal failures', async () => {
    const { connect, token, data, errors } = await setup();
    const client = await connect(await token());
    data.reply(() => Response.json({ error: { code: 'invalid_request', message: 'unknown field: colour' } }, { status: 400 }));
    expect(textOf(await client.callTool({ name: 'tickets_list', arguments: {} }))).toBe('The request was rejected: unknown field: colour');
    data.reply(() => new Response('upstream exploded', { status: 502 }));
    const broken = await client.callTool({ name: 'tickets_list', arguments: {} });
    expect(broken.isError).toBe(true);
    expect(textOf(broken)).not.toContain('exploded');
    expect(errors.map((e) => e.message)).toEqual([expect.stringContaining('data api internal')]);
    await client.close();
  });

  it('answers action tools through the ActionRunner, which is "not available yet" by default', async () => {
    const fallback = await setup();
    const client = await fallback.connect(await fallback.token());
    const result = await client.callTool({ name: 'action_summarize_overdue', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('The "summarize_overdue" action isn\'t available yet.');
    await client.close();

    const seen: unknown[] = [];
    const actions: ActionRunner = {
      async run(call) {
        seen.push({ action: call.action.name, sub: call.claims.sub, token: call.userToken });
        return { ok: true, output: { overdue: 2 } };
      },
    };
    const custom = await setup({ actions });
    const userToken = await custom.token();
    const other = await custom.connect(userToken);
    const ran = await other.callTool({ name: 'action_summarize_overdue', arguments: {} });
    expect(ran.structuredContent).toEqual({ overdue: 2 });
    expect(seen).toEqual([{ action: 'summarize_overdue', sub: 'u_1', token: userToken }]);
    await other.close();
  });
});

describe('over real HTTP', () => {
  it('serves tool calls through @hono/node-server', async () => {
    const { gateway, token, data, connect } = await setup();
    data.reply(() => Response.json({ rows: [ticket], count: 1 }));
    const server = serve({ fetch: gateway.fetch, port: 0, hostname: '127.0.0.1' });
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    try {
      const client = await connect(await token(), `http://127.0.0.1:${port}/orum/ticket-board/mcp`);
      const result = await client.callTool({ name: 'tickets_get', arguments: { id: TICKET_ID } });
      expect(result.structuredContent).toEqual(ticket);
      await client.close();
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
});

describe('metering', () => {
  it('records one mcp_call line per tool call with duration and outcome', async () => {
    const { connect, token, data, calls, clock } = await setup();
    data.reply(() => {
      clock.now += 25;
      return Response.json({ rows: [], count: 0 });
    });
    const client = await connect(await token());
    await client.listTools();
    await client.callTool({ name: 'tickets_list', arguments: {} });
    data.reply(() => denied());
    await client.callTool({ name: 'tickets_delete', arguments: { id: TICKET_ID } });
    expect(calls).toEqual([
      { type: 'mcp_call', app: 'ticket-board', sub: 'u_1', client: CLIENT_ID, tool: 'tickets_list', ms: 25, ok: true, args: '{}' },
      { type: 'mcp_call', app: 'ticket-board', sub: 'u_1', client: CLIENT_ID, tool: 'tickets_delete', ms: 0, ok: false, denied: true, args: `{"id":"${TICKET_ID}"}` },
    ]);
    await client.close();
  });
});

describe('rate limits', () => {
  it('limits tool calls per user and app with a tool error, then refills', async () => {
    const { connect, token, data, clock, calls } = await setup({ ratePerMin: 3 });
    const client = await connect(await token()); // server/discover takes one token
    const first = await client.callTool({ name: 'tickets_list', arguments: {} });
    const second = await client.callTool({ name: 'tickets_list', arguments: {} });
    const third = await client.callTool({ name: 'tickets_list', arguments: {} });
    expect([first.isError, second.isError]).toEqual([undefined, undefined]);
    expect(third.isError).toBe(true);
    expect(textOf(third)).toBe('Rate limit reached (3 calls per minute). Try again in 20 seconds.');
    expect(data.queries).toHaveLength(2);
    expect(calls.at(-1)).toMatchObject({ tool: 'tickets_list', ok: false });

    clock.now += 20_000;
    expect((await client.callTool({ name: 'tickets_list', arguments: {} })).isError).toBeFalsy();
    await client.close();
  });

  it('answers other requests with 429 and Retry-After once a bucket is empty', async () => {
    const { rpc, token } = await setup({ ratePerMin: 2 });
    const t = await token();
    expect((await rpc(t, 'tools/list')).status).toBe(200);
    expect((await rpc(t, 'tools/list')).status).toBe(200);
    const limited = await rpc(t, 'tools/list');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('30');
    expect(await limited.json()).toMatchObject({ error: { code: 'rate_limited' } });
  });

  it('shares one bucket across all users of the same assistant client in one app', async () => {
    const { rpc, token } = await setup({ ratePerMin: 2 });
    const alice = await token({ sub: 'u_1' });
    expect((await rpc(alice, 'tools/list')).status).toBe(200);
    expect((await rpc(alice, 'tools/list')).status).toBe(200);
    expect((await rpc(await token({ sub: 'u_2' }), 'tools/list')).status).toBe(429);
    expect((await rpc(await token({ sub: 'u_3', azp: 'https://other-assistant.example/client.json' }), 'tools/list')).status).toBe(200);
    expect((await rpc(await token({ sub: 'u_1', azp: 'https://other-assistant.example/client.json' }), 'tools/list')).status).toBe(429);
  });
});

describe('A2A agent card', () => {
  it('describes the app, its Kelay ID security scheme and one skill per collection and action', async () => {
    const { gateway } = await setup();
    const res = await gateway.request('/orum/ticket-board/.well-known/agent-card.json', { headers: { origin: 'https://inspector.example' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('etag')).toBeTruthy();
    const card = (await res.json()) as AgentCard;
    expect(card).toMatchObject({
      name: 'ticket-board',
      supportedInterfaces: [{ url: `${BASE}/orum/ticket-board/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      version: expect.stringMatching(/^[0-9a-f]{12}$/),
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: expect.arrayContaining(['application/json']),
      defaultOutputModes: expect.arrayContaining(['application/json']),
      securitySchemes: {
        kelayId: {
          oauth2SecurityScheme: {
            oauth2MetadataUrl: OAUTH.metadataUrl,
            flows: { authorizationCode: { authorizationUrl: OAUTH.authorizationUrl, tokenUrl: OAUTH.tokenUrl, pkceRequired: true } },
          },
        },
      },
      securityRequirements: [{ schemes: { kelayId: { list: ['offline_access'] } } }],
    });
    expect(card.description).toContain(RESOURCE);
    expect(card.skills.map((s) => s.id)).toEqual(['projects', 'tickets', 'comments', 'action_summarize_overdue']);
    const tickets = card.skills[1];
    expect(tickets).toMatchObject({ name: 'Tickets', tags: ['collection', 'tickets'] });
    expect(tickets?.description).toContain('status (text, required: todo | doing | review | done)');
    for (const skill of card.skills) expect(Object.keys(skill)).toEqual(expect.arrayContaining(['id', 'name', 'description', 'tags']));
  });

  it('answers the advertised A2A interface with UnsupportedOperationError for now', async () => {
    const { gateway } = await setup();
    const res = await gateway.request('/orum/ticket-board/a2a', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'SendMessage', params: {} }),
    });
    expect(await res.json()).toMatchObject({ jsonrpc: '2.0', id: 7, error: { code: -32004 } });
  });
});
