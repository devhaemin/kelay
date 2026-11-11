import type Anthropic from '@anthropic-ai/sdk';
import { GraphSpec, type NodeInvocation } from '@kelay/contracts';
import { validateGraph } from '@kelay/graph';
import type { GraphSpecInput, KelayClient } from '@kelay/sdk';

/** Where in the run this invocation sits. */
export type NodeRunInfo = Pick<NodeInvocation, 'runId' | 'app' | 'env' | 'graph' | 'node' | 'attempt' | 'loop'>;

export interface NodeContext<I = unknown> {
  /** The previous node's output; for a join node, the branch outputs in `next` order; for the start node, the run input. */
  input: I;
  /** Data API client acting as the run's user: every read and write goes through that user's RLS. */
  data: KelayClient;
  /**
   * The official Anthropic SDK client, pointed at the LLM gateway with the app's gateway key.
   * Reading it throws LlmGatewayNotConfiguredError when the function has no gateway configured.
   */
  readonly llm: Anthropic;
  /** Model for this node: the graph node's `model`, else LLM_MODEL, else claude-opus-5-5. */
  model: string;
  run: NodeRunInfo;
  /** Aborted when the node timed out or a parallel sibling failed (local runs only). */
  signal?: AbortSignal;
}

export type NodeFn<I = unknown, O = unknown> = (ctx: NodeContext<I>) => O | Promise<O>;

export interface NodeDefinition<I = unknown, O = unknown> {
  run: NodeFn<I, O>;
}

/** Declares one node. The output must be JSON: it becomes the next node's input. */
export function defineNode<I = unknown, O = unknown>(run: NodeFn<I, O>): NodeDefinition<I, O> {
  return { run };
}

export interface GraphNodes {
  spec: GraphSpec;
  // Each node narrows its own input; the handler only ever passes JSON through.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nodes: Record<string, NodeDefinition<any, unknown>>;
}

/** Pairs a graph spec with the code of its nodes. Every node of the spec needs one, and nothing else is accepted. */
export function defineNodes(spec: GraphSpecInput | GraphSpec, nodes: GraphNodes['nodes']): GraphNodes {
  const graph = validateGraph(GraphSpec.parse(structuredClone(spec)));
  const declared = Object.keys(graph.nodes);
  const missing = declared.filter((n) => typeof nodes[n]?.run !== 'function');
  if (missing.length > 0) throw new TypeError(`graph ${graph.name}: no code for node(s) ${missing.join(', ')}`);
  const extra = Object.keys(nodes).filter((n) => !declared.includes(n));
  if (extra.length > 0) throw new TypeError(`graph ${graph.name}: code for node(s) the graph does not have: ${extra.join(', ')}`);
  return { spec: graph, nodes };
}
