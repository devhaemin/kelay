import { CALLER_HEADER, McpCallRecord as McpCallRecordSchema, type CallerClaims } from '@kelay/contracts';
import { verifyCallerToken } from '@kelay/tokens';
import { describe, expect, it, vi } from 'vitest';
import { AppSchema } from '@kelay/contracts';
import { authorizationServerMetadataUrl, kelayIdOAuthEndpoints } from '../src/agent-card.ts';
import { createControlApiMeter, stdoutMeter, type McpCallRecord } from '../src/metering.ts';
import { createRateLimiter } from '../src/rate-limit.ts';
import { buildTools, singular } from '../src/tools.ts';

describe('tool derivation', () => {
  it('singularizes collection names for messages', () => {
    expect(['tickets', 'categories', 'statuses', 'cases', 'line_items', 'news'].map(singular)).toEqual([
      'ticket',
      'category',
      'status',
      'case',
      'line item',
      'news',
    ]);
  });

  it('maps every field type to JSON Schema', () => {
    const schema = AppSchema.parse({
      app: 'kitchen',
      roles: ['cook'],
      collections: [
        {
          name: 'recipes',
          fields: {
            servings: { type: 'number', required: true },
            vegan: { type: 'boolean' },
            source_id: { type: 'uuid' },
            steps: { type: 'json' },
          },
        },
      ],
      actions: [{ name: 'plan_week', description: 'Plan meals', input: { days: { type: 'number', required: true } } }],
    });
    const tools = new Map(buildTools(schema).map((t) => [t.name, t]));
    expect(tools.get('recipes_create')!.inputSchema).toEqual({
      type: 'object',
      properties: {
        servings: { type: 'number' },
        vegan: { type: ['boolean', 'null'] },
        source_id: { type: ['string', 'null'], format: 'uuid' },
        steps: { description: 'Any JSON value.' },
      },
      required: ['servings'],
      additionalProperties: false,
    });
    expect(tools.get('action_plan_week')!.inputSchema).toEqual({
      type: 'object',
      properties: { days: { type: 'number' } },
      required: ['days'],
      additionalProperties: false,
    });
    expect((tools.get('recipes_list')!.inputSchema.properties as { where: { propertyNames: { enum: string[] } } }).where.propertyNames.enum).not.toContain(
      'shared',
    );
  });
});

describe('rate limiter', () => {
  it('takes from all buckets or none', () => {
    const clock = { now: 0 };
    const limiter = createRateLimiter({ perMinute: 1, now: () => clock.now });
    expect(limiter.take(['client:a'])).toEqual({ ok: true });
    expect(limiter.take(['user:1', 'client:a'])).toEqual({ ok: false, retryAfterSeconds: 60 });
    expect(limiter.take(['user:1', 'client:b'])).toEqual({ ok: true });
    clock.now += 30_000;
    expect(limiter.take(['client:a'])).toEqual({ ok: false, retryAfterSeconds: 30 });
    clock.now += 30_000;
    expect(limiter.take(['client:a'])).toEqual({ ok: true });
  });
});

describe('helpers', () => {
  it('inserts the RFC 8414 well-known segment before the issuer path', () => {
    expect(authorizationServerMetadataUrl('http://localhost:4001')).toBe('http://localhost:4001/.well-known/oauth-authorization-server');
    expect(authorizationServerMetadataUrl('https://id.kelay.dev/api/auth/')).toBe(
      'https://id.kelay.dev/.well-known/oauth-authorization-server/api/auth',
    );
  });

  it('derives Kelay ID OAuth endpoints from the issuer, where better-auth serves them', () => {
    expect(kelayIdOAuthEndpoints('http://localhost:4001/')).toEqual({
      authorizationUrl: 'http://localhost:4001/api/auth/oauth2/authorize',
      tokenUrl: 'http://localhost:4001/api/auth/oauth2/token',
      metadataUrl: 'http://localhost:4001/.well-known/oauth-authorization-server',
    });
  });

  it('writes metering records as one JSON line on stdout', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stdoutMeter({ type: 'mcp_call', app: 'a', sub: 's', client: 'c', tool: 't', ms: 1, ok: true });
    expect(write).toHaveBeenCalledWith('{"type":"mcp_call","app":"a","sub":"s","client":"c","tool":"t","ms":1,"ok":true}\n');
    write.mockRestore();
  });
});

describe('control API meter', () => {
  const record = (tool: string): McpCallRecord => ({ type: 'mcp_call', app: 'ticket-board', sub: 'u_1', client: 'https://c.example/client.json', tool, ms: 3, ok: true });
  const SECRET = 'test-caller-secret-0123456789abcdef';

  function controlApi(status: () => number) {
    const posts: { url: string; caller: CallerClaims; calls: McpCallRecord[] }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const code = status();
      if (code === 0) throw new Error('connection refused');
      if (code < 300) {
        posts.push({
          url: String(input),
          caller: await verifyCallerToken(headers.get(CALLER_HEADER) ?? '', SECRET),
          calls: (JSON.parse(String(init?.body)) as { calls: McpCallRecord[] }).calls,
        });
      }
      return new Response('{}', { status: code });
    }) as typeof fetch;
    return { posts, fetchImpl };
  }

  it('posts records in batches as the mcp-gateway service, stamped with their time', async () => {
    const api = controlApi(() => 201);
    const meter = createControlApiMeter({ controlApiUrl: 'http://control.test/', callerSecret: SECRET, fetch: api.fetchImpl, maxBatch: 2, flushMs: 60_000 });
    meter.sink(record('tickets_list'));
    expect(api.posts).toHaveLength(0);
    meter.sink(record('tickets_get'));
    await meter.flush();
    meter.sink(record('tickets_update'));
    await meter.flush();
    expect(api.posts.map((p) => p.calls.map((c) => c.tool))).toEqual([['tickets_list', 'tickets_get'], ['tickets_update']]);
    expect(api.posts[0]).toMatchObject({ url: 'http://control.test/internal/v1/mcp-calls', caller: { kind: 'service', svc: 'mcp-gateway' } });
    expect(McpCallRecordSchema.parse(api.posts[0]!.calls[0]).at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('never throws into the tool call and resends a batch the control API could not take', async () => {
    let status = 0;
    const errors: Error[] = [];
    const api = controlApi(() => status);
    const meter = createControlApiMeter({ controlApiUrl: 'http://control.test', callerSecret: SECRET, fetch: api.fetchImpl, flushMs: 60_000, onError: (e) => errors.push(e) });
    expect(() => meter.sink(record('tickets_list'))).not.toThrow();
    await meter.flush();
    status = 503;
    await meter.flush();
    expect(errors.map((e) => e.message)).toEqual(['connection refused', 'control API answered HTTP 503']);
    status = 201;
    meter.sink(record('tickets_get'));
    await meter.flush();
    expect(api.posts.map((p) => p.calls.map((c) => c.tool))).toEqual([['tickets_list', 'tickets_get']]);
  });
});
