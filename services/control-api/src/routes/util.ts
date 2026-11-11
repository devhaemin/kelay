import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Principal } from '../auth.ts';
import type { Executor } from '../db/client.ts';
import { apps, type AppRow, type TicketRow, type VersionRow } from '../db/schema.ts';
import { ApiError } from '../errors.ts';

const hook = (result: { success: boolean; error?: unknown }) => {
  if (!result.success) throw new ApiError('invalid_request', z.prettifyError(result.error as z.ZodError));
};

export const jsonBody = <T extends z.ZodType>(schema: T) => zValidator('json', schema, hook);
export const queryParams = <T extends z.ZodType>(schema: T) => zValidator('query', schema, hook);

/** Loads an app for a builder (must own it) or a platform service (any app). Archived apps are gone. */
export async function loadApp(db: Executor, slug: string, principal: Principal): Promise<AppRow> {
  const row = await db.query.apps.findFirst({ where: eq(apps.slug, slug) });
  if (!row || row.status === 'archived') throw new ApiError('unknown_app', `unknown app ${slug}`);
  if (principal.kind === 'builder' && row.owner !== principal.user.sub) throw new ApiError('denied', 'you do not own this app');
  if (principal.kind === 'user') throw new ApiError('denied', 'builder access required');
  return row;
}

export const actorOf = (p: Principal): string => (p.kind === 'service' ? `service:${p.caller.svc ?? 'unknown'}` : p.user.sub);

export function appView(a: AppRow) {
  return {
    slug: a.slug,
    handle: a.handle,
    owner: a.owner,
    name: a.name,
    description: a.description,
    emoji: a.emoji,
    color: a.color,
    status: a.status,
    listed: a.listed,
    path: `/${a.handle}/${a.slug}`,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

export function versionView(v: VersionRow) {
  return {
    id: v.id,
    app: v.app,
    env: v.env,
    number: v.number,
    label: `v${v.number}`,
    commit: v.codeCommit,
    artifactUrl: v.artifactUrl,
    configVersion: v.configVersion,
    lambdaVersion: v.lambdaVersion,
    resources: v.resources,
    sourceVersionId: v.sourceVersionId,
    createdBy: v.createdBy,
    createdAt: v.createdAt,
  };
}

export function ticketView(t: TicketRow, extra: { replies?: number; duplicateOfKey?: string | null } = {}) {
  return {
    id: t.id,
    key: t.key,
    app: t.app,
    type: t.type,
    title: t.title,
    text: t.text,
    route: t.route,
    context: t.context,
    source: t.source,
    votes: t.votes,
    status: t.status,
    priority: t.priority,
    valid: t.valid,
    duplicateOf: extra.duplicateOfKey ?? null,
    reporter: t.reporter,
    reporterOrg: t.reporterOrg,
    fixedIn: t.fixedIn,
    replies: extra.replies ?? 0,
    triagedAt: t.triagedAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}
