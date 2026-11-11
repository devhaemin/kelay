// Human-readable view of a policy for the console's policy view and "preview as <role>".
// It is built from the same policyDefinition() that generates the SQL, so the two cannot drift.
import { Op, type CollectionDef, type Scope } from '@kelay/contracts';
import { policyDefinition, type PolicyDefinition } from './sql.ts';
import { ownerFieldOf, validateAppSchema, validatePolicy, type AppSchemaInput, type PolicyMatrixInput } from './validate.ts';

export interface OpSummary {
  op: Op;
  /** Scope as declared; a missing matrix entry is `none`. */
  scope: Scope;
  allowed: boolean;
  /** One sentence, e.g. "Can read tickets where assignee_id is them, plus shared tickets." */
  text: string;
  /** The generated RLS policy, or null when the op is denied. */
  policy: PolicyDefinition | null;
}

export interface CollectionSummary {
  collection: string;
  label: string;
  ownerField: string;
  shared: boolean;
  ops: Record<Op, OpSummary>;
}

export interface RoleSummary {
  role: string;
  collections: CollectionSummary[];
}

export interface PolicySummary {
  app: string;
  roles: RoleSummary[];
}

function sentence(c: CollectionDef, op: Op, scope: Scope): string {
  const name = c.name;
  const owner = ownerFieldOf(c);
  const mine = owner === 'owner_id' ? `their own ${name}` : `${name} where ${owner} is them`;
  const andShared = c.shared ? `, plus shared ${name}` : '';
  if (scope === 'none') return `Cannot ${op} ${name}.`;
  switch (op) {
    case 'read':
    case 'delete':
      if (scope === 'all') return `Can ${op} all ${name} in their org.`;
      return `Can ${op} ${mine}${scope === 'mine_shared' ? andShared : ''}.`;
    case 'create':
      if (scope === 'mine' && owner !== 'owner_id') return `Can create ${name} only with ${owner} set to them.`;
      return `Can create ${name}.`;
    case 'update':
      if (scope === 'all') return `Can update all ${name} in their org.`;
      if (scope === 'mine' || !c.shared) return `Can update ${mine}.`;
      return `Can update ${mine}${andShared}, as long as ${owner} is them afterwards.`;
  }
}

/** Every declared role × collection × op, including the denied ones. */
export function describePolicy(schemaInput: AppSchemaInput, matrixInput: PolicyMatrixInput): PolicySummary {
  const schema = validateAppSchema(schemaInput);
  const matrix = validatePolicy(schema, matrixInput);
  return {
    app: schema.app,
    roles: schema.roles.map((role) => ({
      role,
      collections: schema.collections.map((c) => {
        const ops = Object.fromEntries(
          Op.options.map((op) => {
            const scope = matrix[role]?.[c.name]?.[op] ?? 'none';
            const summary: OpSummary = {
              op,
              scope,
              allowed: scope !== 'none',
              text: sentence(c, op, scope),
              policy: policyDefinition(c, role, op, scope),
            };
            return [op, summary];
          }),
        ) as Record<Op, OpSummary>;
        return { collection: c.name, label: c.label ?? c.name, ownerField: ownerFieldOf(c), shared: c.shared ?? false, ops };
      }),
    })),
  };
}
