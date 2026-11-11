// The two ways node code is hosted: as the app's node Lambda, which Step Functions invokes with a
// NodeInvocation payload, and inside the run orchestrator's local driver.
import type { GraphSpec, NodeInvocation } from '@kelay/contracts';
import type { GraphNodes } from './define.ts';
import { invokeNode, runtimeConfigFromEnv, type NodeResult, type RuntimeConfig, type RuntimeEnv } from './invoke.ts';

export type NodeHandler = (event: NodeInvocation) => Promise<unknown>;

/**
 * The node function's Lambda handler: `export const handler = createLambdaHandler(graphs)`.
 * Its result is the node's output, which the state machine hands to the next state. A thrown error
 * fails the invocation under the error's name, which is what the graph's retry rules match on.
 */
export function createLambdaHandler(graphs: GraphNodes[], config?: RuntimeConfig): NodeHandler {
  let resolved = config;
  return async (event) => {
    // Read on the first invocation, so a missing variable fails that run with a clear message instead of the cold start.
    resolved ??= runtimeConfigFromEnv();
    return (await invokeNode(graphs, event, resolved)).output;
  };
}

/** What the run orchestrator hands a node it hosts, next to the invocation. */
export interface LocalNodeHost {
  callerToken: string;
  signal: AbortSignal;
}

/** The shape the run orchestrator's local driver loads (`RUNNER_LOCAL_NODES`). */
export interface LocalNodes {
  graphs: GraphSpec[];
  invoke(invocation: NodeInvocation, host: LocalNodeHost): Promise<NodeResult>;
}

/**
 * Node code for the run orchestrator's local driver: `export const nodes = createLocalNodes(graphs)`.
 * The orchestrator supplies the caller token; the rest comes from its environment, as it would from
 * the function's environment in AWS.
 */
export function createLocalNodes(graphs: GraphNodes[], env: RuntimeEnv = process.env, overrides: Partial<RuntimeConfig> = {}): LocalNodes {
  return {
    graphs: graphs.map((g) => g.spec),
    invoke: (invocation, host) =>
      invokeNode(graphs, invocation, { ...runtimeConfigFromEnv({ ...env, KELAY_CALLER_TOKEN: host.callerToken }), ...overrides }, { signal: host.signal }),
  };
}
