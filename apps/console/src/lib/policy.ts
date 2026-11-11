// Reads a PolicyMatrix (contracts §3) as plain-language rules and as the Postgres policies it
// compiles to. The SQL comes from @kelay/policy, the compiler that installs them.
import { policyDefinition } from '@kelay/policy';
import type { AccessSample, AppSchema, Op, PolicyMatrix, Scope } from './api/types';

export type CollectionDef = AppSchema['collections'][number];

export const OPS: readonly Op[] = ['read', 'create', 'update', 'delete'];
const SCOPE_ORDER: readonly Scope[] = ['all', 'mine_shared', 'mine'];
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

/** Policy for one role × collection × op, named `<collection>_<op>_<role>` (contracts §3). */
export function policySql(c: CollectionDef, role: string, op: Op, scope: Scope): string {
  const p = policyDefinition(c, role, op, scope);
  if (!p) return `-- ${c.name}_${op}_${role}: no policy, so ${VERB[op]} is denied`;
  const clause = (keyword: string, predicate: string | null) => (predicate ? [`${keyword} (\n  ${predicate.split(' AND ').join('\n  AND ')}\n)`] : []);
  return `CREATE POLICY "${p.name}"\nON ${p.table} FOR ${p.command}\n${[...clause('USING', p.using), ...clause('WITH CHECK', p.withCheck)].join('\n')};`;
}

/** Number of Postgres policies the matrix installs: one per role × collection × op that isn't `none`. */
export const countPolicies = (matrix: PolicyMatrix): number =>
  Object.values(matrix).reduce((n, byCollection) => n + Object.values(byCollection).reduce((m, ops) => m + OPS.filter((op) => ops[op] !== 'none').length, 0), 0);

export const withScope = (matrix: PolicyMatrix, role: string, collection: string, ops: readonly Op[], scope: Scope): PolicyMatrix => {
  const current = matrix[role]?.[collection] ?? { read: 'none', create: 'none', update: 'none', delete: 'none' };
  const next = { ...current };
  for (const op of ops) next[op] = scope;
  return { ...matrix, [role]: { ...matrix[role], [collection]: next } };
};

/** Whether a rule at `scope` lets `userId` act on a row they can already read. */
export const allowsRow = (scope: Scope, row: AccessSample, userId: string): boolean =>
  scope === 'all' || (scope !== 'none' && (row.ownerId === userId || (scope === 'mine_shared' && row.shared)));

/** Rows a member with `role` can read, as RLS would return them. */
export function visibleSamples(c: CollectionDef, matrix: PolicyMatrix, role: string, userId: string, samples: readonly AccessSample[]): AccessSample[] {
  const s = effectiveScope(c, scopeOf(matrix, role, c.name, 'read'));
  if (s === 'all') return [...samples];
  if (s === 'none') return [];
  return samples.filter((r) => r.ownerId === userId || (s === 'mine_shared' && r.shared));
}
