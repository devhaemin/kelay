// Ticket Board's `overdue-summary` graph (the `summarize_overdue` action):
// collect → (summarize ∥ prioritize) → review, which sends the run back to collect when the two
// branches do not fit together. Every read goes through the Data API as the run's user, so the
// summary covers exactly the tickets that person can see.
import overdueSummary from '@kelay/contracts/fixtures/ticket-board/graph.overdue-summary.json' with { type: 'json' };
import { defineNode, defineNodes, type GraphNodes, type NodeContext } from '@kelay/runtime';
import { anthropicLlm, type AnthropicLlmOptions, type Llm, type OverdueTicket, type Priority } from './llm.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TICKETS = 100;
const MAX_SUMMARY_CHARS = 1500;

export interface CollectOutput {
  asOf: string;
  tickets: OverdueTicket[];
  /** Carried from a rejected review to the next attempt. */
  feedback?: string;
}

export interface SummarizeOutput {
  summary: string;
}

export interface PrioritizeOutput {
  asOf: string;
  tickets: OverdueTicket[];
  priorities: Priority[];
}

export interface ReviewOutput {
  approved: boolean;
  /** Why the review sent the run back; absent when approved. */
  feedback?: string;
  asOf: string;
  summary: string;
  count: number;
  /** The overdue tickets, most urgent first. */
  tickets: (OverdueTicket & { rank: number; reason: string })[];
}

export interface OverdueSummaryOptions {
  /** The model behind summarize and prioritize. Defaults to the Anthropic SDK client of the node's context. */
  llm?: (ctx: NodeContext) => Llm;
  anthropic?: AnthropicLlmOptions;
  now?: () => Date;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

export function createOverdueSummary(opts: OverdueSummaryOptions = {}): GraphNodes {
  const llmFor = opts.llm ?? ((ctx: NodeContext) => anthropicLlm(ctx.llm, ctx.model, opts.anthropic));
  const now = opts.now ?? (() => new Date());

  const collect = defineNode<{ asOf?: unknown; feedback?: unknown } | null, CollectOutput>(async (ctx) => {
    // The start input may pin the time; a rejected review comes back here with its own asOf, so a retry reads the same window.
    const given = text(ctx.input?.asOf);
    const asOf = given && !Number.isNaN(Date.parse(given)) ? new Date(given) : now();
    const rows = await ctx.data.collection('tickets').list({
      where: { due_on: { lt: asOf.toISOString() }, status: { ne: 'done' } },
      orderBy: [{ field: 'due_on', dir: 'asc' }],
      limit: MAX_TICKETS,
    });
    const feedback = text(ctx.input?.feedback);
    return {
      asOf: asOf.toISOString(),
      tickets: rows.map((row) => {
        const due = new Date(text(row.due_on));
        return {
          id: row.id,
          title: text(row.title),
          status: text(row.status),
          due_on: due.toISOString(),
          days_overdue: Math.max(0, Math.floor((asOf.getTime() - due.getTime()) / DAY_MS)),
          assignee_id: text(row.assignee_id) || null,
        };
      }),
      ...(feedback ? { feedback } : {}),
    };
  });

  const summarize = defineNode<CollectOutput, SummarizeOutput>(async (ctx) => {
    const { tickets, asOf, feedback } = ctx.input;
    if (tickets.length === 0) return { summary: 'You have no overdue tickets.' };
    return { summary: await llmFor(ctx).summarize({ tickets, asOf, ...(feedback ? { feedback } : {}) }) };
  });

  const prioritize = defineNode<CollectOutput, PrioritizeOutput>(async (ctx) => {
    const { tickets, asOf, feedback } = ctx.input;
    const priorities = tickets.length === 0 ? [] : await llmFor(ctx).prioritize({ tickets, asOf, ...(feedback ? { feedback } : {}) });
    return { asOf, tickets, priorities };
  });

  // The join: branch outputs arrive in `next` order. No model call; it checks that the two branches agree.
  const review = defineNode<[SummarizeOutput, PrioritizeOutput], ReviewOutput>((ctx) => {
    const [{ summary }, { asOf, tickets, priorities }] = ctx.input;
    const known = new Set(tickets.map((t) => t.id));
    const ranked = new Map<string, Priority>();
    const problems: string[] = [];
    for (const p of priorities) {
      if (!known.has(p.id)) problems.push(`the ranking names a ticket that is not overdue (${p.id})`);
      else if (ranked.has(p.id)) problems.push(`the ranking lists ticket ${p.id} twice`);
      else ranked.set(p.id, p);
    }
    const unranked = tickets.filter((t) => !ranked.has(t.id));
    if (unranked.length > 0) problems.push(`the ranking leaves out ${unranked.map((t) => `"${t.title}"`).join(', ')}`);
    if (!summary.trim()) problems.push('the summary is empty');
    if (summary.length > MAX_SUMMARY_CHARS) problems.push(`the summary is longer than ${MAX_SUMMARY_CHARS} characters`);

    const ordered = [...tickets]
      .sort((a, b) => (ranked.get(a.id)?.rank ?? Infinity) - (ranked.get(b.id)?.rank ?? Infinity) || b.days_overdue - a.days_overdue)
      .map((t, i) => ({ ...t, rank: i + 1, reason: ranked.get(t.id)?.reason ?? '' }));
    return {
      approved: problems.length === 0,
      ...(problems.length > 0 ? { feedback: problems.join('; ') } : {}),
      asOf,
      summary: summary.trim(),
      count: tickets.length,
      tickets: ordered,
    };
  });

  return defineNodes(overdueSummary, { collect, summarize, prioritize, review });
}
