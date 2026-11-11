'use server';
// Server actions are public endpoints: every argument is validated before it reaches the API.
import { AppSlug, PolicyMatrix } from '@kelay/contracts';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect, unstable_rethrow } from 'next/navigation';
import { z } from 'zod';
import type { ActionResult } from '@/lib/action-result';
import { isApiError } from '@/lib/api/errors';
import { TOKEN_COOKIE, getConsoleApi } from '@/lib/api/server';
import type {
  AppPolicy,
  AppSummary,
  ChatMessage,
  ConsoleApi,
  DeployResult,
  FeedbackTicket,
  Grant,
  ImprovementReport,
  Member,
  ProposalDecision,
} from '@/lib/api/types';

const Id = z.string().min(1).max(200);
const Tab = z.enum(['screen', 'access', 'qa', 'agent', 'feedback', 'users', 'monitoring']);
const MemberPatch = z.object({
  role: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/).optional(),
  status: z.enum(['active', 'unconfirmed', 'banned']).optional(),
  plan: z.string().max(60).optional(),
});
const TicketPatch = z.object({
  status: z.enum(['new', 'triaged', 'progress', 'done']).optional(),
  priority: z.enum(['high', 'med', 'low']).optional(),
});
const GrantRequest = z.object({
  from: z.union([AppSlug, z.literal('agents')]),
  to: AppSlug,
  kind: z.enum(['MCP', 'A2A']),
  what: z.string().trim().min(1).max(200),
});

async function run<T>(fn: (api: ConsoleApi) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await fn(await getConsoleApi());
    revalidatePath('/', 'layout');
    return { ok: true, data };
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof z.ZodError) return { ok: false, error: 'That request was not valid.' };
    if (isApiError(e)) return { ok: false, error: e.message };
    console.error(e);
    return { ok: false, error: 'Something went wrong. Try again.' };
  }
}

export async function createAppAction(prompt: string): Promise<ActionResult<AppSummary>> {
  return run((api) => api.createApp({ prompt: z.string().trim().min(1).max(4000).parse(prompt) }));
}

export async function deployAction(app: string, env: 'dev' | 'prod'): Promise<ActionResult<DeployResult>> {
  return run((api) => api.deploy(AppSlug.parse(app), z.enum(['dev', 'prod']).parse(env)));
}

export async function publishAction(app: string): Promise<ActionResult<DeployResult>> {
  return run((api) => api.publish(AppSlug.parse(app)));
}

export async function updateMemberAction(app: string, userId: string, patch: z.input<typeof MemberPatch>): Promise<ActionResult<Member>> {
  return run((api) => api.updateMember(AppSlug.parse(app), Id.parse(userId), MemberPatch.parse(patch)));
}

export async function removeMemberAction(app: string, userId: string): Promise<ActionResult<void>> {
  return run((api) => api.removeMember(AppSlug.parse(app), Id.parse(userId)));
}

export async function sendRecoveryAction(app: string, userId: string): Promise<ActionResult<void>> {
  return run((api) => api.sendPasswordRecovery(AppSlug.parse(app), Id.parse(userId)));
}

export async function updateTicketAction(id: string, patch: z.input<typeof TicketPatch>): Promise<ActionResult<FeedbackTicket>> {
  return run((api) => api.updateTicket(Id.parse(id), TicketPatch.parse(patch)));
}

export async function runReportAction(app: string): Promise<ActionResult<ImprovementReport>> {
  return run((api) => api.runReport(AppSlug.parse(app)));
}

export async function approveProposalAction(id: string): Promise<ActionResult<ProposalDecision>> {
  return run((api) => api.approveProposal(Id.parse(id)));
}

export async function rejectProposalAction(id: string): Promise<ActionResult<ProposalDecision>> {
  return run((api) => api.rejectProposal(Id.parse(id)));
}

export async function reopenProposalAction(id: string): Promise<ActionResult<ProposalDecision>> {
  return run((api) => api.reopenProposal(Id.parse(id)));
}

export async function requestGrantAction(input: z.input<typeof GrantRequest>): Promise<ActionResult<Grant>> {
  return run((api) => api.requestGrant(GrantRequest.parse(input)));
}

export async function allowGrantAction(id: string): Promise<ActionResult<Grant>> {
  return run((api) => api.allowGrant(Id.parse(id)));
}

export async function rejectGrantAction(id: string): Promise<ActionResult<Grant>> {
  return run((api) => api.rejectGrant(Id.parse(id)));
}

export async function revokeConsentAction(id: string): Promise<ActionResult<void>> {
  return run((api) => api.revokeConsent(Id.parse(id)));
}

export async function savePolicyAction(app: string, matrix: unknown): Promise<ActionResult<AppPolicy>> {
  return run((api) => api.savePolicy(AppSlug.parse(app), PolicyMatrix.parse(matrix)));
}

export async function sendBuilderMessageAction(app: string, tab: string, text: string): Promise<ActionResult<ChatMessage[]>> {
  return run((api) => api.sendBuilderMessage(AppSlug.parse(app), Tab.parse(tab), z.string().trim().min(1).max(4000).parse(text)));
}

export async function signInAction(formData: FormData): Promise<void> {
  const token = z.string().trim().min(16).max(8192).safeParse(formData.get('token'));
  if (!token.success) redirect('/signin?error=token');
  (await cookies()).set(TOKEN_COOKIE, token.data, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 12,
  });
  redirect('/');
}

export async function signOutAction(): Promise<void> {
  (await cookies()).delete(TOKEN_COOKIE);
  redirect('/signin');
}
