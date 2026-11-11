import { z } from 'zod';
import { EFFORTS, IMPACTS, PRIORITIES, TICKET_TYPES, type ReportStats, type TicketSource } from '../db/schema.ts';

export const TriageLabel = z.object({
  valid: z.boolean().describe('false for noise: spam, empty or test messages, abuse, or text with no actionable request'),
  type: z.enum(TICKET_TYPES).describe('bug: something broken; ux: confusing or awkward; feat: new capability; quality: slow, flaky or unreliable'),
  priority: z.enum(PRIORITIES),
  title: z.string().describe('Short ticket title in the reporter’s language, at most 80 characters'),
});
export type TriageLabel = z.infer<typeof TriageLabel>;

export const ProposalDraft = z.object({
  title: z.string(),
  body: z.string().describe('What to change and why, in two or three sentences'),
  refs: z.array(z.string()).describe('Keys of the tickets this answers, for example FB-131'),
  impact: z.enum(IMPACTS),
  effort: z.enum(EFFORTS),
  affects: z.string().describe('What the change touches, for example "access rule + board filter"'),
});
export type ProposalDraft = z.infer<typeof ProposalDraft>;

export const ReportDraft = z.object({
  summary: z.string().describe('Two or three sentences for the builder'),
  proposals: z.array(ProposalDraft),
});
export type ReportDraft = z.infer<typeof ReportDraft>;

export interface AppInfo {
  slug: string;
  name: string;
  description: string;
}

export interface TriageItem {
  key: string;
  text: string;
  route: string | null;
  source: TicketSource;
}

export interface ReportTicket {
  key: string;
  type: string | null;
  priority: string | null;
  status: string;
  title: string;
  text: string;
  votes: number;
  route: string | null;
}

export interface ReportRequest {
  app: AppInfo;
  date: string;
  tickets: ReportTicket[];
  stats: ReportStats;
}

/** Model calls behind feedback triage and the daily report. Tests use a fake; production uses AnthropicLlm. */
export interface Llm {
  triage(app: AppInfo, item: TriageItem): Promise<TriageLabel>;
  report(req: ReportRequest): Promise<ReportDraft>;
}

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Stands in when the service has no LLM gateway: every model call fails, and says why. */
export function unconfiguredLlm(missing: string): Llm {
  const fail = async (): Promise<never> => {
    throw new LlmError(`LLM gateway not configured: ${missing} is not set, so the Control API cannot call a model`);
  };
  return { triage: fail, report: fail };
}
