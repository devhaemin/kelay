// Reads per-app membership from the control DB `app_members` table (contract §9, owned by control-api).
import type { Pool } from 'pg';
import type { AppMemberRow } from '@kelay/contracts';

export interface MemberStore {
  find(app: string, userId: string): Promise<AppMemberRow | undefined>;
}

export function pgMemberStore(pool: Pool): MemberStore {
  return {
    async find(app, userId) {
      const { rows } = await pool.query<AppMemberRow>(
        'select app, user_id, org, role, plan, status from app_members where app = $1 and user_id = $2',
        [app, userId],
      );
      return rows[0];
    },
  };
}

/** Only active members get tokens: not banned ones, and not `unconfirmed` ones who have yet to be let in. */
export function mayUseApp(member: AppMemberRow | undefined): member is AppMemberRow {
  return member?.status === 'active';
}
