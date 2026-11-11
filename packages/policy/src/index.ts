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
