import { AppSchema, GraphSpec, PolicyMatrix } from '@kelay/contracts';
import { z } from 'zod';
import { KelayError } from './errors.ts';
import type { AppSchemaInput, GraphSpecInput, PolicyMatrixInput } from './types.ts';

function check<T>(what: string, validator: z.ZodType, value: T): T {
  const parsed = validator.safeParse(value);
  if (!parsed.success) throw new KelayError('invalid_request', `invalid ${what}:\n${z.prettifyError(parsed.error)}`);
  return value;
}

/** Validates an app schema and keeps its literal type, so `Row<typeof app, 'tickets'>` knows the fields. */
export function defineApp<const A extends AppSchemaInput>(schema: A): A {
  return check('app schema', AppSchema, schema);
}

export function definePolicy<const P extends PolicyMatrixInput>(matrix: P): P {
  return check('policy matrix', PolicyMatrix, matrix);
}

export function defineGraph<const G extends GraphSpecInput>(spec: G): G {
  return check('graph spec', GraphSpec, spec);
}
