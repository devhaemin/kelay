// Ticket Board's agent nodes, written against @kelay/runtime. One module serves both hosts:
// `handler` is the node function's Lambda entry (the state machine invokes it with a NodeInvocation),
// and `nodes` is what the run orchestrator's local driver loads (RUNNER_LOCAL_NODES).
import { createLambdaHandler, createLocalNodes } from '@kelay/runtime';
import { createOverdueSummary } from './graph.ts';

export { createOverdueSummary, type CollectOutput, type OverdueSummaryOptions, type PrioritizeOutput, type ReviewOutput, type SummarizeOutput } from './graph.ts';
export { LlmError, anthropicLlm, type AnthropicLlmOptions, type Llm, type LlmRequest, type OverdueTicket, type Priority } from './llm.ts';

// LLM_FALLBACKS=off for a gateway that does not forward beta parameters, as in the control API.
export const graphs = [createOverdueSummary({ anthropic: { fallbacks: process.env.LLM_FALLBACKS !== 'off' } })];

export const handler = createLambdaHandler(graphs);

export const nodes = createLocalNodes(graphs);
