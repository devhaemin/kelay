// Consents a person gave their own AI assistants (user × app × MCP client). Revoking ends that client's access
// to that app; Kelay ID and the MCP gateway check revoked_at through the internal routes.
import { Hono } from 'hono';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { CONSOLE_APP, requireBuilder, requireUser, type AppEnv } from '../auth.ts';
import { consents, type ConsentRow } from '../db/schema.ts';
import type { Ctx } from '../deps.ts';
import { ApiError } from '../errors.ts';
import { loadApp, queryParams } from './util.ts';

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
    const [row] = await db.update(consents).set({ revokedAt: ctx.now() }).where(eq(consents.id, id)).returning();
    ctx.logger.info({ type: 'consent_revoked', consent: id, app: row!.app, client: row!.clientId }, 'consent revoked');
    return c.json({ consent: consentView(row!) });
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

  return r;
}
