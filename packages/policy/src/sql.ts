// SQL generation for contracts §2 (tables) and §3 (RLS). Inputs are validated first, and every
// identifier is checked against IDENT again right where it is quoted.
import { APP_DB_SCHEMA, IDENT, Op, RUNTIME_DB_ROLE, type CollectionDef, type FieldType, type Scope } from '@kelay/contracts';
import {
  orderCollections,
  ownerFieldOf,
  policyName,
  validateAppSchema,
  validatePolicy,
  type AppSchemaInput,
  type PolicyMatrixInput,
} from './validate.ts';

export function quoteIdent(name: string): string {
  if (!IDENT.test(name)) throw new Error(`refusing to quote unsafe identifier ${JSON.stringify(name)}`);
  return `"${name}"`;
}

/** String literal for a value that is itself an identifier (role names). */
export function identLiteral(name: string): string {
  if (!IDENT.test(name)) throw new Error(`refusing to quote unsafe literal ${JSON.stringify(name)}`);
  return `'${name}'`;
}

const COLUMN_TYPE: Record<FieldType, string> = {
  text: 'text',
  number: 'double precision',
  boolean: 'boolean',
  timestamp: 'timestamptz',
  uuid: 'uuid',
  json: 'jsonb',
  ref: 'uuid',
};

const IMPLICIT_COLUMNS: [name: string, definition: string][] = [
  ['id', 'uuid PRIMARY KEY DEFAULT gen_random_uuid()'],
  ['org_id', 'text NOT NULL DEFAULT kelay.org()'],
  ['owner_id', 'text NOT NULL DEFAULT kelay.uid()'],
  ['created_at', 'timestamptz NOT NULL DEFAULT now()'],
  ['updated_at', 'timestamptz NOT NULL DEFAULT now()'],
];

const table = (collection: string) => `${quoteIdent(APP_DB_SCHEMA)}.${quoteIdent(collection)}`;

function createTable(c: CollectionDef): string {
  const columns = IMPLICIT_COLUMNS.map(([name, def]) => `${quoteIdent(name)} ${def}`);
  if (c.shared) columns.push(`${quoteIdent('shared')} boolean NOT NULL DEFAULT false`);
  for (const [name, f] of Object.entries(c.fields)) {
    let def = `${quoteIdent(name)} ${COLUMN_TYPE[f.type]}`;
    if (f.required) def += ' NOT NULL';
    if (f.type === 'ref' && f.ref) def += ` REFERENCES ${table(f.ref)} (${quoteIdent('id')})`;
    columns.push(def);
  }
  return `CREATE TABLE IF NOT EXISTS ${table(c.name)} (\n  ${columns.join(',\n  ')}\n);`;
}

/** `CREATE TABLE IF NOT EXISTS app.<collection>` for every collection, ref targets first. */
export function schemaToSql(input: AppSchemaInput): string {
  const schema = validateAppSchema(input);
  return `${orderCollections(schema.collections).order.map(createTable).join('\n\n')}\n`;
}

export type PolicyCommand = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

const COMMAND: Record<Op, PolicyCommand> = { read: 'SELECT', create: 'INSERT', update: 'UPDATE', delete: 'DELETE' };

/** One generated policy. `using` / `withCheck` are SQL boolean expressions, or null when the clause is absent. */
export interface PolicyDefinition {
  name: string;
  table: string;
  command: PolicyCommand;
  using: string | null;
  withCheck: string | null;
}

/** Scope → row filter per the contract §3 table; null means `true`. */
function rowFilter(c: CollectionDef, op: Op, scope: Exclude<Scope, 'none'>, clause: 'using' | 'check'): string | null {
  if (scope === 'all') return null;
  const mine = `${quoteIdent(ownerFieldOf(c))} = kelay.uid()`;
  if (scope === 'mine') return mine;
  if (clause === 'check') return op === 'create' ? null : mine;
  return c.shared ? `(${mine} OR ${quoteIdent('shared')})` : mine;
}

/** The policy for one role × collection × op, or null when the scope is `none` (no policy, so denied). */
export function policyDefinition(c: CollectionDef, role: string, op: Op, scope: Scope): PolicyDefinition | null {
  if (scope === 'none') return null;
  const predicate = (clause: 'using' | 'check') =>
    [`kelay.role() = ${identLiteral(role)}`, `${quoteIdent('org_id')} = kelay.org()`, rowFilter(c, op, scope, clause)]
      .filter((p): p is string => p !== null)
      .join(' AND ');
  return {
    name: policyName(c.name, op, role),
    table: table(c.name),
    command: COMMAND[op],
    using: op === 'create' ? null : predicate('using'),
    withCheck: op === 'create' || op === 'update' ? predicate('check') : null,
  };
}

function createPolicy(p: PolicyDefinition): string {
  let sql = `CREATE POLICY ${quoteIdent(p.name)} ON ${p.table} AS PERMISSIVE FOR ${p.command} TO ${quoteIdent(RUNTIME_DB_ROLE)}`;
  if (p.using) sql += `\n  USING (${p.using})`;
  if (p.withCheck) sql += `\n  WITH CHECK (${p.withCheck})`;
  return `${sql};`;
}

// Drops every policy named <table>_<op>_<role> on any table in the app schema, including tables
// and roles that are no longer in the schema, so a removed role cannot keep stale access.
const DROP_KELAY_POLICIES = `DO $kelay$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT policyname, tablename FROM pg_policies
    WHERE schemaname = ${identLiteral(APP_DB_SCHEMA)}
      AND left(policyname, length(tablename) + 1) = tablename || '_'
      AND substr(policyname, length(tablename) + 2) ~ '^(read|create|update|delete)_[a-z][a-z0-9_]*$'
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', p.policyname, ${identLiteral(APP_DB_SCHEMA)}, p.tablename);
  END LOOP;
END
$kelay$;`;

/** ENABLE + FORCE RLS, replace the kelay-named policies, and grant table access to kelay_runtime. */
export function policyToSql(schemaInput: AppSchemaInput, matrixInput: PolicyMatrixInput): string {
  const matrix = validatePolicy(schemaInput, matrixInput);
  const schema = validateAppSchema(schemaInput);
  const collections = orderCollections(schema.collections).order;
  const runtime = quoteIdent(RUNTIME_DB_ROLE);
  const appSchema = quoteIdent(APP_DB_SCHEMA);

  const parts: string[] = [];
  for (const c of collections) {
    parts.push(`ALTER TABLE ${table(c.name)} ENABLE ROW LEVEL SECURITY;\nALTER TABLE ${table(c.name)} FORCE ROW LEVEL SECURITY;`);
  }
  parts.push(DROP_KELAY_POLICIES);
  for (const c of collections) {
    for (const role of schema.roles) {
      for (const op of Op.options) {
        const p = policyDefinition(c, role, op, matrix[role]?.[c.name]?.[op] ?? 'none');
        if (p) parts.push(createPolicy(p));
      }
    }
  }
  parts.push(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${appSchema} TO ${runtime};\n` +
      `GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${appSchema} TO ${runtime};`,
  );
  return `${parts.join('\n\n')}\n`;
}

let authSql: string | undefined;

/** Contents of `@kelay/contracts/sql/kelay_auth.sql`. */
export function kelayAuthSql(): string {
  // Node built-ins are loaded on demand so the rest of the package (validation, describePolicy)
  // stays importable from browser bundles such as the console.
  if (authSql === undefined) {
    const { createRequire } = process.getBuiltinModule('node:module');
    const { readFileSync } = process.getBuiltinModule('node:fs');
    const path = createRequire(import.meta.url).resolve('@kelay/contracts/sql/kelay_auth.sql');
    authSql = readFileSync(path, 'utf8');
  }
  return authSql;
}

/**
 * Full app database migration: kelay_auth.sql, tables, then RLS. Safe to re-run. It carries no
 * transaction control; send it as one query string (one implicit transaction) or wrap it yourself.
 */
export function migrationSql(schemaInput: AppSchemaInput, matrixInput: PolicyMatrixInput): string {
  const schema = validateAppSchema(schemaInput);
  validatePolicy(schema, matrixInput);
  const sections = [
    `-- Generated by @kelay/policy for app ${schema.app}. Do not edit; regenerate from the app schema and policy.`,
    kelayAuthSql().trimEnd(),
    '-- Tables (contract §2)',
    schemaToSql(schema).trimEnd(),
    '-- Row level security (contract §3)',
    policyToSql(schema, matrixInput).trimEnd(),
  ];
  return `${sections.join('\n\n')}\n`;
}
