import { describe, expect, it } from 'vitest';
import { CALLER_HEADER, type NodeInvocation } from '@kelay/contracts';
import overdueSummary from '@kelay/contracts/fixtures/ticket-board/graph.overdue-summary.json' with { type: 'json' };
import {
  DEFAULT_MODEL,
  LlmGatewayNotConfiguredError,
  createLambdaHandler,
  createLocalNodes,
  defineNode,
  defineNodes,
  invokeNode,
  runtimeConfigFromEnv,
  type GraphNodes,
  type NodeContext,
  type RuntimeConfig,
} from './index.ts';

const invocation = (over: Partial<NodeInvocation> = {}): NodeInvocation => ({
  runId: 'run-1',
  app: 'ticket-board',
  env: 'prod',
  graph: 'overdue-summary',
  node: 'collect',
  attempt: 1,
  loop: 0,
  input: { since: '2026-11-01' },
  userToken: 'user.jwt',
  ...over,
});

interface Seen {
  url: string;
  headers: Headers;
  body: any;
}

/** Stands in for the Data API and the LLM gateway, and records what reached each. */
function platform(opts: { cost?: string } = {}) {
  const seen: Seen[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const req = new Request(input as string | URL | Request, init);
    const body = JSON.parse(await req.text());
    seen.push({ url: req.url, headers: req.headers, body });
    if (req.url.includes('/v1/messages')) {
      return new Response(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: 'Two tickets are overdue.' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json', ...(opts.cost ? { 'x-litellm-response-cost': opts.cost } : {}) } },
      );
    }
    return Response.json({ rows: [{ id: 't1', title: 'Q4 roadmap draft' }], count: 1 });
  };
  return { seen, fetch: fetchImpl };
}

const config = (p: { fetch: typeof fetch }, over: Partial<RuntimeConfig> = {}): RuntimeConfig => ({
  dataApiUrl: 'http://data-api.test',
  callerToken: 'caller.jwt',
  llmGatewayUrl: 'http://llm-gateway.test',
  llmGatewayKey: 'sk-kelay-app',
  fetch: p.fetch,
  ...over,
});

/** The fixture graph where every node records its context and echoes its input. */
function recording(over: Partial<GraphNodes['nodes']> = {}) {
  const contexts: NodeContext[] = [];
  const echo = defineNode((ctx) => {
    contexts.push(ctx);
    return { node: ctx.run.node, input: ctx.input };
  });
  return { contexts, graphs: [defineNodes(overdueSummary, { collect: echo, summarize: echo, prioritize: echo, review: echo, ...over })] };
}

describe('defineNodes', () => {
  it('needs code for exactly the nodes of the graph', () => {
    const node = defineNode(() => null);
    expect(() => defineNodes(overdueSummary, { collect: node, summarize: node, prioritize: node })).toThrow('no code for node(s) review');
    expect(() => defineNodes(overdueSummary, { collect: node, summarize: node, prioritize: node, review: node, publish: node })).toThrow('publish');
    expect(() => defineNodes({ name: 'broken', start: 'a', nodes: { a: { next: 'missing' } } }, { a: node })).toThrow();
    expect(defineNodes(overdueSummary, { collect: node, summarize: node, prioritize: node, review: node }).spec.name).toBe('overdue-summary');
  });
});

describe('invokeNode', () => {
  it('gives the node its input, its place in the run, and JSON null for no output', async () => {
    const p = platform();
    const { graphs, contexts } = recording({ review: defineNode(() => undefined) });
    const result = await invokeNode(graphs, invocation(), config(p));
    expect(result).toEqual({ output: { node: 'collect', input: { since: '2026-11-01' } }, usage: { llmCalls: 0 } });
    expect(contexts[0]!.run).toEqual({ runId: 'run-1', app: 'ticket-board', env: 'prod', graph: 'overdue-summary', node: 'collect', attempt: 1, loop: 0 });
    expect(contexts[0]).not.toHaveProperty('userToken');
    expect((await invokeNode(graphs, invocation({ node: 'review', input: undefined }), config(p))).output).toBeNull();
  });

  it('reads and writes data as the run’s user, through the app’s caller token', async () => {
    const p = platform();
    const collect = defineNode(async (ctx) => ctx.data.collection('tickets').list({ where: { status: { ne: 'done' } }, limit: 5 }));
    const { graphs } = recording({ collect });
    const { output } = await invokeNode(graphs, invocation(), config(p));
    expect(output).toEqual([{ id: 't1', title: 'Q4 roadmap draft' }]);
    expect(p.seen).toHaveLength(1);
    expect(p.seen[0]!.url).toBe('http://data-api.test/v1/apps/ticket-board/query');
    expect(p.seen[0]!.headers.get('authorization')).toBe('Bearer user.jwt');
    expect(p.seen[0]!.headers.get(CALLER_HEADER)).toBe('caller.jwt');
    expect(p.seen[0]!.body).toEqual({ op: 'select', collection: 'tickets', where: { status: { ne: 'done' } }, limit: 5 });
  });

  it('picks the model from the graph node, then LLM_MODEL, then claude-opus-5-5', async () => {
    const p = platform();
    const { graphs, contexts } = recording();
    await invokeNode(graphs, invocation({ node: 'summarize' }), config(p, { defaultModel: 'claude-haiku-5-5' }));
    await invokeNode(graphs, invocation({ node: 'collect' }), config(p, { defaultModel: 'claude-haiku-5-5' }));
    await invokeNode(graphs, invocation({ node: 'collect' }), config(p));
    expect(contexts.map((c) => c.model)).toEqual(['claude-opus-5-5', 'claude-haiku-5-5', DEFAULT_MODEL]);
    expect(DEFAULT_MODEL).toBe('claude-opus-5-5');
  });

  it('calls models with the official SDK through the LLM gateway, with the app’s gateway key', async () => {
    const p = platform({ cost: '0.0125' });
    const summarize = defineNode(async (ctx) => {
      const ask = () => ctx.llm.messages.create({ model: ctx.model, max_tokens: 16000, messages: [{ role: 'user', content: 'Summarize the overdue tickets.' }] });
      const [first] = await Promise.all([ask(), ask()]);
      const block = first.content[0];
      return { summary: block?.type === 'text' ? block.text : '' };
    });
    const { graphs } = recording({ summarize });
    const result = await invokeNode(graphs, invocation({ node: 'summarize' }), config(p));
    expect(result.output).toEqual({ summary: 'Two tickets are overdue.' });
    expect(result.usage.llmCalls).toBe(2);
    expect(result.usage.costUsd).toBeCloseTo(0.025);

    const [call] = p.seen;
    expect(call!.url).toBe('http://llm-gateway.test/v1/messages');
    expect(call!.headers.get('authorization')).toBe('Bearer sk-kelay-app');
    expect(call!.headers.get('x-kelay-run')).toBe('run-1');
    expect(call!.headers.get('x-kelay-node')).toBe('summarize');
    expect(call!.body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 16000 });
  });

  it('leaves the cost out when the gateway does not price the call', async () => {
    const p = platform();
    const summarize = defineNode(async (ctx) => (await ctx.llm.messages.create({ model: ctx.model, max_tokens: 256, messages: [{ role: 'user', content: 'hi' }] })).id);
    const result = await invokeNode(recording({ summarize }).graphs, invocation({ node: 'summarize' }), config(p));
    expect(result).toEqual({ output: 'msg_test', usage: { llmCalls: 1 } });
  });

  it('fails with "LLM gateway not configured" only when a node reaches for the model', async () => {
    const p = platform();
    const summarize = defineNode((ctx) => ctx.llm.messages.create({ model: ctx.model, max_tokens: 256, messages: [{ role: 'user', content: 'hi' }] }));
    const { graphs } = recording({ summarize });
    const noGateway = config(p, { llmGatewayUrl: undefined });
    expect((await invokeNode(graphs, invocation(), noGateway)).output).toMatchObject({ node: 'collect' });

    const failure = invokeNode(graphs, invocation({ node: 'summarize' }), noGateway);
    await expect(failure).rejects.toBeInstanceOf(LlmGatewayNotConfiguredError);
    await expect(failure).rejects.toThrow('LLM gateway not configured: LLM_GATEWAY_URL is not set');
    await expect(failure).rejects.toMatchObject({ name: 'Kelay.LlmGatewayNotConfigured' });
    await expect(invokeNode(graphs, invocation({ node: 'summarize' }), config(p, { llmGatewayKey: undefined }))).rejects.toThrow('LLM_GATEWAY_KEY is not set');
    expect(p.seen).toHaveLength(0);
  });

  it('rejects an unknown node and a payload that is not a NodeInvocation', async () => {
    const { graphs } = recording();
    const p = platform();
    await expect(invokeNode(graphs, invocation({ node: 'publish' }), config(p))).rejects.toMatchObject({ name: 'Kelay.UnknownNode' });
    await expect(invokeNode(graphs, invocation({ graph: 'weekly-notes' }), config(p))).rejects.toThrow('weekly-notes');
    await expect(invokeNode(graphs, { node: 'collect' } as NodeInvocation, config(p))).rejects.toThrow('not a NodeInvocation');
  });
});

describe('hosting', () => {
  it('reads the function environment', () => {
    expect(runtimeConfigFromEnv({ DATA_API_URL: 'http://data', KELAY_CALLER_TOKEN: 'caller', LLM_GATEWAY_URL: 'http://llm', LLM_GATEWAY_KEY: 'sk', LLM_MODEL: 'claude-sonnet-5-5' })).toEqual({
      dataApiUrl: 'http://data',
      callerToken: 'caller',
      llmGatewayUrl: 'http://llm',
      llmGatewayKey: 'sk',
      defaultModel: 'claude-sonnet-5-5',
    });
    expect(runtimeConfigFromEnv({ DATA_API_URL: 'http://data', KELAY_CALLER_TOKEN: 'caller' })).toEqual({ dataApiUrl: 'http://data', callerToken: 'caller' });
    expect(() => runtimeConfigFromEnv({ DATA_API_URL: 'http://data' })).toThrow('KELAY_CALLER_TOKEN is not set');
  });

  it('adapts the graphs to a Lambda handler that takes a NodeInvocation and returns the output', async () => {
    const p = platform();
    const handler = createLambdaHandler(recording().graphs, config(p));
    expect(await handler(invocation({ node: 'prioritize', input: [1, 2] }))).toEqual({ node: 'prioritize', input: [1, 2] });
  });

  it('adapts the graphs to the run orchestrator’s local driver, which supplies the caller token', async () => {
    const p = platform();
    const collect = defineNode(async (ctx) => ctx.data.collection('tickets').list());
    const local = createLocalNodes(recording({ collect }).graphs, { DATA_API_URL: 'http://data-api.test' }, { fetch: p.fetch });
    expect(local.graphs.map((g) => g.name)).toEqual(['overdue-summary']);
    const result = await local.invoke(invocation(), { callerToken: 'minted.by.runner', signal: new AbortController().signal });
    expect(result.usage).toEqual({ llmCalls: 0 });
    expect(p.seen[0]!.headers.get(CALLER_HEADER)).toBe('minted.by.runner');
  });
});
