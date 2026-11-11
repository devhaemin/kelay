import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { PolicyError, describePolicy, kelayAuthSql, migrationSql, policyToSql, quoteIdent, schemaToSql } from './index.ts';

const resolve = (p: string) => createRequire(import.meta.url).resolve(`@kelay/contracts/${p}`);
const fx = (p: string) => JSON.parse(readFileSync(resolve(`fixtures/${p}`), 'utf8'));
const schema = fx('ticket-board/schema.json');
const policy = fx('ticket-board/policy.json');

describe('quoteIdent', () => {
  it('quotes identifiers and refuses anything outside IDENT', () => {
    expect(quoteIdent('tickets')).toBe('"tickets"');
    for (const bad of ['Tickets', 'a"b', 'x; drop table y', '', '1abc']) expect(() => quoteIdent(bad)).toThrow();
  });
});

describe('schemaToSql', () => {
  it('creates tables with implicit columns, types, NOT NULL and refs', () => {
    const sql = schemaToSql(schema);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "app"."tickets" (');
    expect(sql).toContain('"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()');
    expect(sql).toContain('"org_id" text NOT NULL DEFAULT kelay.org()');
    expect(sql).toContain('"owner_id" text NOT NULL DEFAULT kelay.uid()');
    expect(sql).toContain('"title" text NOT NULL');
    expect(sql).toContain('"due_on" timestamptz,');
    expect(sql).toContain('"project_id" uuid REFERENCES "app"."projects" ("id")');
    expect(sql).toContain('"ticket_id" uuid NOT NULL REFERENCES "app"."tickets" ("id")');
  });

  it('adds the shared column only to shared collections', () => {
    const sql = schemaToSql(schema);
    const tickets = sql.slice(sql.indexOf('"app"."tickets" ('), sql.indexOf('"app"."comments" ('));
    expect(tickets).toContain('"shared" boolean NOT NULL DEFAULT false');
    expect(sql.match(/"shared" boolean/g)).toHaveLength(1);
  });

  it('maps every field type', () => {
    const sql = schemaToSql({
      app: 'types',
      roles: ['admin'],
      collections: [
        {
          name: 'things',
          fields: {
            t: { type: 'text' },
            n: { type: 'number' },
            b: { type: 'boolean' },
            ts: { type: 'timestamp' },
            u: { type: 'uuid' },
            j: { type: 'json' },
            r: { type: 'ref', ref: 'things' },
          },
        },
      ],
    });
    for (const col of ['"t" text', '"n" double precision', '"b" boolean', '"ts" timestamptz', '"u" uuid', '"j" jsonb']) {
      expect(sql).toContain(col);
    }
    expect(sql).toContain('"r" uuid REFERENCES "app"."things" ("id")');
  });

  it('orders tables so refs come after their targets', () => {
    const reversed = { ...schema, collections: [...schema.collections].reverse() };
    const sql = schemaToSql(reversed);
    const at = (t: string) => sql.indexOf(`"app"."${t}" (`);
    expect(at('projects')).toBeLessThan(at('tickets'));
    expect(at('tickets')).toBeLessThan(at('comments'));
  });

  it('validates before generating anything', () => {
    expect(() => schemaToSql({ ...schema, collections: [{ name: 'x', fields: { id: { type: 'uuid' } } }] })).toThrow(PolicyError);
  });
});

describe('policyToSql', () => {
  const sql = policyToSql(schema, policy);

  it('enables and forces RLS on every table, then grants to kelay_runtime', () => {
    for (const t of ['projects', 'tickets', 'comments']) {
      expect(sql).toContain(`ALTER TABLE "app"."${t}" ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`ALTER TABLE "app"."${t}" FORCE ROW LEVEL SECURITY;`);
    }
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "app" TO "kelay_runtime";');
    expect(sql).toContain('GRANT USAGE ON ALL SEQUENCES IN SCHEMA "app" TO "kelay_runtime";');
  });

  it('drops existing kelay-named policies before creating new ones', () => {
    expect(sql.indexOf('DROP POLICY')).toBeLessThan(sql.indexOf('CREATE POLICY'));
  });

  it('creates one policy per allowed role x collection x op and none for denied ops', () => {
    expect(sql.match(/CREATE POLICY/g)).toHaveLength(25);
    expect(sql).not.toContain('"tickets_create_guest"');
    expect(sql).not.toContain('"tickets_delete_member"');
  });

  it('applies the scope semantics of contract section 3', () => {
    expect(sql).toContain(
      'CREATE POLICY "tickets_read_member" ON "app"."tickets" AS PERMISSIVE FOR SELECT TO "kelay_runtime"\n' +
        `  USING (kelay.role() = 'member' AND "org_id" = kelay.org() AND ("assignee_id" = kelay.uid() OR "shared"));`,
    );
    expect(sql).toContain(
      'CREATE POLICY "tickets_update_member" ON "app"."tickets" AS PERMISSIVE FOR UPDATE TO "kelay_runtime"\n' +
        `  USING (kelay.role() = 'member' AND "org_id" = kelay.org() AND "assignee_id" = kelay.uid())\n` +
        `  WITH CHECK (kelay.role() = 'member' AND "org_id" = kelay.org() AND "assignee_id" = kelay.uid());`,
    );
    expect(sql).toContain(
      'CREATE POLICY "tickets_create_member" ON "app"."tickets" AS PERMISSIVE FOR INSERT TO "kelay_runtime"\n' +
        `  WITH CHECK (kelay.role() = 'member' AND "org_id" = kelay.org());`,
    );
    expect(sql).toContain(
      `CREATE POLICY "comments_delete_member" ON "app"."comments" AS PERMISSIVE FOR DELETE TO "kelay_runtime"\n` +
        `  USING (kelay.role() = 'member' AND "org_id" = kelay.org() AND "owner_id" = kelay.uid());`,
    );
  });

  it('treats mine_shared on a collection without sharing as mine, and lets create through', () => {
    const notes = { app: 'notes', roles: ['member'], collections: [{ name: 'notes', fields: { body: { type: 'text' } } }] } as const;
    const out = policyToSql(notes, { member: { notes: { read: 'mine_shared', create: 'mine_shared', update: 'mine_shared', delete: 'none' } } });
    expect(out).toContain(`USING (kelay.role() = 'member' AND "org_id" = kelay.org() AND "owner_id" = kelay.uid());`);
    expect(out).toContain(`FOR INSERT TO "kelay_runtime"\n  WITH CHECK (kelay.role() = 'member' AND "org_id" = kelay.org());`);
    expect(out).not.toContain('"shared"');
  });

  it('matches the reviewed ticket-board output', async () => {
    await expect(sql).toMatchFileSnapshot('./__snapshots__/ticket-board.policy.sql');
  });
});

describe('migrationSql', () => {
  it('runs kelay_auth.sql, then the tables, then RLS', () => {
    const sql = migrationSql(schema, policy);
    const auth = readFileSync(resolve('sql/kelay_auth.sql'), 'utf8').trimEnd();
    expect(kelayAuthSql().trimEnd()).toBe(auth);
    expect(sql).toContain(auth);
    expect(sql.indexOf(auth)).toBeLessThan(sql.indexOf('CREATE TABLE'));
    expect(sql.indexOf('CREATE TABLE')).toBeLessThan(sql.indexOf('ENABLE ROW LEVEL SECURITY'));
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT);/);
  });
});

describe('describePolicy', () => {
  const summary = describePolicy(schema, policy);
  const op = (role: string, collection: string, o: 'read' | 'create' | 'update' | 'delete') =>
    summary.roles.find((r) => r.role === role)?.collections.find((c) => c.collection === collection)?.ops[o];

  it('covers every declared role, collection and op', () => {
    expect(summary.app).toBe('ticket-board');
    expect(summary.roles.map((r) => r.role)).toEqual(['admin', 'member', 'guest']);
    for (const r of summary.roles) expect(r.collections.map((c) => c.collection)).toEqual(['projects', 'tickets', 'comments']);
  });

  it('explains each scope in one sentence and carries the generated policy', () => {
    expect(op('member', 'tickets', 'read')).toMatchObject({
      scope: 'mine_shared',
      allowed: true,
      text: 'Can read tickets where assignee_id is them, plus shared tickets.',
      policy: { name: 'tickets_read_member', command: 'SELECT', withCheck: null },
    });
    expect(op('member', 'tickets', 'update')?.text).toBe('Can update tickets where assignee_id is them.');
    expect(op('member', 'comments', 'delete')?.text).toBe('Can delete their own comments.');
    expect(op('admin', 'tickets', 'read')?.text).toBe('Can read all tickets in their org.');
    expect(op('guest', 'tickets', 'create')).toMatchObject({ scope: 'none', allowed: false, policy: null, text: 'Cannot create tickets.' });
  });

  it('treats a role missing from the matrix as denied everywhere', () => {
    const { guest: _guest, ...rest } = policy;
    const s = describePolicy(schema, rest);
    const guest = s.roles.find((r) => r.role === 'guest');
    expect(guest?.collections.every((c) => Object.values(c.ops).every((o) => !o.allowed))).toBe(true);
  });

  it('uses the same predicates as policyToSql', () => {
    const sql = policyToSql(schema, policy);
    for (const r of summary.roles) {
      for (const c of r.collections) {
        for (const o of Object.values(c.ops)) {
          if (o.policy?.using) expect(sql).toContain(`USING (${o.policy.using})`);
          if (o.policy?.withCheck) expect(sql).toContain(`WITH CHECK (${o.policy.withCheck})`);
        }
      }
    }
  });
});
