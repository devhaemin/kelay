// The Access tab: the app's schema and access rules, saving edited rules as a draft version, and
// "preview as" a member against the real app database.
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Op, PolicyMatrix, type AppSchema, type CollectionDef, type Scope } from '@kelay/contracts';
import { PolicyError, ownerFieldOf, policyDefinition, validatePolicy } from '@kelay/policy';
import { actAs, appTable, isSchemaMismatch, rolledBack } from '../appdb.ts';
import { requireBuilder, type AppEnv } from '../auth.ts';
import type { Executor } from '../db/client.ts';
import { appMembers, apps, ENV_NAMES, versions, type VersionRow } from '../db/schema.ts';
import type { Ctx } from '../deps.ts';
import { ApiError } from '../errors.ts';
import { actorOf, jsonBody, loadApp, loadEnv } from './util.ts';

const PREVIEW_ROWS = 50;

const SavePolicy = z.object({ policy: PolicyMatrix });
const PreviewBody = z.object({ as: z.string().min(1).max(200), env: z.enum(ENV_NAMES).optional() });

/** The access rules saved for an app and not deployed yet, if any. */
export const findDraft = (db: Executor, app: string): Promise<VersionRow | undefined> =>
  db.query.versions.findFirst({ where: and(eq(versions.app, app), eq(versions.env, 'dev'), eq(versions.status, 'draft')) });

const versionRef = (v: VersionRow) => ({ id: v.id, number: v.number, label: `v${v.number}`, createdBy: v.createdBy, createdAt: v.createdAt });

function accessView(active: VersionRow & { schema: AppSchema }, draft: VersionRow | undefined) {
  return {
    schema: active.schema,
    policy: active.policy ?? {},
    /** Reserved for "this rule came from FB-131"; nothing records that link yet. */
    notes: [] as { role: string; collection: string; op: Op; from: string }[],
    version: versionRef(active),
    draft: draft ? { ...versionRef(draft), policy: draft.policy ?? {} } : null,
  };
}

/** Throws `invalid_request` listing every problem when the matrix does not fit the schema. */
export function checkPolicy(schema: AppSchema, policy: unknown): PolicyMatrix {
  try {
    return validatePolicy(schema, policy);
  } catch (e) {
    if (e instanceof PolicyError) throw new ApiError('invalid_request', e.message);
    throw e;
  }
}

type RowFlags = { kelay_can_update: boolean; kelay_can_delete: boolean };

function sampleRow(c: CollectionDef, row: Record<string, unknown> & RowFlags) {
  const labelField =
    Object.entries(c.fields).find(([, f]) => f.type === 'text' && f.required)?.[0] ?? Object.entries(c.fields).find(([, f]) => f.type === 'text')?.[0];
  const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return {
    id: String(row.id),
    label: (labelField ? text(row[labelField]) : null) ?? String(row.id),
    ownerId: text(row[ownerFieldOf(c)]),
    createdBy: text(row.owner_id),
    shared: row.shared === true,
    canUpdate: row.kelay_can_update,
    canDelete: row.kelay_can_delete,
  };
}

export function policyRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();
  const { db } = ctx;
  const builder = requireBuilder(ctx.auth);

  const activeDev = async (app: string): Promise<VersionRow & { schema: AppSchema }> => {
    const { version } = await loadEnv(db, app, 'dev');
    if (!version?.schema) throw new ApiError('not_found', `app ${app} has no schema deployed to dev yet`);
    return version as VersionRow & { schema: AppSchema };
  };

  r.get('/v1/apps/:app/schema', builder, async (c) => {
    const app = await loadApp(db, c.req.param('app'), c.get('principal'));
    const active = await activeDev(app.slug);
    return c.json(accessView(active, await findDraft(db, app.slug)));
  });

  r.put('/v1/apps/:app/policy', builder, jsonBody(SavePolicy), async (c) => {
    const principal = c.get('principal');
    const app = await loadApp(db, c.req.param('app'), principal);
    const active = await activeDev(app.slug);
    const policy = checkPolicy(active.schema, c.req.valid('json').policy);
    const actor = actorOf(principal);
    const draft = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(versions)
        .set({ policy, createdBy: actor, createdAt: ctx.now() })
        .where(and(eq(versions.app, app.slug), eq(versions.env, 'dev'), eq(versions.status, 'draft')))
        .returning();
      if (updated) return updated;
      const [seq] = await tx
        .update(apps)
        .set({ versionSeq: sql`${apps.versionSeq} + 1`, updatedAt: ctx.now() })
        .where(eq(apps.slug, app.slug))
        .returning({ n: apps.versionSeq });
      const [created] = await tx
        .insert(versions)
        .values({
          app: app.slug,
          env: 'dev',
          number: seq!.n,
          status: 'draft',
          codeCommit: active.codeCommit,
          artifactUrl: active.artifactUrl,
          configVersion: active.configVersion,
          lambdaVersion: active.lambdaVersion,
          resources: active.resources,
          schema: active.schema,
          policy,
          graphs: active.graphs,
          sourceVersionId: active.id,
          createdBy: actor,
        })
        .returning();
      return created!;
    });
    ctx.logger.info({ type: 'policy_saved', app: app.slug, draft: draft.number, by: actor }, 'access rules saved as a draft');
    return c.json(accessView(active, draft));
  });

  r.post('/v1/apps/:app/policy/preview', builder, jsonBody(PreviewBody), async (c) => {
    const app = await loadApp(db, c.req.param('app'), c.get('principal'));
    const body = c.req.valid('json');
    const envName = body.env ?? 'dev';
    const { env, version } = await loadEnv(db, app.slug, envName);
    if (!version?.schema) throw new ApiError('not_found', `app ${app.slug} has no schema deployed to ${envName} yet`);
    if (!env.databaseUrl) throw new ApiError('conflict', `the ${envName} environment has no database yet`);
    const member = await db.query.appMembers.findFirst({ where: and(eq(appMembers.app, app.slug), eq(appMembers.userId, body.as)) });
    if (!member) throw new ApiError('not_found', `${body.as} is not a member of ${app.slug}`);

    const { schema } = version;
    const policy = version.policy ?? {};
    const claims = { sub: member.userId, app: app.slug, org: member.org, role: member.role, plan: member.plan };
    try {
      const collections = await rolledBack(ctx.appDbs.pool(env.databaseUrl), async (client) => {
        await actAs(client, claims);
        const out = [];
        for (const col of schema.collections) {
          const scope = (op: Op): Scope => policy[member.role]?.[col.name]?.[op] ?? 'none';
          // RLS already limits the rows to what the member may read. Which of those they may also change
          // is the version's own update and delete rule, evaluated per row with the member's claims.
          const rule = (op: 'update' | 'delete') => policyDefinition(col, member.role, op, scope(op))?.using ?? 'false';
          const flags = `(${rule('update')}) AS kelay_can_update, (${rule('delete')}) AS kelay_can_delete`;
          const table = appTable(col.name);
          const counts = await client.query<{ read: number; update: number; delete: number }>(
            `SELECT count(*)::int AS read, count(*) FILTER (WHERE kelay_can_update)::int AS update, count(*) FILTER (WHERE kelay_can_delete)::int AS delete
             FROM (SELECT ${flags} FROM ${table}) AS visible`,
          );
          const rows = await client.query<Record<string, unknown> & RowFlags>(
            `SELECT *, ${flags} FROM ${table} ORDER BY created_at DESC, id LIMIT ${PREVIEW_ROWS}`,
          );
          const n = counts.rows[0]!;
          out.push({
            collection: col.name,
            label: col.label ?? col.name,
            ownerField: ownerFieldOf(col),
            read: { scope: scope('read'), allowed: scope('read') !== 'none', count: n.read },
            create: { scope: scope('create'), allowed: scope('create') !== 'none' },
            update: { scope: scope('update'), allowed: scope('update') !== 'none', count: n.update },
            delete: { scope: scope('delete'), allowed: scope('delete') !== 'none', count: n.delete },
            rows: rows.rows.map((row) => sampleRow(col, row)),
          });
        }
        return out;
      });
      return c.json({
        preview: {
          as: { userId: member.userId, role: member.role, org: member.org, plan: member.plan, status: member.status },
          env: envName,
          version: versionRef(version),
          collections,
        },
      });
    } catch (e) {
      if (isSchemaMismatch(e)) throw new ApiError('conflict', `the ${envName} database does not match ${versionRef(version).label}: ${(e as Error).message}`);
      throw e;
    }
  });

  return r;
}
