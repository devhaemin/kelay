// `kelay check`: is what the app declares in kelay/ something the platform can deploy? The manifest is
// output of agent-written code, so nothing in it is trusted before it passed through here.
import { NODE_FUNCTION_ARN_PLACEHOLDER, type AppSchema, type GraphSpec, type PolicyMatrix } from '@kelay/contracts';
import { GraphError, compileToAsl, validateGraph } from '@kelay/graph';
import { PolicyError, validatePolicy } from '@kelay/policy';
import type { Problem } from './events.ts';

export interface DeployableApp {
  schema: AppSchema;
  policy: PolicyMatrix;
  /** Step Functions definitions as the Control API's deploy route takes them (contracts §10). */
  graphs: { name: string; definition: string }[];
}

export type CheckResult = { ok: true; app: DeployableApp; problems: [] } | { ok: false; problems: Problem[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function checkManifest(app: string, manifest: unknown): CheckResult {
  if (!isObject(manifest)) return { ok: false, problems: [{ path: 'kelay', message: 'the app did not report a schema and a policy' }] };
  const problems: Problem[] = [];

  let schema: AppSchema | undefined;
  let policy: PolicyMatrix | undefined;
  try {
    policy = validatePolicy(manifest.schema, manifest.policy);
    schema = manifest.schema as AppSchema;
  } catch (e) {
    if (!(e instanceof PolicyError)) throw e;
    problems.push(...e.problems);
  }
  if (schema && schema.app !== app) problems.push({ path: 'schema.app', message: `must stay "${app}", got "${schema.app}"` });

  const specs: GraphSpec[] = [];
  const list = manifest.graphs ?? [];
  if (!Array.isArray(list)) problems.push({ path: 'graphs', message: 'must be a list of graphs' });
  else {
    list.forEach((g, i) => {
      try {
        specs.push(validateGraph(g));
      } catch (e) {
        if (!(e instanceof GraphError)) throw e;
        const name = isObject(g) && typeof g.name === 'string' ? g.name : String(i);
        problems.push(...e.problems.map((p) => ({ path: ['graphs', name, ...p.path].join('.'), message: p.message })));
      }
    });
  }
  const names = specs.map((g) => g.name);
  for (const name of new Set(names.filter((n, i) => names.indexOf(n) !== i))) problems.push({ path: `graphs.${name}`, message: 'two graphs have this name' });
  for (const action of schema?.actions ?? []) {
    if (action.graph && !names.includes(action.graph)) {
      problems.push({ path: `schema.actions.${action.name}.graph`, message: `graph "${action.graph}" is not declared in kelay/graphs.ts` });
    }
  }

  if (problems.length > 0 || !schema || !policy) return { ok: false, problems };
  return {
    ok: true,
    problems: [],
    app: {
      schema,
      policy,
      graphs: specs.map((g) => ({ name: g.name, definition: JSON.stringify(compileToAsl(g, { app, env: 'dev', functionArn: NODE_FUNCTION_ARN_PLACEHOLDER })) })),
    },
  };
}

export const describeProblems = (problems: Problem[]) => problems.map((p) => `- ${p.path}: ${p.message}`).join('\n');
