// Reads a PolicyMatrix (contracts §3) as plain-language rules and as the Postgres policies it
// compiles to. The SQL here is for display; the policy compiler owns what actually installs.
import type { AccessSample, AppSchema, Op, PolicyMatrix, Scope } from '@/lib/api/types';

export type CollectionDef = AppSchema['collections'][number];

export const OPS: readonly Op[] = ['read', 'create', 'update', 'delete'];
const SCOPE_ORDER: readonly Scope[] = ['all', 'mine_shared', 'mine'];
const SQL_OP: Record<Op, string> = { read: 'select', create: 'insert', update: 'update', delete: 'delete' };
const VERB: Record<Op, string> = { read: 'view', create: 'create', update: 'edit', delete: 'delete' };

export interface RuleRow {
  key: string;
  role: string;
  scope: Scope;
  ops: Op[];
}

export const ruleKey = (role: string, scope: Scope) => `${role}:${scope}`;

export const scopeOf = (matrix: PolicyMatrix, role: string, collection: string, op: Op): Scope =>
  matrix[role]?.[collection]?.[op] ?? 'none';

/** `mine_shared` means `mine` on a collection without a `shared` column. */
export const effectiveScope = (c: CollectionDef, scope: Scope): Scope => (scope === 'mine_shared' && !c.shared ? 'mine' : scope);

export const ownerField = (c: CollectionDef): string => c.ownerField ?? 'owner_id';

/** One row per role × scope, listing the ops that role has at that scope. */
export function rulesFor(schema: AppSchema, matrix: PolicyMatrix, collection: string): RuleRow[] {
  const rows: RuleRow[] = [];
  for (const role of schema.roles) {
    for (const scope of SCOPE_ORDER) {
      const ops = OPS.filter((op) => scopeOf(matrix, role, collection, op) === scope);
      if (ops.length) rows.push({ key: ruleKey(role, scope), role, scope, ops });
    }
  }
  return rows;
}

export const roleLabel = (role: string): string => {
  const words = role.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1) + (words.endsWith('s') ? '' : 's');
};

export const roleName = (role: string): string => {
  const words = role.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export const collectionNoun = (c: CollectionDef): string => (c.label ?? c.name.replace(/_/g, ' ')).toLowerCase();

function ownerPhrase(c: CollectionDef): string {
  const field = ownerField(c);
  if (field === 'owner_id') return 'they created';
  const noun = field.replace(/_id$/, '').replace(/_/g, ' ');
  return noun === 'assignee' ? 'assigned to them' : `where they are the ${noun}`;
}

export function verbs(ops: readonly Op[]): string {
  const words = ops.map((op) => VERB[op]);
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : (words[0] ?? '');
}

/** The object of the rule sentence: "<Role> can <verbs> <scopePhrase>". */
export function scopePhrase(c: CollectionDef, scope: Scope, ops: readonly Op[]): string {
  const noun = collectionNoun(c);
  const s = effectiveScope(c, scope);
  const onlyCreate = ops.length === 1 && ops[0] === 'create';
  if (s === 'none') return `no ${noun}`;
  if (s === 'all') return onlyCreate ? noun : `all ${noun}`;
  if (s === 'mine_shared') return onlyCreate ? noun : `${noun} ${ownerPhrase(c)} or shared with the team`;
  return `${noun} ${ownerPhrase(c)}`;
}

function predicate(c: CollectionDef, scope: Scope, op: Op, clause: 'using' | 'check'): string | null {
  const s = effectiveScope(c, scope);
  const owner = `${ownerField(c)} = kelay.uid()`;
  if (s === 'all') return null;
  if (s === 'mine') return owner;
  if (op === 'create') return null;
  if (op === 'update' && clause === 'check') return owner;
  return `(${owner} or shared)`;
}

/** Policy for one role × collection × op, named `<collection>_<op>_<role>` (contracts §3). */
export function policySql(c: CollectionDef, role: string, op: Op, scope: Scope): string {
  const name = `${c.name}_${op}_${role}`;
  if (effectiveScope(c, scope) === 'none') return `-- ${name}: no policy, so ${VERB[op]} is denied`;
  const body = (clause: 'using' | 'check') =>
    ['org_id = kelay.org()', `kelay.role() = '${role}'`, predicate(c, scope, op, clause)]
      .filter((x): x is string => x !== null)
      .map((x, i) => `  ${i ? 'and ' : ''}${x}`)
      .join('\n');
  const clauses =
    op === 'create' ? [`with check (\n${body('check')}\n)`]
    : op === 'update' ? [`using (\n${body('using')}\n)`, `with check (\n${body('check')}\n)`]
    : [`using (\n${body('using')}\n)`];
  return `create policy "${name}"\non app.${c.name} for ${SQL_OP[op]}\n${clauses.join('\n')};`;
}

export const withScope = (matrix: PolicyMatrix, role: string, collection: string, ops: readonly Op[], scope: Scope): PolicyMatrix => {
  const current = matrix[role]?.[collection] ?? { read: 'none', create: 'none', update: 'none', delete: 'none' };
  const next = { ...current };
  for (const op of ops) next[op] = scope;
  return { ...matrix, [role]: { ...matrix[role], [collection]: next } };
};

/** Rows a member with `role` can read, as RLS would return them. */
export function visibleSamples(c: CollectionDef, matrix: PolicyMatrix, role: string, userId: string, samples: readonly AccessSample[]): AccessSample[] {
  const s = effectiveScope(c, scopeOf(matrix, role, c.name, 'read'));
  if (s === 'all') return [...samples];
  if (s === 'none') return [];
  return samples.filter((r) => r.ownerId === userId || (s === 'mine_shared' && r.shared));
}
