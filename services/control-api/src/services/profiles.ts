// Who a user id is. Kelay ID (better-auth) keeps its `user`, `account` and `session` tables in the
// control DB (contract §8); the control API only reads them, to show names next to user ids.
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';

export const SIGN_IN_PROVIDERS = ['google', 'email', 'kakao', 'github'] as const;
export type SignInProvider = (typeof SIGN_IN_PROVIDERS)[number];

export interface Profile {
  name: string | null;
  email: string | null;
  /** How the person signs in: the provider of their first account. */
  provider: SignInProvider | null;
  /** When the Kelay ID account was created. */
  createdAt: Date | null;
  /** Start of the person's newest session that Kelay ID still keeps. */
  lastSignInAt: Date | null;
}

export const NO_PROFILE: Profile = { name: null, email: null, provider: null, createdAt: null, lastSignInAt: null };

/** better-auth files email and password accounts under `credential`. */
function providerOf(providerId: string | null): SignInProvider | null {
  if (providerId === 'credential') return 'email';
  return SIGN_IN_PROVIDERS.find((p) => p === providerId) ?? null;
}

const UNDEFINED_TABLE = '42P01';

/**
 * Profiles of the given users, keyed by user id. Users Kelay ID does not know are left out, and so is
 * everyone when its tables are not in this database (a control DB that Kelay ID has not migrated yet).
 * It takes the root handle, not a transaction: with the tables missing the query fails, which would abort one.
 */
export async function loadProfiles(db: Db, userIds: readonly string[]): Promise<Map<string, Profile>> {
  const profiles = new Map<string, Profile>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return profiles;
  const wanted = sql`array[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::text[]`;
  try {
    const { rows } = await db.execute<{ id: string; name: string | null; email: string | null; created_at: Date | null; provider_id: string | null; last_sign_in_at: Date | null }>(sql`
      select u.id, u.name, u.email, u."createdAt" as created_at,
        (select a."providerId" from account a where a."userId" = u.id order by a."createdAt", a.id limit 1) as provider_id,
        (select max(s."createdAt") from session s where s."userId" = u.id) as last_sign_in_at
      from "user" u
      where u.id = any(${wanted})`);
    for (const r of rows) {
      profiles.set(r.id, {
        name: r.name || null,
        email: r.email || null,
        provider: providerOf(r.provider_id),
        createdAt: r.created_at ? new Date(r.created_at) : null,
        lastSignInAt: r.last_sign_in_at ? new Date(r.last_sign_in_at) : null,
      });
    }
  } catch (e) {
    const code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    if (code !== UNDEFINED_TABLE) throw e;
  }
  return profiles;
}
