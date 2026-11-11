import { describe, expect, it } from 'vitest';
import { GraphError, validateGraph } from './index.ts';
import { overdueSummaryGraph } from './testing/fixtures.ts';

const problemsOf = (spec: unknown): string[] => {
  try {
    validateGraph(spec);
  } catch (e) {
    if (e instanceof GraphError) return e.problems.map((p) => `${p.path.join('.')}: ${p.message}`);
    throw e;
  }
  return [];
};

describe('validateGraph', () => {
  it('accepts the ticket-board fixture, whose only cycle goes through review.onReject', () => {
    expect(validateGraph(overdueSummaryGraph()).start).toBe('collect');
  });

  it('reports schema problems with their paths', () => {
    const problems = problemsOf({ name: 'Bad Name', start: 'a', nodes: { a: { timeoutSeconds: 0 } } });
    expect(problems).toEqual(expect.arrayContaining([expect.stringMatching(/^name: /), expect.stringMatching(/^nodes\.a\.timeoutSeconds: /)]));
  });

  it('reports every unknown reference', () => {
    expect(
      problemsOf({ name: 'g1', start: 'nope', nodes: { a: { next: 'b' }, c: { review: { onReject: 'zz', maxLoops: 1 } } } }),
    ).toEqual([
      'start: unknown node "nope"',
      'nodes.a.next: unknown node "b"',
      'nodes.c.review.onReject: unknown node "zz"',
    ]);
  });

  it('requires parallel branches to share one join node', () => {
    const problems = problemsOf({
      name: 'g1',
      start: 'a',
      nodes: { a: { next: ['b', 'c'] }, b: { next: 'd' }, c: { next: 'e' }, d: { next: 'e' }, e: {} },
    });
    expect(problems).toEqual(['nodes.a.next: parallel branches must share one join node, found "d", "e"']);
  });

  it('requires each branch to be a single node with a single next and no review', () => {
    const problems = problemsOf({
      name: 'g1',
      start: 'a',
      nodes: {
        a: { next: ['b', 'c', 'f'] },
        b: { next: ['d', 'e'] },
        c: {},
        f: { next: 'g', review: { onReject: 'a', maxLoops: 1 } },
        d: { next: 'g' },
        e: { next: 'g' },
        g: {},
      },
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        'nodes.b.next: parallel branch "b" must point to exactly one join node',
        'nodes.c.next: parallel branch "c" must point to exactly one join node',
        'nodes.f.review: parallel branch "f" cannot have a review',
      ]),
    );
  });

  it('keeps branch nodes private to their fan-out', () => {
    const problems = problemsOf({
      name: 'g1',
      start: 'b',
      nodes: {
        a: { next: ['b', 'c'] },
        b: { next: 'j' },
        c: { next: 'j' },
        j: { next: 'k', review: { onReject: 'c', maxLoops: 1 } },
        k: { next: ['b', 'x'] },
        x: { next: 'j' },
        y: { next: 'b' },
      },
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        'nodes.k.next: "b" is already a parallel branch of "a"',
        'start: start node "b" cannot be a parallel branch',
        'nodes.y.next: "b" is a parallel branch of "a" and cannot be entered from "y"',
        'nodes.j.review.onReject: "c" is a parallel branch and cannot be a review target',
      ]),
    );
  });

  it('rejects duplicate branches', () => {
    expect(problemsOf({ name: 'g1', start: 'a', nodes: { a: { next: ['b', 'b'] }, b: { next: 'c' }, c: {} } })).toEqual([
      'nodes.a.next: parallel branches must be distinct',
    ]);
  });

  it('rejects cycles that do not go through a review', () => {
    expect(problemsOf({ name: 'g1', start: 'a', nodes: { a: { next: 'b' }, b: { next: 'c' }, c: { next: 'a' } } })).toEqual([
      'nodes.a.next: cycle through next edges (a → b → c → a); loops must go through review.onReject',
    ]);
  });

  it('rejects unreachable nodes', () => {
    expect(problemsOf({ name: 'g1', start: 'a', nodes: { a: {}, orphan: { next: 'a' } } })).toEqual([
      'nodes.orphan: node "orphan" is unreachable from "a"',
    ]);
  });

  it('counts review.onReject edges as reachable', () => {
    expect(
      problemsOf({ name: 'g1', start: 'a', nodes: { a: { review: { onReject: 'fix', maxLoops: 1 } }, fix: { next: 'a' } } }),
    ).toEqual([]);
  });

  it('throws a GraphError whose message lists the problems', () => {
    expect(() => validateGraph({ name: 'g1', start: 'a', nodes: { a: { next: 'b' } } })).toThrow(
      /invalid graph:\n- nodes\.a\.next: unknown node "b"/,
    );
  });
});
