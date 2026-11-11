// Ticket Board's agent nodes for the e2e run: examples/ticket-board-nodes with one difference. The
// real module calls the model through the LLM gateway; this one uses the package's deterministic
// test double, so the run orchestrator executes the real graph and the real data reads without a
// provider key. No model is called.
import { createLocalNodes } from '@kelay/runtime';
import { createOverdueSummary } from '@kelay/ticket-board-nodes';
import { fakeLlm } from '@kelay/ticket-board-nodes/testing';

const llm = fakeLlm();

export const nodes = createLocalNodes([createOverdueSummary({ llm: () => llm })]);
