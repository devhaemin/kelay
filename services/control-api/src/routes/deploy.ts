// Deploy a build to an env, and publish a version to production (docs/infrastructure.md §4.3, §5).
import { Hono } from 'hono';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppSchema, AppSlug, PolicyMatrix } from '@kelay/contracts';
import { requireBuilder, requireBuilderOrService, type AppEnv } from '../auth.ts';
import { apps, envs, ENV_NAMES, versions, type AppRow, type EnvName, type VersionRow } from '../db/schema.ts';
import type { Ctx } from '../deps.ts';
import { DeployError, type DeployInput } from '../deploy/driver.ts';
import { ApiError } from '../errors.ts';
import { actorOf, appView, jsonBody, loadApp, queryParams, versionView } from './util.ts';

const DeployBody = z.object({
  commit: z.string().trim().min(1).max(100),
  artifactUrl: z.string().trim().min(1).max(2000),
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

  /** Records a deployed version and makes it the env's active one. */
  const record = async (row: Omit<typeof versions.$inferInsert, 'id' | 'createdAt'>, app: AppRow): Promise<VersionRow> =>
    db.transaction(async (tx) => {
      const [v] = await tx.insert(versions).values(row).returning();
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

    const [seq] = await db
      .update(apps)
      .set({ versionSeq: sql`${apps.versionSeq} + 1` })
      .where(eq(apps.slug, app.slug))
      .returning({ n: apps.versionSeq });
    const input: DeployInput = {
      app: app.slug,
      env: env.data,
      handle: app.handle,
      number: seq!.n,
      commit: body.commit,
      artifactUrl: body.artifactUrl,
      configVersion: body.configVersion,
      graphs: body.graphs ?? [],
    };
    const result = await runDriver(app.slug, env.data, () => ctx.deploy.deploy(input));
    const version = await record(
      {
        app: app.slug,
        env: env.data,
        number: input.number,
        codeCommit: body.commit,
        artifactUrl: body.artifactUrl,
        configVersion: body.configVersion,
        lambdaVersion: result.lambdaVersion,
        resources: result.resources,
        schema: body.schema ?? null,
        policy: body.policy ?? null,
        graphs: input.graphs ?? [],
        createdBy: actorOf(principal),
      },
      app,
    );
    ctx.logger.info({ type: 'deploy', app: app.slug, env: env.data, version: version.number, driver: ctx.deploy.name }, 'deployed');
    return c.json({ version: versionView(version) }, 201);
  });

  r.post('/v1/apps/:app/publish', requireBuilder(ctx.auth), jsonBody(z.object({ versionId: z.uuid() })), async (c) => {
    const principal = c.get('principal');
    const app = await loadApp(db, c.req.param('app'), principal);
    const source = await db.query.versions.findFirst({
      where: and(eq(versions.id, c.req.valid('json').versionId), eq(versions.app, app.slug)),
    });
    if (!source) throw new ApiError('not_found', 'no such version');

    // A prod version (or a dev version already promoted) only needs the alias moved; that is also how rollback works.
    const existing =
      source.env === 'prod'
        ? source
        : await db.query.versions.findFirst({ where: and(eq(versions.app, app.slug), eq(versions.env, 'prod'), eq(versions.number, source.number)) });

    let version: VersionRow;
    if (existing) {
      await runDriver(app.slug, 'prod', () =>
        ctx.deploy.activate({ app: app.slug, env: 'prod', lambdaVersion: existing.lambdaVersion, resources: existing.resources }),
      );
      await db.update(envs).set({ activeVersionId: existing.id, updatedAt: ctx.now() }).where(and(eq(envs.app, app.slug), eq(envs.name, 'prod')));
      version = existing;
    } else {
      const result = await runDriver(app.slug, 'prod', () =>
        ctx.deploy.deploy({
          app: app.slug,
          env: 'prod',
          handle: app.handle,
          number: source.number,
          commit: source.codeCommit,
          artifactUrl: source.artifactUrl,
          configVersion: source.configVersion,
          graphs: source.graphs,
        }),
      );
      version = await record(
        {
          app: app.slug,
          env: 'prod',
          number: source.number,
          codeCommit: source.codeCommit,
          artifactUrl: source.artifactUrl,
          configVersion: source.configVersion,
          lambdaVersion: result.lambdaVersion,
          resources: result.resources,
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
    return c.json({ version: versionView(version), app: appView(updated!) });
  });

  r.get('/v1/apps/:app/versions', requireBuilder(ctx.auth), queryParams(z.object({ env: EnvParam.optional() })), async (c) => {
    const app = await loadApp(db, c.req.param('app'), c.get('principal'));
    const env = c.req.valid('query').env;
    const rows = await db
      .select()
      .from(versions)
      .where(and(eq(versions.app, app.slug), env ? eq(versions.env, env) : undefined))
      .orderBy(desc(versions.createdAt));
    return c.json({ versions: rows.map(versionView) });
  });

  return r;
}
