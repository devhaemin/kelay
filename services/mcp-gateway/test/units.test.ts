import { describe, expect, it, vi } from 'vitest';
import { AppSchema } from '@kelay/contracts';
import { authorizationServerMetadataUrl } from '../src/agent-card.ts';
import { stdoutMeter } from '../src/metering.ts';
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

  it('writes metering records as one JSON line on stdout', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stdoutMeter({ type: 'mcp_call', app: 'a', sub: 's', client: 'c', tool: 't', ms: 1, ok: true });
    expect(write).toHaveBeenCalledWith('{"type":"mcp_call","app":"a","sub":"s","client":"c","tool":"t","ms":1,"ok":true}\n');
    write.mockRestore();
  });
});
