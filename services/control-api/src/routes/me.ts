// The signed-in person: their Kelay ID profile and, for a builder, the handle their apps live under.
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { requireUser, type AppEnv } from '../auth.ts';
import { builders } from '../db/schema.ts';
import type { Ctx } from '../deps.ts';
import { ApiError } from '../errors.ts';
import { loadProfiles, NO_PROFILE } from '../services/profiles.ts';

export function meRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();
  const { db } = ctx;

  r.get('/v1/me', requireUser(ctx.auth), async (c) => {
    const p = c.get('principal');
    if (p.kind !== 'user') throw new ApiError('denied', 'user access required');
    const { sub, app, org, role, plan } = p.user;
    const [profiles, builder] = await Promise.all([loadProfiles(db, [sub]), db.query.builders.findFirst({ where: eq(builders.userId, sub) })]);
    return c.json({ me: { userId: sub, ...(profiles.get(sub) ?? NO_PROFILE), app, org, role, plan, handle: builder?.handle ?? null } });
  });

  return r;
}
