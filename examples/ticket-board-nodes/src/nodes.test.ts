import { describe, expect, it } from 'vitest';
import { CALLER_HEADER, type NodeInvocation } from '@kelay/contracts';
import { runLocal } from '@kelay/graph';
import { LlmGatewayNotConfiguredError, invokeNode, type GraphNodes, type RuntimeConfig } from '@kelay/runtime';
import { LlmError, createOverdueSummary, graphs, handler, nodes, type Llm, type OverdueTicket, type ReviewOutput } from './index.ts';
import { fakeLlm } from './testing.ts';

const NOW = new Date('2026-11-11T09:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

const ROWS = [
  { id: 't-roadmap', title: 'Q4 roadmap draft', status: 'doing', due_on: daysAgo(1), assignee_id: 'u_junho' },
  { id: 't-notes', title: 'Customer interview notes', status: 'review', due_on: daysAgo(3), assignee_id: 'u_junho' },
];

interface Seen {
  url: string;
  headers: Headers;
  body: any;
}

/** A Data API that answers every query with `rows`, and an LLM gateway that answers with `reply`. */
function platform(opts: { rows?: object[]; reply?: (body: any) => { text?: string; stop_reason?: string; stop_details?: unknown } } = {}) {
  const queries: Seen[] = [];
  const modelCalls: Seen[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const req = new Request(input as string | URL | Request, init);
    const body = JSON.parse(await req.text());
    if (!req.url.includes('/v1/messages')) {
      queries.push({ url: req.url, headers: req.headers, body });
      return Response.json({ rows: opts.rows ?? ROWS, count: (opts.rows ?? ROWS).length });
    }
    modelCalls.push({ url: req.url, headers: req.headers, body });
    const r = opts.reply?.(body) ?? {};
    return Response.json({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: r.text === undefined ? [] : [{ type: 'text', text: r.text }],
      stop_reason: r.stop_reason ?? 'end_turn',
      stop_sequence: null,
      stop_details: r.stop_details ?? null,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  };
  return { queries, modelCalls, fetch: fetchImpl };
}

const config = (p: { fetch: typeof fetch }, over: Partial<RuntimeConfig> = {}): RuntimeConfig => ({
  dataApiUrl: 'http://data-api.test',
  callerToken: 'caller.jwt',
  llmGatewayUrl: 'http://llm-gateway.test',
  llmGatewayKey: 'sk-kelay-app',
  fetch: p.fetch,
  ...over,
});

/** Runs the whole graph the way the run orchestrator's local driver does. */
async function run(graph: GraphNodes, cfg: RuntimeConfig, input: unknown = {}) {
  return runLocal(graph.spec, async (invocation) => (await invokeNode([graph], invocation, cfg)).output, {
    input,
    userToken: 'junho.jwt',
    app: 'ticket-board',
    env: 'prod',
  });
}

describe('overdue-summary with the model test double', () => {
  it('collects the user’s overdue tickets, summarizes and ranks them, and approves', async () => {
    const p = platform();
    const llm = fakeLlm();
    const result = await run(createOverdueSummary({ llm: () => llm, now: () => NOW }), config(p));

    expect(result.trace.map((t) => `${t.node}:${t.status}`)).toEqual(['collect:ok', 'summarize:ok', 'prioritize:ok', 'review:ok']);
    const output = result.output as ReviewOutput;
    expect(output).toMatchObject({
      approved: true,
      asOf: NOW.toISOString(),
      count: 2,
      summary: '2 overdue tickets: Q4 roadmap draft, Customer interview notes. "Customer interview notes" has waited longest.',
    });
    expect(output).not.toHaveProperty('feedback');
    expect(output.tickets.map((t) => [t.rank, t.id, t.days_overdue, t.reason])).toEqual([
      [1, 't-notes', 3, '3 days overdue, in review'],
      [2, 't-roadmap', 1, '1 day overdue, in doing'],
    ]);

    // One read, as the user: RLS decides which tickets come back.
    expect(p.queries).toHaveLength(1);
    expect(p.queries[0]!.url).toBe('http://data-api.test/v1/apps/ticket-board/query');
    expect(p.queries[0]!.headers.get('authorization')).toBe('Bearer junho.jwt');
    expect(p.queries[0]!.headers.get(CALLER_HEADER)).toBe('caller.jwt');
    expect(p.queries[0]!.body).toEqual({
      op: 'select',
      collection: 'tickets',
      where: { due_on: { lt: NOW.toISOString() }, status: { ne: 'done' } },
      orderBy: [{ field: 'due_on', dir: 'asc' }],
      limit: 100,
    });
    expect(llm.calls.map((c) => c.op).sort()).toEqual(['prioritize', 'summarize']);
    expect(p.modelCalls).toHaveLength(0);
  });

  it('answers without a model call when nothing is overdue', async () => {
    const p = platform({ rows: [] });
    const llm = fakeLlm();
    const { output } = await run(createOverdueSummary({ llm: () => llm, now: () => NOW }), config(p, { llmGatewayUrl: undefined }));
    expect(output).toEqual({ approved: true, asOf: NOW.toISOString(), summary: 'You have no overdue tickets.', count: 0, tickets: [] });
    expect(llm.calls).toEqual([]);
  });

  it('goes back to collect with the review’s feedback when the ranking misses a ticket', async () => {
    const p = platform();
    const base = fakeLlm();
    const feedbackSeen: (string | undefined)[] = [];
    const forgetful: Llm = {
      summarize: (req) => base.summarize(req),
      async prioritize(req) {
        feedbackSeen.push(req.feedback);
        const all = await base.prioritize(req);
        return req.feedback ? all : all.slice(0, 1);
      },
    };
    const result = await run(createOverdueSummary({ llm: () => forgetful, now: () => NOW }), config(p), { asOf: daysAgo(0) });
    expect(result.trace.map((t) => `${t.node}@${t.loop}`)).toEqual(['collect@0', 'summarize@0', 'prioritize@0', 'review@0', 'collect@1', 'summarize@1', 'prioritize@1', 'review@1']);
    expect(feedbackSeen).toEqual([undefined, 'the ranking leaves out "Q4 roadmap draft"']);
    expect(result.trace[3]!.output).toMatchObject({ approved: false, feedback: 'the ranking leaves out "Q4 roadmap draft"' });
    expect(result.output).toMatchObject({ approved: true, count: 2 });
    // The retry reads the same window as the first attempt.
    expect(p.queries.map((q) => q.body.where.due_on.lt)).toEqual([NOW.toISOString(), NOW.toISOString()]);
  });

  it('rejects a ranking that invents or repeats a ticket', async () => {
    const p = platform();
    const tickets: OverdueTicket[] = ROWS.map((r) => ({ ...r, days_overdue: 1 }));
    const review = (priorities: { id: string; rank: number; reason: string }[]) =>
      invokeNode(
        [createOverdueSummary({ llm: () => fakeLlm() })],
        { runId: 'r', app: 'ticket-board', env: 'prod', graph: 'overdue-summary', node: 'review', attempt: 1, loop: 0, userToken: 'junho.jwt', input: [{ summary: 'Two.' }, { asOf: NOW.toISOString(), tickets, priorities }] },
        config(p),
      );
    const twice = (await review([{ id: 't-notes', rank: 1, reason: '' }, { id: 't-notes', rank: 2, reason: '' }, { id: 't-roadmap', rank: 3, reason: '' }])).output as ReviewOutput;
    expect(twice).toMatchObject({ approved: false, feedback: 'the ranking lists ticket t-notes twice' });
    const invented = (await review([{ id: 't-notes', rank: 1, reason: '' }, { id: 't-roadmap', rank: 2, reason: '' }, { id: 't-ghost', rank: 3, reason: '' }])).output as ReviewOutput;
    expect(invented.feedback).toBe('the ranking names a ticket that is not overdue (t-ghost)');
  });
});

describe('overdue-summary with the Anthropic SDK behind the LLM gateway', () => {
  const invocation = (node: string, input: unknown): NodeInvocation => ({ runId: 'run-1', app: 'ticket-board', env: 'prod', graph: 'overdue-summary', node, attempt: 1, loop: 0, userToken: 'junho.jwt', input });
  const collected = { asOf: NOW.toISOString(), tickets: ROWS.map((r, i) => ({ ...r, days_overdue: i === 0 ? 1 : 3 })) };

  it('summarizes and ranks through the gateway with the graph node’s model', async () => {
    const ranking = { priorities: [{ id: 't-notes', rank: 1, reason: 'Nearly done.' }, { id: 't-roadmap', rank: 2, reason: 'One day late.' }] };
    const p = platform({ reply: (body) => ({ text: body.output_config?.format ? JSON.stringify(ranking) : '  Two tickets are overdue; finish the interview notes first.  ' }) });

    const summarized = await invokeNode(graphs, invocation('summarize', collected), config(p));
    expect(summarized.output).toEqual({ summary: 'Two tickets are overdue; finish the interview notes first.' });
    expect(summarized.usage.llmCalls).toBe(1);
    const [summarize] = p.modelCalls;
    expect(summarize!.url).toBe('http://llm-gateway.test/v1/messages');
    expect(summarize!.headers.get('authorization')).toBe('Bearer sk-kelay-app');
    expect(summarize!.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(summarize!.body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 16000, fallbacks: 'default', output_config: { effort: 'low' } });
    expect(summarize!.body).not.toHaveProperty('thinking');
    expect(summarize!.body.system).toContain('untrusted');
    expect(summarize!.body.messages[0].content).toContain('<tickets>');
    expect(summarize!.body.messages[0].content).toContain('"title":"Q4 roadmap draft"');
    expect(summarize!.body.messages[0].content).not.toContain('u_junho');

    const prioritized = await invokeNode(graphs, invocation('prioritize', { ...collected, feedback: 'the ranking leaves out "Q4 roadmap draft"' }), config(p));
    expect(prioritized.output).toMatchObject({ priorities: ranking.priorities, tickets: collected.tickets });
    const prioritize = p.modelCalls[1]!;
    expect(prioritize.body.output_config).toMatchObject({ effort: 'low', format: { type: 'json_schema' } });
    expect(prioritize.body.messages[0].content).toContain('A reviewer rejected the previous attempt');
  });

  it('can leave the fallback beta out for a gateway that does not forward it', async () => {
    const p = platform({ reply: () => ({ text: 'One ticket is overdue.' }) });
    await invokeNode([createOverdueSummary({ anthropic: { fallbacks: false } })], invocation('summarize', collected), config(p));
    expect(p.modelCalls[0]!.body).not.toHaveProperty('fallbacks');
    expect(p.modelCalls[0]!.headers.get('anthropic-beta') ?? '').not.toContain('server-side-fallback');
  });

  it('fails the node when the model declines, runs out of tokens or breaks the schema', async () => {
    const failing = (reply: () => { text?: string; stop_reason?: string; stop_details?: unknown }, node = 'summarize') =>
      invokeNode(graphs, invocation(node, collected), config(platform({ reply })));
    await expect(failing(() => ({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } }))).rejects.toThrow('model declined (cyber)');
    await expect(failing(() => ({ text: 'Two ti', stop_reason: 'max_tokens' }))).rejects.toThrow('max_tokens');
    await expect(failing(() => ({ text: '' }))).rejects.toBeInstanceOf(LlmError);
    await expect(failing(() => ({ text: '{"priorities":"none"}' }), 'prioritize')).rejects.toBeInstanceOf(LlmError);
  });

  it('fails with "LLM gateway not configured" when the function has no gateway', async () => {
    const p = platform();
    const failure = invokeNode(graphs, invocation('summarize', collected), config(p, { llmGatewayUrl: undefined, llmGatewayKey: undefined }));
    await expect(failure).rejects.toBeInstanceOf(LlmGatewayNotConfiguredError);
    await expect(failure).rejects.toThrow('LLM gateway not configured');
    expect(p.modelCalls).toHaveLength(0);
  });
});

describe('module entry points', () => {
  it('exports the Lambda handler and the local-driver nodes for the same graph', () => {
    expect(typeof handler).toBe('function');
    expect(nodes.graphs.map((g) => g.name)).toEqual(['overdue-summary']);
    expect(Object.keys(graphs[0]!.nodes)).toEqual(['collect', 'summarize', 'prioritize', 'review']);
  });
});
