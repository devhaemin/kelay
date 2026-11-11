// A deterministic stand-in for the model, so the graph runs in tests and in the e2e stack without a key.
import type { Llm, LlmRequest } from './llm.ts';

export interface FakeLlm extends Llm {
  calls: { op: 'summarize' | 'prioritize'; req: LlmRequest }[];
}

/** Summarizes by counting and ranks by days overdue, longest first. */
export function fakeLlm(): FakeLlm {
  const calls: FakeLlm['calls'] = [];
  return {
    calls,
    async summarize(req) {
      calls.push({ op: 'summarize', req });
      const longest = [...req.tickets].sort((a, b) => b.days_overdue - a.days_overdue)[0]!;
      const n = req.tickets.length;
      return `${n} overdue ticket${n === 1 ? '' : 's'}: ${req.tickets.map((t) => t.title).join(', ')}. "${longest.title}" has waited longest.`;
    },
    async prioritize(req) {
      calls.push({ op: 'prioritize', req });
      return [...req.tickets]
        .sort((a, b) => b.days_overdue - a.days_overdue || a.due_on.localeCompare(b.due_on))
        .map((t, i) => ({ id: t.id, rank: i + 1, reason: `${t.days_overdue} day${t.days_overdue === 1 ? '' : 's'} overdue, in ${t.status}` }));
    },
  };
}
