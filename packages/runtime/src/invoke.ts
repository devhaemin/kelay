import Anthropic from '@anthropic-ai/sdk';
import type { NodeInvocation } from '@kelay/contracts';
import { createKelayClient } from '@kelay/sdk';
import { z } from 'zod';
import type { GraphNodes, NodeContext } from './define.ts';

/** Contract §12. */
export const DEFAULT_MODEL = 'claude-opus-5-5';

/** LiteLLM answers every priced call with its cost in USD. */
const COST_HEADER = 'x-litellm-response-cost';

export interface RuntimeConfig {
  /** DATA_API_URL */
  dataApiUrl: string;
  /** The app-runtime caller token of this app × env (KELAY_CALLER_TOKEN in a deployed function). */
  callerToken: string;
  /** LLM_GATEWAY_URL. Without it, or without the key, `ctx.llm` throws. */
  llmGatewayUrl?: string;
  /** LLM_GATEWAY_KEY: the app's gateway key, never a provider key. */
  llmGatewayKey?: string;
  /** LLM_MODEL: model for nodes whose graph entry names none. */
  defaultModel?: string;
  /** Transport for Data API and gateway calls. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

export type RuntimeEnv = Record<string, string | undefined>;

/** Reads the environment the deploy driver gives every app function. */
export function runtimeConfigFromEnv(env: RuntimeEnv = process.env): RuntimeConfig {
  const need = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`@kelay/runtime: ${name} is not set in this function's environment`);
    return value;
  };
  return {
    dataApiUrl: need('DATA_API_URL'),
    callerToken: need('KELAY_CALLER_TOKEN'),
    ...(env.LLM_GATEWAY_URL ? { llmGatewayUrl: env.LLM_GATEWAY_URL } : {}),
    ...(env.LLM_GATEWAY_KEY ? { llmGatewayKey: env.LLM_GATEWAY_KEY } : {}),
    ...(env.LLM_MODEL ? { defaultModel: env.LLM_MODEL } : {}),
  };
}

export class LlmGatewayNotConfiguredError extends Error {
  constructor(missing: string) {
    super(`LLM gateway not configured: ${missing} is not set, so this node cannot call a model`);
    this.name = 'Kelay.LlmGatewayNotConfigured';
  }
}

export class UnknownNodeError extends Error {
  constructor(graph: string, node: string) {
    super(`this function has no code for node "${node}" of graph "${graph}"`);
    this.name = 'Kelay.UnknownNode';
  }
}

export interface NodeUsage {
  /** Requests the node sent to the LLM gateway. */
  llmCalls: number;
  /** Their cost, when the gateway priced at least one of them. */
  costUsd?: number;
}

export interface NodeResult {
  output: unknown;
  usage: NodeUsage;
}

const Invocation = z.object({
  runId: z.string().min(1),
  app: z.string().min(1),
  env: z.enum(['dev', 'prod']),
  graph: z.string().min(1),
  node: z.string().min(1),
  attempt: z.number().int().min(1),
  loop: z.number().int().min(0),
  input: z.unknown(),
  userToken: z.string().min(1),
});

/** Runs one node invocation: builds its context, calls the node, and reports what it spent on models. */
export async function invokeNode(graphs: GraphNodes[], event: NodeInvocation, config: RuntimeConfig, opts: { signal?: AbortSignal } = {}): Promise<NodeResult> {
  const parsed = Invocation.safeParse(event);
  if (!parsed.success) throw new TypeError(`not a NodeInvocation: ${z.prettifyError(parsed.error)}`);
  const invocation = parsed.data;
  const graph = graphs.find((g) => g.spec.name === invocation.graph);
  const node = graph && Object.hasOwn(graph.nodes, invocation.node) ? graph.nodes[invocation.node] : undefined;
  if (!graph || !node) throw new UnknownNodeError(invocation.graph, invocation.node);

  const doFetch: typeof fetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const usage: NodeUsage = { llmCalls: 0 };
  const meteredFetch: typeof fetch = async (input, init) => {
    usage.llmCalls++;
    const res = await doFetch(input, init);
    const cost = Number(res.headers.get(COST_HEADER) ?? Number.NaN);
    if (Number.isFinite(cost) && cost >= 0) usage.costUsd = (usage.costUsd ?? 0) + cost;
    return res;
  };

  let llm: Anthropic | undefined;
  const { input, userToken, ...run } = invocation;
  const ctx: NodeContext = {
    input: input ?? null,
    data: createKelayClient({
      dataApiUrl: config.dataApiUrl,
      app: invocation.app,
      getUserToken: () => userToken,
      getCallerToken: () => config.callerToken,
      fetch: doFetch,
    }),
    get llm(): Anthropic {
      if (!config.llmGatewayUrl) throw new LlmGatewayNotConfiguredError('LLM_GATEWAY_URL');
      if (!config.llmGatewayKey) throw new LlmGatewayNotConfiguredError('LLM_GATEWAY_KEY');
      llm ??= new Anthropic({
        baseURL: config.llmGatewayUrl,
        apiKey: config.llmGatewayKey,
        fetch: meteredFetch,
        // The gateway's cost records carry the run they belong to.
        defaultHeaders: { 'x-kelay-app': run.app, 'x-kelay-env': run.env, 'x-kelay-run': run.runId, 'x-kelay-node': run.node },
      });
      return llm;
    },
    model: graph.spec.nodes[invocation.node]?.model ?? config.defaultModel ?? DEFAULT_MODEL,
    run,
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  const output = await node.run(ctx);
  return { output: output === undefined ? null : output, usage };
}
