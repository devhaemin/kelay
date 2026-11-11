// Semantic checks on top of the Zod contracts (contract §1–§3). Every SQL generator validates
// through here first, so generated SQL only ever contains names that matched IDENT.
import { AppSchema, Op, PolicyMatrix, RESERVED_COLUMNS, type CollectionDef } from '@kelay/contracts';

export type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** A schema or matrix as plain JSON, a parsed value, or an `as const` / `defineApp` value. */
export type AppSchemaInput = DeepReadonly<AppSchema>;
export type PolicyMatrixInput = DeepReadonly<PolicyMatrix>;

/** Postgres truncates longer identifiers (NAMEDATALEN - 1). */
const MAX_IDENT_LENGTH = 63;

export interface PolicyProblem {
  /** Dotted location, e.g. `schema.collections.tickets.fields.owner_id` or `policy.member.tickets`. */
  path: string;
  message: string;
}

export class PolicyError extends Error {
  readonly problems: PolicyProblem[];
  constructor(problems: PolicyProblem[]) {
    super(`invalid app schema or policy:\n${problems.map((p) => `- ${p.path}: ${p.message}`).join('\n')}`);
    this.name = 'PolicyError';
    this.problems = problems;
  }
}

interface ZodLikeIssue {
  path: readonly PropertyKey[];
  message: string;
}

const fromZod = (root: string, issues: readonly ZodLikeIssue[]): PolicyProblem[] =>
  issues.map((i) => ({ path: [root, ...i.path.map(String)].join('.'), message: i.message }));

export const ownerFieldOf = (c: Pick<CollectionDef, 'ownerField'>): string => c.ownerField ?? 'owner_id';

export const policyName = (collection: string, op: Op, role: string): string => `${collection}_${op}_${role}`;

/**
 * Collections in creation order: every ref target comes before the tables that reference it,
 * otherwise declaration order is kept. `cycle` lists collections that could not be ordered.
 */
export function orderCollections<C extends Pick<CollectionDef, 'name' | 'fields'>>(
  collections: readonly C[],
): { order: C[]; cycle: string[] } {
  const names = new Set(collections.map((c) => c.name));
  const deps = (c: C) =>
    Object.values(c.fields).flatMap((f) => (f.type === 'ref' && f.ref && f.ref !== c.name && names.has(f.ref) ? [f.ref] : []));
  const done = new Set<string>();
  const order: C[] = [];
  let progressed = true;
  while (progressed && order.length < collections.length) {
    progressed = false;
    for (const c of collections) {
      if (done.has(c.name) || !deps(c).every((d) => done.has(d))) continue;
      done.add(c.name);
      order.push(c);
      progressed = true;
    }
  }
  return { order, cycle: collections.filter((c) => !done.has(c.name)).map((c) => c.name) };
}

const duplicates = (values: readonly string[]): string[] =>
  [...new Set(values.filter((v, i) => values.indexOf(v) !== i))];

function schemaProblems(schema: AppSchema): PolicyProblem[] {
  const problems: PolicyProblem[] = [];
  const add = (path: string, message: string) => problems.push({ path: `schema.${path}`, message });
  const collectionNames = new Set(schema.collections.map((c) => c.name));
  const reserved: readonly string[] = RESERVED_COLUMNS;

  for (const r of duplicates(schema.roles)) add('roles', `duplicate role "${r}"`);
  for (const c of duplicates(schema.collections.map((c) => c.name))) add('collections', `duplicate collection "${c}"`);
  for (const a of duplicates((schema.actions ?? []).map((a) => a.name))) add('actions', `duplicate action "${a}"`);

  const checkRefs = (base: string, fields: AppSchema['collections'][number]['fields']) => {
    for (const [name, f] of Object.entries(fields)) {
      if (f.type === 'ref' && !f.ref) add(`${base}.${name}`, 'ref field needs a "ref" target collection');
      else if (f.type === 'ref' && f.ref && !collectionNames.has(f.ref)) add(`${base}.${name}`, `ref target "${f.ref}" is not a collection`);
      else if (f.type !== 'ref' && f.ref) add(`${base}.${name}`, `"ref" is only allowed on fields of type ref, not ${f.type}`);
    }
  };

  for (const c of schema.collections) {
    const base = `collections.${c.name}`;
    for (const name of Object.keys(c.fields)) {
      if (reserved.includes(name)) add(`${base}.fields.${name}`, `"${name}" is an implicit column and cannot be declared as a field`);
    }
    checkRefs(`${base}.fields`, c.fields);
    const owner = ownerFieldOf(c);
    if (owner !== 'owner_id' && c.fields[owner]?.type !== 'text') {
      add(`${base}.ownerField`, `ownerField must be "owner_id" or a text field of ${c.name}, got "${owner}"`);
    }
  }
  for (const a of schema.actions ?? []) checkRefs(`actions.${a.name}.input`, a.input);

  const { cycle } = orderCollections(schema.collections);
  if (cycle.length > 0) add('collections', `ref fields form a cycle, so tables cannot be created in order: ${cycle.join(', ')}`);
  return problems;
}

export function validateAppSchema(input: unknown): AppSchema {
  const parsed = AppSchema.safeParse(input);
  if (!parsed.success) throw new PolicyError(fromZod('schema', parsed.error.issues));
  const problems = schemaProblems(parsed.data);
  if (problems.length > 0) throw new PolicyError(problems);
  return parsed.data;
}

/** Validates the schema first (throwing its problems), then the matrix against it. */
export function validatePolicy(schemaInput: unknown, matrixInput: unknown): PolicyMatrix {
  const schema = validateAppSchema(schemaInput);
  const parsed = PolicyMatrix.safeParse(matrixInput);
  if (!parsed.success) throw new PolicyError(fromZod('policy', parsed.error.issues));

  const problems: PolicyProblem[] = [];
  const roles = new Set(schema.roles);
  const collections = new Set(schema.collections.map((c) => c.name));
  for (const [role, perCollection] of Object.entries(parsed.data)) {
    if (!roles.has(role)) problems.push({ path: `policy.${role}`, message: `role "${role}" is not declared in schema.roles` });
    for (const [collection, ops] of Object.entries(perCollection)) {
      if (!collections.has(collection)) {
        problems.push({ path: `policy.${role}.${collection}`, message: `collection "${collection}" is not declared in the schema` });
      }
      for (const op of Op.options) {
        const name = policyName(collection, op, role);
        if (ops[op] !== 'none' && name.length > MAX_IDENT_LENGTH) {
          problems.push({
            path: `policy.${role}.${collection}.${op}`,
            message: `policy name "${name}" exceeds ${MAX_IDENT_LENGTH} characters; shorten the role or collection name`,
          });
        }
      }
    }
  }
  if (problems.length > 0) throw new PolicyError(problems);
  return parsed.data;
}
