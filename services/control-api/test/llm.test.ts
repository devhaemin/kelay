import { describe, expect, it } from 'vitest';
import { AnthropicLlm } from '../src/llm/anthropic.ts';
import { LlmError } from '../src/llm/types.ts';

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, any>;
}

/** Answers like the Messages API behind the LLM gateway and records each request. */
function gateway(reply: (body: Record<string, any>) => { text?: string; stop_reason?: string; stop_details?: unknown }) {
  const calls: Captured[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const req = new Request(input as string | URL | Request, init);
    const body = JSON.parse(await req.text());
    calls.push({ url: req.url, headers: req.headers, body });
    const r = reply(body);
    return new Response(
      JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: r.text === undefined ? [] : [{ type: 'text', text: r.text }],
        stop_reason: r.stop_reason ?? 'end_turn',
        stop_sequence: null,
        stop_details: r.stop_details ?? null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } },
    );
  };
  return { calls, fetch: fetchImpl };
}

const app = { slug: 'ticket-board', name: 'Ticket Board', description: 'Jira-style board' };

describe('AnthropicLlm', () => {
  it('triages through the gateway with structured output, low effort and refusal fallback', async () => {
    const gw = gateway(() => ({ text: JSON.stringify({ valid: true, type: 'feat', priority: 'high', title: 'Show only my tickets' }) }));
    const llm = new AnthropicLlm({ baseURL: 'http://gateway.test:4000', apiKey: 'sk-kelay-dev', fetch: gw.fetch, maxRetries: 0 });
    const label = await llm.triage(app, { key: 'FB-1', text: 'I only want to see my tickets', route: '/board', source: 'in-app' });
    expect(label).toEqual({ valid: true, type: 'feat', priority: 'high', title: 'Show only my tickets' });

    const [call] = gw.calls;
    expect(call!.url).toMatch(/^http:\/\/gateway\.test:4000\/v1\/messages/);
    expect(call!.headers.get('authorization')).toBe('Bearer sk-kelay-dev');
    expect(call!.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(call!.body).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', output_config: { effort: 'low', format: { type: 'json_schema' } } });
    expect(call!.body.thinking).toBeUndefined();
    const schema = call!.body.output_config.format.schema;
    expect(schema.properties.type.enum).toEqual(['bug', 'ux', 'feat', 'quality']);
    expect(schema.additionalProperties).toBe(false);
    expect(call!.body.messages[0].content).toContain('<feedback>\nI only want to see my tickets\n</feedback>');
  });

  it('writes the report with the report model override and no fallback when turned off', async () => {
    const draft = {
      summary: 'People see too much.',
      proposals: [{ title: 'Members see only their own tickets', body: 'Add an access rule.', refs: ['FB-131'], impact: 'High', effort: 'S', affects: 'access rule + board filter' }],
    };
    const gw = gateway(() => ({ text: JSON.stringify(draft) }));
    const llm = new AnthropicLlm({ baseURL: 'http://gateway.test:4000', apiKey: 'k', reportModel: 'claude-sonnet-5-5', fallbacks: false, fetch: gw.fetch, maxRetries: 0 });
    const out = await llm.report({
      app,
      date: '2026-11-11',
      tickets: [{ key: 'FB-131', type: 'feat', priority: 'high', status: 'triaged', title: 'I only want to see my tickets', text: '200 tickets and 5 are mine', votes: 6, route: null }],
      stats: { window: { from: '', to: '' }, received: 14, valid: 8, mergedOrNoise: 6, open: 1, byType: {}, byPriority: {}, metrics: { actionsToday: 210 } },
    });
    expect(out).toEqual(draft);
    const body = gw.calls[0]!.body;
    expect(body).toMatchObject({ model: 'claude-sonnet-5-5', output_config: { effort: 'medium' } });
    expect(body.fallbacks).toBeUndefined();
    expect(body.messages[0].content).toContain('"key":"FB-131"');
    expect(body.messages[0].content).toContain('14 received, 8 valid, 6 merged or noise');
  });

  it('turns refusals and truncated output into LlmError', async () => {
    const refusing = new AnthropicLlm({
      baseURL: 'http://gateway.test:4000',
      apiKey: 'k',
      maxRetries: 0,
      fetch: gateway(() => ({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null } })).fetch,
    });
    await expect(refusing.triage(app, { key: 'FB-2', text: 'x', route: null, source: 'email' })).rejects.toThrow(LlmError);

    const truncated = new AnthropicLlm({
      baseURL: 'http://gateway.test:4000',
      apiKey: 'k',
      maxRetries: 0,
      fetch: gateway(() => ({ text: '{"valid": tr', stop_reason: 'max_tokens' })).fetch,
    });
    await expect(truncated.triage(app, { key: 'FB-3', text: 'x', route: null, source: 'chat' })).rejects.toThrow(LlmError);
  });
});
