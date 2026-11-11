// Unauthenticated: a builder's store page lists their live, listed apps. Drafts and hidden apps never appear.
import { Hono } from 'hono';
import { and, asc, eq } from 'drizzle-orm';
import { AppSlug } from '@kelay/contracts';
import type { AppEnv } from '../auth.ts';
import { apps, builders } from '../db/schema.ts';
import type { Ctx } from '../deps.ts';
import { ApiError } from '../errors.ts';

export function publicRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();
  const { db } = ctx;

  r.get('/public/v1/stores/:handle', async (c) => {
    const handle = c.req.param('handle');
    if (!AppSlug.safeParse(handle).success) throw new ApiError('not_found', 'no such store');
    const builder = await db.query.builders.findFirst({ where: eq(builders.handle, handle) });
    if (!builder) throw new ApiError('not_found', 'no such store');
    const rows = await db
      .select({ slug: apps.slug, name: apps.name, description: apps.description, emoji: apps.emoji, color: apps.color })
      .from(apps)
      .where(and(eq(apps.owner, builder.userId), eq(apps.status, 'live'), eq(apps.listed, true)))
      .orderBy(asc(apps.name));
    c.header('cache-control', 'public, max-age=60');
    return c.json({ handle, apps: rows.map((a) => ({ ...a, path: `/${handle}/${a.slug}` })) });
  });

  return r;
}
