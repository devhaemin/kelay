// Deploy a build to an env, and publish a version to production (docs/infrastructure.md §4.3, §5).
import { Hono } from 'hono';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppSchema, AppSlug, PolicyMatrix } from '@kelay/contracts';
import { signCallerToken } from '@kelay/tokens';
import { requireBuilder, requireBuilderOrService, type AppEnv } from '../auth.ts';
import { apps, envs, ENV_NAMES, versions, type AppRow, type EnvName, type EnvRow, type VersionRow } from '../db/schema.ts';
import type { Ctx } from '../deps.ts';
import { DeployError, type DeployInput } from '../deploy/driver.ts';
import { ApiError } from '../errors.ts';
import { databaseUrlFor } from './apps.ts';
import { checkPolicy, findDraft } from './policy.ts';
import { actorOf, appView, jsonBody, loadApp, loadEnv, queryParams, versionView } from './util.ts';

const DeployBody = z.object({
  commit: z.string().trim().min(1).max(100),
  artifactUrl: z.string().trim().min(1).max(2000),
  nodesArtifactUrl: z.string().trim().min(1).max(2000).optional(),
  configVersion: z.string().trim().min(1).max(100),
  schema: AppSchema.optional(),
  policy: PolicyMatrix.optional(),
  graphs: z
    .array(z.object({ name: AppSlug, definition: z.string().min(2), type: z.enum(['EXPRESS', 'STANDARD']).optional() }))
    .max(20)
    .optional(),
});

const EnvParam = z.enum(ENV_NAMES);

export function deployRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();
  const { db } = ctx;

  const runDriver = async <T>(app: string, env: EnvName, f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      ctx.logger.error({ type: 'deploy_failed', app, env, driver: ctx.deploy.name, err: (e as Error).message }, 'deploy failed');
      if (e instanceof DeployError && e.badInput) throw new ApiError('invalid_request', e.message);
      throw new ApiError('internal', `deploy failed: ${(e as Error).message}`);
    }
  };

  /**
   * Applies a version's tables and access rules to the env's database. It runs before the driver, because
   * the migration only adds tables and columns: old code keeps working on the new schema, new code would
   * not on the old one. A version without a schema has nothing to apply.
   */
  const migrateAppDatabase = async (app: string, env: EnvRow, version: Pick<VersionRow, 'schema' | 'policy'>): Promise<void> => {
    if (!version.schema) return;
    let databaseUrl = env.databaseUrl;
    if (!databaseUrl) {
      databaseUrl = databaseUrlFor(ctx.databaseUrlTemplate, app, env.name);
      if (!databaseUrl) {
        ctx.logger.warn({ type: 'app_db_migration_skipped', app, env: env.name }, 'the env has no database, so its access rules were not applied');
        return;
      }
      await db.update(envs).set({ databaseUrl, updatedAt: ctx.now() }).where(and(eq(envs.app, app), eq(envs.name, env.name)));
    }
    try {
      await ctx.appMigrator.migrate({ app, env: env.name, databaseUrl, schema: version.schema, policy: version.policy });
    } catch (e) {
      ctx.logger.error({ type: 'app_db_migration_failed', app, env: env.name, err: (e as Error).message }, 'app database migration failed');
      throw new ApiError('internal', `could not apply the schema and access rules to the ${env.name} database: ${(e as Error).message}`);
    }
    ctx.logger.info({ type: 'app_db_migrated', app, env: env.name }, 'schema and access rules applied');
  };

  const mintCallerToken = (app: string, env: EnvName) =>
    signCallerToken({ kind: 'app-runtime', app, env }, ctx.auth.callerSecret, ctx.callerTokenTtlSeconds);

  /** Records a deployed version and makes it the env's active one. A draft, when given, becomes that version. */
  const record = async (row: Omit<typeof versions.$inferInsert, 'id' | 'createdAt'>, app: AppRow, draftId?: string): Promise<VersionRow> =>
    db.transaction(async (tx) => {
      const [v] = draftId
        ? await tx
            .update(versions)
            .set({ ...row, status: 'deployed', createdAt: ctx.now() })
            .where(and(eq(versions.id, draftId), eq(versions.status, 'draft')))
            .returning()
        : await tx.insert(versions).values(row).returning();
      if (!v) throw new ApiError('conflict', 'the draft was deployed by someone else; deploy again');
      await tx
        .update(envs)
        .set({ activeVersionId: v!.id, updatedAt: ctx.now() })
        .where(and(eq(envs.app, app.slug), eq(envs.name, row.env)));
      return v!;
    });

  r.post('/v1/apps/:app/envs/:env/deploy', requireBuilderOrService(ctx.auth), jsonBody(DeployBody), async (c) => {
    const principal = c.get('principal');
    const app = await loadApp(db, c.req.param('app'), principal);
    const env = EnvParam.safeParse(c.req.param('env'));
    if (!env.success) throw new ApiError('invalid_request', 'env must be dev or prod');
    const body = c.req.valid('json');
    if (body.schema && body.schema.app !== app.slug) throw new ApiError('invalid_request', `schema declares app ${body.schema.app}`);

    // Whatever the build does not send carries over from the version it replaces, so redeploying new code
    // keeps the schema, access rules and graphs. Rules saved in the console (the draft) win over the active ones.
    const { env: envRow, version: active } = await loadEnv(db, app.slug, env.data);
    const draft = env.data === 'dev' ? await findDraft(db, app.slug) : undefined;
    const schema = body.schema ?? active?.schema ?? null;
    const policy = body.policy ?? draft?.policy ?? active?.policy ?? null;
    if (schema && policy) checkPolicy(schema, policy);
    else if (policy) throw new ApiError('invalid_request', 'a policy needs a schema');

    // Redeploying the active build (new access rules, same code) keeps its node bundle.
    const nodesArtifactUrl = body.nodesArtifactUrl ?? (body.artifactUrl === active?.artifactUrl ? active.nodesArtifactUrl : null);

    let number = draft?.number;
    if (number === undefined) {
      const [seq] = await db
        .update(apps)
        .set({ versionSeq: sql`${apps.versionSeq} + 1` })
        .where(eq(apps.slug, app.slug))
        .returning({ n: apps.versionSeq });
      number = seq!.n;
    }
    const input: DeployInput = {
      app: app.slug,
      env: env.data,
      handle: app.handle,
      number,
      commit: body.commit,
      artifactUrl: body.artifactUrl,
      nodesArtifactUrl,
      configVersion: body.configVersion,
      graphs: body.graphs ?? active?.graphs ?? [],
      callerToken: await mintCallerToken(app.slug, env.data),
    };
    await migrateAppDatabase(app.slug, envRow, { schema, policy });
    const result = await runDriver(app.slug, env.data, () => ctx.deploy.deploy(input));
    const version = await record(
      {
        app: app.slug,
        env: env.data,
        number: input.number,
        codeCommit: body.commit,
        artifactUrl: body.artifactUrl,
        nodesArtifactUrl,
        configVersion: body.configVersion,
        lambdaVersion: result.lambdaVersion,
        resources: result.resources,
        callerTokenRef: result.callerTokenRef,
        schema,
        policy,
        graphs: input.graphs ?? [],
        sourceVersionId: null,
        createdBy: actorOf(principal),
      },
      app,
      draft?.id,
    );
    ctx.logger.info({ type: 'deploy', app: app.slug, env: env.data, version: version.number, driver: ctx.deploy.name }, 'deployed');
    return c.json({ version: versionView(version), ...(result.callerToken ? { callerToken: result.callerToken } : {}) }, 201);
  });

  r.post('/v1/apps/:app/publish', requireBuilder(ctx.auth), jsonBody(z.object({ versionId: z.uuid() })), async (c) => {
    const principal = c.get('principal');
    const app = await loadApp(db, c.req.param('app'), principal);
    const source = await db.query.versions.findFirst({
      where: and(eq(versions.id, c.req.valid('json').versionId), eq(versions.app, app.slug)),
    });
    if (!source) throw new ApiError('not_found', 'no such version');
    if (source.status === 'draft') throw new ApiError('conflict', 'these access rules are a draft; deploy them to Development first');

    // A prod version (or a dev version already promoted) only needs the alias moved; that is also how rollback works.
    const existing =
      source.env === 'prod'
        ? source
        : await db.query.versions.findFirst({ where: and(eq(versions.app, app.slug), eq(versions.env, 'prod'), eq(versions.number, source.number)) });

    // Rolling back moves the rules back too: the database follows the version that is live.
    const { env: prodEnv } = await loadEnv(db, app.slug, 'prod');
    await migrateAppDatabase(app.slug, prodEnv, existing ?? source);

    let version: VersionRow;
    let callerToken: string | undefined;
    if (existing) {
      await runDriver(app.slug, 'prod', () =>
        ctx.deploy.activate({ app: app.slug, env: 'prod', lambdaVersion: existing.lambdaVersion, resources: existing.resources }),
      );
      await db.update(envs).set({ activeVersionId: existing.id, updatedAt: ctx.now() }).where(and(eq(envs.app, app.slug), eq(envs.name, 'prod')));
      version = existing;
    } else {
      const minted = await mintCallerToken(app.slug, 'prod');
      const result = await runDriver(app.slug, 'prod', () =>
        ctx.deploy.deploy({
          app: app.slug,
          env: 'prod',
          handle: app.handle,
          number: source.number,
          commit: source.codeCommit,
          artifactUrl: source.artifactUrl,
          nodesArtifactUrl: source.nodesArtifactUrl,
          configVersion: source.configVersion,
          graphs: source.graphs,
          callerToken: minted,
        }),
      );
      callerToken = result.callerToken;
      version = await record(
        {
          app: app.slug,
          env: 'prod',
          number: source.number,
          codeCommit: source.codeCommit,
          artifactUrl: source.artifactUrl,
          nodesArtifactUrl: source.nodesArtifactUrl,
          configVersion: source.configVersion,
          lambdaVersion: result.lambdaVersion,
          resources: result.resources,
          callerTokenRef: result.callerTokenRef,
          schema: source.schema,
          policy: source.policy,
          graphs: source.graphs,
          sourceVersionId: source.id,
          createdBy: actorOf(principal),
        },
        app,
      );
    }
    const [updated] = await db
      .update(apps)
      .set({ status: app.status === 'draft' ? 'live' : app.status, updatedAt: ctx.now() })
      .where(eq(apps.slug, app.slug))
      .returning();
    ctx.logger.info({ type: 'publish', app: app.slug, version: version.number, rollback: !!existing }, 'published');
    return c.json({ version: versionView(version), app: appView(updated!), ...(callerToken ? { callerToken } : {}) });
  });

  r.get('/v1/apps/:app/versions', requireBuilder(ctx.auth), queryParams(z.object({ env: EnvParam.optional() })), async (c) => {
    const app = await loadApp(db, c.req.param('app'), c.get('principal'));
    const env = c.req.valid('query').env;
    const rows = await db
      .select()
      .from(versions)
      .where(and(eq(versions.app, app.slug), eq(versions.status, 'deployed'), env ? eq(versions.env, env) : undefined))
      .orderBy(desc(versions.createdAt));
    return c.json({ versions: rows.map(versionView) });
  });

  return r;
}
