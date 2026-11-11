// AppSchema + PolicyMatrix → Postgres DDL and RLS (contracts §2–§3).
export {
  PolicyError,
  orderCollections,
  ownerFieldOf,
  policyName,
  validateAppSchema,
  validatePolicy,
  type AppSchemaInput,
  type DeepReadonly,
  type PolicyMatrixInput,
  type PolicyProblem,
} from './validate.ts';
export {
  identLiteral,
  kelayAuthSql,
  migrationSql,
  policyDefinition,
  policyToSql,
  quoteIdent,
  schemaToSql,
  type PolicyCommand,
  type PolicyDefinition,
} from './sql.ts';
export { describePolicy, type CollectionSummary, type OpSummary, type PolicySummary, type RoleSummary } from './describe.ts';
