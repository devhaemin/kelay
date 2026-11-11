import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphSpec, NodeInvocation } from '@kelay/contracts';
import { compileToAsl, GraphRunError, INVALID_REVIEW_ERROR, runLocal, type NodeHandler, type RunResult } from './index.ts';
import { overdueSummaryGraph } from './testing/fixtures.ts';
import { interpretAsl } from './testing/interpret-asl.ts';

const base = { userToken: 'user.jwt', app: 'ticket-board', env: 'dev', runId: 'run-1' } as const;

/** Runs with fake timers so retry intervals and timeouts elapse instantly. */
async function settle(start: () => Promise<RunResult>): Promise<{ result?: RunResult; error?: unknown }> {
  vi.useFakeTimers();
  const settled = start().then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  return settled;
}

afterEach(() => {
  vi.useRealTimers();
});

const steps = (r: RunResult) => r.trace.map((t) => `${t.node}#${t.attempt}@${t.loop}:${t.status}`);

const fixtureHandlers = (review: (inv: NodeInvocation) => unknown): Record<string, NodeHandler> => ({
  collect: (inv) => ({ tickets: ['t1', 't2'], loop: inv.loop }),
  summarize: (inv) => ({ summary: `summary ${inv.loop}` }),
  prioritize: () => ({ top: 't1' }),
  review,
});

describe('runLocal', () => {
  it('feeds parallel branch outputs to the join node as an array in next order', async () => {
    let joinInput: unknown;
    const handlers = {
      ...fixtureHandlers((inv) => {
        joinInput = inv.input;
        return { approved: true };
      }),
      summarize: () => new Promise((resolve) => setTimeout(() => resolve({ summary: 'slow' }), 50)),
    };
    const { result } = await settle(() => runLocal(overdueSummaryGraph(), handlers, { ...base, input: { since: '2026-11-01' } }));
    expect(joinInput).toEqual([{ summary: 'slow' }, { top: 't1' }]);
    expect(result?.output).toEqual({ approved: true });
    expect(result?.trace[0]).toMatchObject({ node: 'collect', input: { since: '2026-11-01' }, status: 'ok' });
  });

  it('passes the NodeInvocation contract to every handler', async () => {
    const seen: NodeInvocation[] = [];
    const handler: NodeHandler = (inv) => {
      seen.push(inv);
      return inv.node === 'review' ? { approved: true } : { ok: inv.node };
    };
    await runLocal(overdueSummaryGraph(), handler, { ...base, input: 7 });
    expect(seen[0]).toEqual({
      runId: 'run-1',
      app: 'ticket-board',
      env: 'dev',
      graph: 'overdue-summary',
      node: 'collect',
      attempt: 1,
      loop: 0,
      input: 7,
      userToken: 'user.jwt',
    });
  });

  it('goes back to onReject with the review output, then continues once approved', async () => {
    const r = await runLocal(
      overdueSummaryGraph(),
      fixtureHandlers((inv) => ({ approved: inv.loop >= 1, feedback: `loop ${inv.loop}` })),
      { ...base, input: null },
    );
    expect(steps(r)).toEqual([
      'collect#1@0:ok',
      'summarize#1@0:ok',
      'prioritize#1@0:ok',
      'review#1@0:ok',
      'collect#1@1:ok',
      'summarize#1@1:ok',
      'prioritize#1@1:ok',
      'review#1@1:ok',
    ]);
    expect(r.trace[4]!.input).toEqual({ approved: false, feedback: 'loop 0' });
    expect(r.output).toEqual({ approved: true, feedback: 'loop 1' });
  });

  it('stops looping after maxLoops rejections and ends with the last review output', async () => {
    const r = await runLocal(overdueSummaryGraph(), fixtureHandlers((inv) => ({ approved: false, loop: inv.loop })), {
      ...base,
      input: null,
    });
    expect(r.trace.filter((t) => t.node === 'review').map((t) => t.loop)).toEqual([0, 1, 2]);
    expect(r.trace.filter((t) => t.node === 'collect')).toHaveLength(3);
    expect(r.output).toEqual({ approved: false, loop: 2 });
  });

  it('retries a thrown error with attempt numbers and the configured backoff', async () => {
    const handlers = {
      ...fixtureHandlers(() => ({ approved: true })),
      summarize: (inv: NodeInvocation) => {
        if (inv.attempt < 3) throw new Error(`overloaded ${inv.attempt}`);
        return { summary: 'third time' };
      },
    };
    const { result } = await settle(() => runLocal(overdueSummaryGraph(), handlers, { ...base, input: null }));
    const tries = result!.trace.filter((t) => t.node === 'summarize');
    expect(tries.map((t) => [t.attempt, t.status, t.message])).toEqual([
      [1, 'error', 'overloaded 1'],
      [2, 'error', 'overloaded 2'],
      [3, 'ok', undefined],
    ]);
    // intervalSeconds 2, backoffRate 2
    expect(tries[1]!.startedAt - tries[0]!.startedAt).toBe(2000);
    expect(tries[2]!.startedAt - tries[1]!.startedAt).toBe(4000);
    expect(result!.trace.find((t) => t.node === 'review')!.input).toEqual([{ summary: 'third time' }, { top: 't1' }]);
  });

  it('fails with the error name once retries are exhausted', async () => {
    class ModelError extends Error {
      override name = 'ModelError';
    }
    const handlers = {
      ...fixtureHandlers(() => ({ approved: true })),
      summarize: () => {
        throw new ModelError('still down');
      },
    };
    const { error } = await settle(() => runLocal(overdueSummaryGraph(), handlers, { ...base, input: null }));
    expect(error).toBeInstanceOf(GraphRunError);
    expect(error).toMatchObject({ node: 'summarize', error: 'ModelError' });
    expect((error as GraphRunError).trace.filter((t) => t.node === 'summarize')).toHaveLength(3);
  });

  it('times out a node with States.Timeout and aborts its signal', async () => {
    let signal: AbortSignal | undefined;
    const handlers = {
      ...fixtureHandlers(() => ({ approved: true })),
      collect: (_inv: NodeInvocation, ctx: { signal: AbortSignal }) => {
        signal = ctx.signal;
        return new Promise(() => {});
      },
    };
    const { error } = await settle(() => runLocal(overdueSummaryGraph(), handlers, { ...base, input: null }));
    expect(error).toMatchObject({ name: 'GraphRunError', node: 'collect', error: 'States.Timeout' });
    expect((error as GraphRunError).trace[0]).toMatchObject({ status: 'timeout', ms: 30_000 });
    expect(signal?.aborted).toBe(true);
  });

  it('retries a timed-out attempt with a fresh timeout', async () => {
    const spec: GraphSpec = { name: 'g1', start: 'a', nodes: { a: { timeoutSeconds: 1, retry: { maxAttempts: 1 } } } };
    const { result } = await settle(() =>
      runLocal(spec, { a: (inv) => (inv.attempt === 1 ? new Promise(() => {}) : 'done') }, { ...base, input: null }),
    );
    expect(steps(result!)).toEqual(['a#1@0:timeout', 'a#2@0:ok']);
    expect(result!.output).toBe('done');
  });

  it('fails the fan-out when a branch fails and aborts the sibling', async () => {
    let sibling: AbortSignal | undefined;
    const handlers = {
      ...fixtureHandlers(() => ({ approved: true })),
      summarize: (_inv: NodeInvocation, ctx: { signal: AbortSignal }) => {
        sibling = ctx.signal;
        return new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      },
      prioritize: () => {
        throw new TypeError('bad ticket');
      },
    };
    const { error } = await settle(() => runLocal(overdueSummaryGraph(), handlers, { ...base, input: null }));
    expect(error).toMatchObject({ node: 'prioritize', error: 'TypeError' });
    expect(sibling?.aborted).toBe(true);
  });

  it('fails when a review node does not output a boolean approved', async () => {
    await expect(
      runLocal(overdueSummaryGraph(), fixtureHandlers(() => ({ verdict: 'ok' })), { ...base, input: null }),
    ).rejects.toMatchObject({ node: 'review', error: INVALID_REVIEW_ERROR });
  });

  it('passes values as JSON, as Step Functions does', async () => {
    const spec: GraphSpec = { name: 'g1', start: 'a', nodes: { a: { next: 'b' }, b: {} } };
    const r = await runLocal(spec, { a: () => ({ at: new Date(0), skip: undefined }), b: () => undefined }, { ...base, input: undefined });
    expect(r.trace.map((t) => t.input)).toEqual([null, { at: '1970-01-01T00:00:00.000Z' }]);
    expect(r.output).toBeNull();
  });

  it('requires a handler for every node and a valid graph', async () => {
    await expect(runLocal(overdueSummaryGraph(), { collect: () => 1 }, { ...base, input: null })).rejects.toThrow(
      /no handler for node\(s\) summarize, prioritize, review/,
    );
    await expect(runLocal({ name: 'g1', start: 'x', nodes: {} }, () => 1, { ...base, input: null })).rejects.toThrow(/invalid graph/);
  });
});

describe('runLocal and the compiled state machine agree', () => {
  const scenario = (approve: (loop: number) => boolean, failFirstSummarize = false) => (inv: NodeInvocation) => {
    switch (inv.node) {
      case 'summarize':
        if (failFirstSummarize && inv.attempt === 1) throw new Error('overloaded');
        return { summary: `loop ${inv.loop} attempt ${inv.attempt}` };
      case 'review':
        return { approved: approve(inv.loop), seen: inv.input };
      default:
        return { node: inv.node, loop: inv.loop, input: inv.input };
    }
  };
  const scenarios = {
    'approves at once': scenario(() => true),
    'rejects once': scenario((loop) => loop >= 1),
    'never approves': scenario(() => false),
    'retries a failed branch': scenario(() => true, true),
  };

  for (const [title, handler] of Object.entries(scenarios)) {
    it(title, async () => {
      const spec = overdueSummaryGraph();
      const input = { since: '2026-11-01' };
      const local: NodeInvocation[] = [];
      const { result } = await settle(() =>
        runLocal(spec, (inv) => (local.push(inv), handler(inv)), { ...base, env: 'prod', runId: 'run-7', input }),
      );
      vi.useRealTimers();

      const remote: NodeInvocation[] = [];
      const asl = compileToAsl(spec, { app: base.app, env: 'prod', functionArn: 'arn:aws:lambda:ap-northeast-2:1:function:nodes' });
      const output = await interpretAsl(asl, { input, userToken: base.userToken }, (_fn, payload) => {
        remote.push(payload as NodeInvocation);
        return handler(payload as NodeInvocation);
      }, 'run-7');

      const sorted = (xs: NodeInvocation[]) => xs.map((x) => JSON.stringify(x)).sort();
      expect(sorted(remote)).toEqual(sorted(local));
      expect(output).toEqual(result!.output);
    });
  }
});
