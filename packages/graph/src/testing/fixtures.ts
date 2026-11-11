import { GraphSpec } from '@kelay/contracts';
import overdueSummary from '@kelay/contracts/fixtures/ticket-board/graph.overdue-summary.json' with { type: 'json' };

/** collect → (summarize ∥ prioritize) → review, which rejects back to collect at most twice. */
export const overdueSummaryGraph = (): GraphSpec => GraphSpec.parse(structuredClone(overdueSummary));
