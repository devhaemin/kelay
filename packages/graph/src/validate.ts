// Graph validation (contract §10): the Zod shape from @kelay/contracts plus the semantic rules
// the compiler and the local runner rely on.
import { GraphSpec, type GraphNode } from '@kelay/contracts';

export interface GraphProblem {
  path: (string | number)[];
  message: string;
}

export class GraphError extends Error {
  readonly problems: GraphProblem[];
  constructor(problems: GraphProblem[]) {
    super(`invalid graph:\n${problems.map((p) => `- ${p.path.join('.') || '(root)'}: ${p.message}`).join('\n')}`);
    this.name = 'GraphError';
    this.problems = problems;
  }
}

export function nextTargets(node: GraphNode): string[] {
  return node.next === undefined ? [] : typeof node.next === 'string' ? [node.next] : node.next;
}

/** Parses and checks a graph; throws `GraphError` listing every problem found. */
export function validateGraph(spec: unknown): GraphSpec {
  const parsed = GraphSpec.safeParse(spec);
  if (!parsed.success) {
    throw new GraphError(
      parsed.error.issues.map((i) => ({
        path: i.path.map((p) => (typeof p === 'symbol' ? String(p) : p)),
        message: i.message,
      })),
    );
  }
  const problems = semanticProblems(parsed.data);
  if (problems.length > 0) throw new GraphError(problems);
  return parsed.data;
}

function semanticProblems(g: GraphSpec): GraphProblem[] {
  const problems: GraphProblem[] = [];
  const add = (path: GraphProblem['path'], message: string) => problems.push({ path, message });
  const has = (n: string) => Object.hasOwn(g.nodes, n);
  const nodes = Object.entries(g.nodes);

  if (!has(g.start)) add(['start'], `unknown node "${g.start}"`);
  for (const [name, node] of nodes) {
    for (const t of nextTargets(node)) if (!has(t)) add(['nodes', name, 'next'], `unknown node "${t}"`);
    if (node.review && !has(node.review.onReject)) {
      add(['nodes', name, 'review', 'onReject'], `unknown node "${node.review.onReject}"`);
    }
  }
  // The structural checks below walk edges and assume every reference resolves.
  if (problems.length > 0) return problems;

  const branchOf = new Map<string, string>();
  for (const [name, node] of nodes) {
    if (!Array.isArray(node.next)) continue;
    if (new Set(node.next).size !== node.next.length) add(['nodes', name, 'next'], 'parallel branches must be distinct');
    const joins = new Set<string>();
    for (const b of node.next) {
      const owner = branchOf.get(b);
      if (owner === undefined) branchOf.set(b, name);
      else if (owner !== name) add(['nodes', name, 'next'], `"${b}" is already a parallel branch of "${owner}"`);
      const branch = g.nodes[b]!;
      if (typeof branch.next === 'string') joins.add(branch.next);
      else add(['nodes', b, 'next'], `parallel branch "${b}" must point to exactly one join node`);
      if (branch.review) add(['nodes', b, 'review'], `parallel branch "${b}" cannot have a review`);
    }
    if (joins.size > 1) {
      add(['nodes', name, 'next'], `parallel branches must share one join node, found ${[...joins].map((j) => `"${j}"`).join(', ')}`);
    }
  }

  if (branchOf.has(g.start)) add(['start'], `start node "${g.start}" cannot be a parallel branch`);
  for (const [name, node] of nodes) {
    if (typeof node.next === 'string' && branchOf.has(node.next)) {
      add(['nodes', name, 'next'], `"${node.next}" is a parallel branch of "${branchOf.get(node.next)}" and cannot be entered from "${name}"`);
    }
    if (node.review && branchOf.has(node.review.onReject)) {
      add(['nodes', name, 'review', 'onReject'], `"${node.review.onReject}" is a parallel branch and cannot be a review target`);
    }
  }

  const cycle = findNextCycle(g);
  if (cycle) add(['nodes', cycle[0]!, 'next'], `cycle through next edges (${cycle.join(' → ')}); loops must go through review.onReject`);

  const reached = new Set<string>();
  const queue = has(g.start) ? [g.start] : [];
  for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
    if (reached.has(n)) continue;
    reached.add(n);
    const node = g.nodes[n]!;
    queue.push(...nextTargets(node), ...(node.review ? [node.review.onReject] : []));
  }
  for (const [name] of nodes) if (!reached.has(name)) add(['nodes', name], `node "${name}" is unreachable from "${g.start}"`);

  return problems;
}

function findNextCycle(g: GraphSpec): string[] | undefined {
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const visit = (n: string): string[] | undefined => {
    if (state.get(n) === 'done') return undefined;
    if (state.get(n) === 'open') return [...stack.slice(stack.indexOf(n)), n];
    state.set(n, 'open');
    stack.push(n);
    for (const t of nextTargets(g.nodes[n]!)) {
      const found = visit(t);
      if (found) return found;
    }
    stack.pop();
    state.set(n, 'done');
    return undefined;
  };
  for (const n of Object.keys(g.nodes)) {
    const found = visit(n);
    if (found) return found;
  }
  return undefined;
}
