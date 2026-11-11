// Consents a person gave their own AI assistants (user × app × MCP client). Kelay ID records one here each
// time a person allows an assistant. Revoking ends that client's access to that app at its next token refresh.
import { Hono } from 'hono';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { CONSOLE_APP, requireBuilder, requireUser, type AppEnv } from '../auth.ts';
import { consents, type ConsentRow } from '../db/schema.ts';
import type { Db } from '../db/client.ts';
import type { Ctx } from '../deps.ts';
import { ApiError } from '../errors.ts';
import { actorOf, loadApp, queryParams } from './util.ts';

export const consentView = (x: ConsentRow) => ({
  id: x.id,
  userId: x.userId,
  app: x.app,
  clientId: x.clientId,
  clientName: x.clientName,
  scopes: x.scopes,
  createdAt: x.createdAt,
  lastUsedAt: x.lastUsedAt,
  revokedAt: x.revokedAt,
  active: x.revokedAt == null,
});

/**
 * Marks the consent revoked and, in the same transaction, deletes what Kelay ID keeps for the same
 * user × app × client in this database (better-auth's tables, keyed by app in `referenceId`):
 * - `oauthConsent`: Kelay ID looks it up on every token grant, so the next refresh is refused, and
 *   connecting again shows the consent screen again;
 * - `oauthRefreshToken`: otherwise a refresh token from before the revoke works again as soon as the
 *   person connects that assistant again.
 * A control DB that Kelay ID has not migrated has neither table.
 */
export async function revokeConsent(db: Db, id: string, at: Date): Promise<ConsentRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx.update(consents).set({ revokedAt: at }).where(eq(consents.id, id)).returning();
    const { rows } = await tx.execute<{ present: boolean }>(sql`select to_regclass('"oauthConsent"') is not null as present`);
    if (rows[0]?.present) {
      for (const table of ['oauthConsent', 'oauthRefreshToken']) {
        await tx.execute(sql`delete from ${sql.identifier(table)} where "userId" = ${row!.userId} and "clientId" = ${row!.clientId} and "referenceId" = ${row!.app}`);
      }
    }
    return row!;
  });
}

export function consentRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();
  const { db } = ctx;
  const user = requireUser(ctx.auth);

  /** A console token lists every app; an app token only its own app. */
  const scopeFor = (claims: { sub: string; app: string }) =>
    and(eq(consents.userId, claims.sub), claims.app === CONSOLE_APP ? undefined : eq(consents.app, claims.app));

  r.get('/v1/me/consents', user, queryParams(z.object({ include: z.enum(['active', 'all']).optional() })), async (c) => {
    const p = c.get('principal');
    if (p.kind !== 'user') throw new ApiError('denied', 'user access required');
    const rows = await db
      .select()
      .from(consents)
      .where(and(scopeFor(p.user), c.req.valid('query').include === 'all' ? undefined : isNull(consents.revokedAt)))
      .orderBy(desc(consents.createdAt));
    return c.json({ consents: rows.map(consentView) });
  });

  r.post('/v1/me/consents/:id/revoke', user, async (c) => {
    const p = c.get('principal');
    if (p.kind !== 'user') throw new ApiError('denied', 'user access required');
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) throw new ApiError('not_found', 'no such consent');
    const existing = await db.query.consents.findFirst({ where: and(eq(consents.id, id), scopeFor(p.user)) });
    if (!existing) throw new ApiError('not_found', 'no such consent');
    if (existing.revokedAt) return c.json({ consent: consentView(existing) });
    const row = await revokeConsent(db, id, ctx.now());
    ctx.logger.info({ type: 'consent_revoked', consent: id, app: row.app, client: row.clientId }, 'consent revoked');
    return c.json({ consent: consentView(row) });
  });

  // The Agent tab: assistants members connected to this app.
  r.get('/v1/apps/:app/consents', requireBuilder(ctx.auth), async (c) => {
    const app = await loadApp(db, c.req.param('app'), c.get('principal'));
    const rows = await db
      .select()
      .from(consents)
      .where(and(eq(consents.app, app.slug), isNull(consents.revokedAt)))
      .orderBy(desc(consents.createdAt));
    return c.json({ consents: rows.map(consentView) });
  });

  // A builder may cut an assistant off from their app; the member can connect it again and consent anew.
  r.post('/v1/apps/:app/consents/:id/revoke', requireBuilder(ctx.auth), async (c) => {
    const principal = c.get('principal');
    const app = await loadApp(db, c.req.param('app'), principal);
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) throw new ApiError('not_found', 'no such consent');
    const existing = await db.query.consents.findFirst({ where: and(eq(consents.id, id), eq(consents.app, app.slug)) });
    if (!existing) throw new ApiError('not_found', 'no such consent');
    if (existing.revokedAt) return c.json({ consent: consentView(existing) });
    const row = await revokeConsent(db, id, ctx.now());
    ctx.logger.info({ type: 'consent_revoked', consent: id, app: app.slug, client: row.clientId, by: actorOf(principal) }, 'consent revoked by builder');
    return c.json({ consent: consentView(row) });
  });

  return r;
}
