// QA runs (the QA tab). A QaRunner produces checks for one app × env; the control API stores them.
// The default runner checks access: for every role × collection × op it tries the operation against the
// real app database as a member with that role, and compares the answer with what the policy says.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { Op, type AppSchema, type CollectionDef, type FieldDef, type PolicyMatrix } from '@kelay/contracts';
import { orderCollections, ownerFieldOf, quoteIdent } from '@kelay/policy';
import { actAs, appTable, isPermissionDenied, probe, rolledBack, type AppDatabases } from '../appdb.ts';
import type { EnvName, QaCheckResult } from '../db/schema.ts';

export interface QaRunInput {
  app: string;
  env: EnvName;
  schema: AppSchema;
  policy: PolicyMatrix;
  databaseUrl: string;
}

export interface QaRunner {
  readonly name: string;
  /** Rejects when the run could not be carried out at all; a wrong answer is a check with `ok: false`. */
  run(input: QaRunInput): Promise<QaCheckResult[]>;
}

/** Member and org the probe rows belong to. They exist only inside a transaction that is rolled back. */
export const QA_USER = 'kelay-qa';
export const QA_ORG = 'kelay-qa';

type Row = Record<string, unknown>;

function fieldValue(name: string, f: FieldDef, c: CollectionDef, self: string, targets: Map<string, string>): unknown {
  if (name === ownerFieldOf(c)) return QA_USER;
  switch (f.type) {
    case 'text':
      return 'kelay-qa';
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'timestamp':
      return new Date().toISOString();
    case 'uuid':
      return randomUUID();
    case 'json':
      return '{}';
    case 'ref':
      if (!f.required) return null;
      return f.ref === c.name ? self : (targets.get(f.ref ?? '') ?? null);
  }
}

const fieldValues = (c: CollectionDef, self: string, targets: Map<string, string>): Row =>
  Object.fromEntries(Object.entries(c.fields).map(([name, f]) => [name, fieldValue(name, f, c, self, targets)]));

async function insert(client: pg.PoolClient, c: CollectionDef, row: Row): Promise<void> {
  const columns = Object.keys(row);
  if (columns.length === 0) {
    await client.query(`INSERT INTO ${appTable(c.name)} DEFAULT VALUES`);
    return;
  }
  await client.query(
    `INSERT INTO ${appTable(c.name)} (${columns.map(quoteIdent).join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    columns.map((k) => row[k]),
  );
}

interface Seeds {
  /** Row to read and update; child collections reference it. */
  target: Map<string, string>;
  /** Row to delete: nothing references it, so only access rules can refuse the delete. */
  spare: Map<string, string>;
}

/**
 * Inserts two rows per collection owned by the QA member. FORCE ROW LEVEL SECURITY binds the table
 * owner too, so unless this connection bypasses RLS it is lifted for the insert; the transaction is
 * rolled back, which also restores it.
 */
async function seed(client: pg.PoolClient, collections: CollectionDef[]): Promise<Seeds> {
  const { rows } = await client.query<{ bypass: boolean }>(`SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`);
  const bypass = rows[0]?.bypass ?? false;
  const seeds: Seeds = { target: new Map(), spare: new Map() };
  for (const c of collections) {
    if (!bypass) await client.query(`ALTER TABLE ${appTable(c.name)} NO FORCE ROW LEVEL SECURITY`);
    for (const ids of [seeds.target, seeds.spare]) {
      const id = randomUUID();
      await insert(client, c, { id, org_id: QA_ORG, owner_id: QA_USER, ...fieldValues(c, id, seeds.target) });
      ids.set(c.name, id);
    }
    if (!bypass) await client.query(`ALTER TABLE ${appTable(c.name)} FORCE ROW LEVEL SECURITY`);
  }
  return seeds;
}

async function attempt(client: pg.PoolClient, c: CollectionDef, op: Op, seeds: Seeds): Promise<boolean> {
  const table = appTable(c.name);
  switch (op) {
    case 'read':
      return ((await client.query(`SELECT 1 FROM ${table} WHERE id = $1`, [seeds.target.get(c.name)])).rowCount ?? 0) > 0;
    case 'create':
      await insert(client, c, fieldValues(c, seeds.target.get(c.name)!, seeds.target));
      return true;
    case 'update':
      return ((await client.query(`UPDATE ${table} SET updated_at = updated_at WHERE id = $1`, [seeds.target.get(c.name)])).rowCount ?? 0) > 0;
    case 'delete':
      return ((await client.query(`DELETE FROM ${table} WHERE id = $1`, [seeds.spare.get(c.name)])).rowCount ?? 0) > 0;
  }
}

export class PolicyQaRunner implements QaRunner {
  readonly name = 'policy';

  constructor(private readonly appDbs: AppDatabases) {}

  async run({ app, schema, policy, databaseUrl }: QaRunInput): Promise<QaCheckResult[]> {
    const collections = orderCollections(schema.collections).order;
    const pool = this.appDbs.pool(databaseUrl);
    const checks: QaCheckResult[] = [];
    for (const role of schema.roles) {
      await rolledBack(pool, async (client) => {
        const seeds = await seed(client, collections);
        await actAs(client, { sub: QA_USER, app, org: QA_ORG, role, plan: 'free' });
        for (const c of collections) {
          const scopes = policy[role]?.[c.name];
          const canRead = (scopes?.read ?? 'none') !== 'none';
          for (const op of Op.options) {
            const granted = (scopes?.[op] ?? 'none') !== 'none';
            // Postgres finds the row to update or delete through the read policy.
            const needsRead = op === 'update' || op === 'delete';
            const expected = granted && (!needsRead || canRead) ? 'allow' : 'deny';
            const started = performance.now();
            let actual: QaCheckResult['actual'];
            let note: string | null = granted && expected === 'deny' ? `${role} may ${op} ${c.name} but cannot read them, so there is no row to ${op}` : null;
            try {
              actual = (await probe(client, () => attempt(client, c, op, seeds))) ? 'allow' : 'deny';
            } catch (e) {
              actual = isPermissionDenied(e) ? 'deny' : 'error';
              if (actual === 'error') note = (e as Error).message;
            }
            checks.push({ role, collection: c.name, op, expected, actual, ok: actual === expected, ms: Math.round(performance.now() - started), note });
          }
        }
      });
    }
    return checks;
  }
}
