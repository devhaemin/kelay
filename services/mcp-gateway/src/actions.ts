// `action_<name>` tools and A2A messages hand off to an ActionRunner. The real one starts the action's
// agent graph through the run orchestrator as the calling user (infrastructure §4.5, contract §13),
// waits a bounded time and returns the run's output. Without a runner the default answers with an error.
import { CALLER_HEADER, ErrorCode, type ActionDef, type KelayClaims } from '@kelay/contracts';
import { signCallerToken } from '@kelay/tokens';
import { z } from 'zod';

/** On whose behalf the gateway starts the run: a member's assistant, or another app. */
export interface ActionCaller {
  kind: 'agent' | 'app';
  /** MCP client id for `agent`, source app slug for `app`. */
  id: string;
  name?: string;
}

export interface ActionCall {
  app: string;
  action: ActionDef;
  input: Record<string, unknown>;
  claims: KelayClaims;
  /** The user's token, for calls the run makes as that user. */
  userToken: string;
  caller: ActionCaller;
}

export type ActionFailure = 'unavailable' | 'rate_limited' | 'failed' | 'timeout' | 'unauthenticated';

export type ActionOutcome = { ok: true; output: unknown; runId?: string } | { ok: false; message: string; reason?: ActionFailure; runId?: string };

export interface ActionRunner {
  run(call: ActionCall): Promise<ActionOutcome>;
}

export const unavailableActionRunner: ActionRunner = {
  async run({ action }) {
    return { ok: false, reason: 'unavailable', message: `The "${action.name}" action isn't available yet.` };
  },
};

export interface RunnerActionOptions {
  /** RUNNER_URL */
  runnerUrl: string;
  /** KELAY_CALLER_SECRET */
  callerSecret: string;
  fetch?: typeof fetch;
  /** Milliseconds, for the wait deadline. */
  now?: () => number;
  /** Longest a call waits for its run (MCP_ACTION_WAIT_MS). @default 45000 */
  waitMs?: number;
  /** Seconds one request to the runner is held open; the runner allows at most 60. @default 20 */
  pollSeconds?: number;
  onError?: (error: Error) => void;
}

const Failure = z.object({ error: z.object({ code: ErrorCode, message: z.string() }) });
const Started = z.object({ runId: z.string().min(1) });
const RunView = z.object({
  run: z.object({
    status: z.enum(['running', 'succeeded', 'failed']),
    output: z.unknown(),
    error: z.object({ name: z.string(), message: z.string(), node: z.string().optional() }).nullish(),
  }),
});

const INTERNAL = 'Something went wrong on Kelay while running this action. Try again shortly.';

export function createRunnerActionRunner(opts: RunnerActionOptions): ActionRunner {
  const base = opts.runnerUrl.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const waitMs = opts.waitMs ?? 45_000;
  const pollSeconds = opts.pollSeconds ?? 20;

  return {
    async run({ app, action, input, userToken, caller }) {
      if (!action.graph) return { ok: false, reason: 'unavailable', message: `The "${action.name}" action has no agent graph to run.` };
      const headers = async () => ({
        authorization: `Bearer ${userToken}`,
        [CALLER_HEADER]: await signCallerToken({ kind: 'service', svc: 'mcp-gateway' }, opts.callerSecret),
      });
      const broken = (what: string): ActionOutcome => {
        opts.onError?.(new Error(`runner ${what} for ${app}/${action.name}`));
        return { ok: false, reason: 'failed', message: INTERNAL };
      };

      let res: Response;
      try {
        res = await doFetch(`${base}/v1/apps/${encodeURIComponent(app)}/runs`, {
          method: 'POST',
          headers: { ...(await headers()), 'content-type': 'application/json' },
          body: JSON.stringify({ graph: action.graph, input, action: action.name, caller }),
        });
      } catch (e) {
        return broken(`is unreachable (${(e as Error).message})`);
      }
      const body: unknown = await res.json().catch(() => undefined);
      if (!res.ok) {
        const failure = Failure.safeParse(body);
        const code = failure.success ? failure.data.error.code : undefined;
        if (code === 'rate_limited') {
          return { ok: false, reason: 'rate_limited', message: `Too many agent runs at once: ${failure.data!.error.message}.` };
        }
        if (code === 'not_found') return { ok: false, reason: 'unavailable', message: `The "${action.name}" action isn't deployed in this app yet.` };
        if (code === 'unauthenticated') {
          return { ok: false, reason: 'unauthenticated', message: 'Your sign-in for this app is no longer valid. Reconnect to continue.' };
        }
        return broken(`answered HTTP ${res.status}${failure.success ? ` ${failure.data.error.message}` : ''}`);
      }
      const started = Started.safeParse(body);
      if (!started.success) return broken('returned no run id');
      const { runId } = started.data;

      const deadline = now() + waitMs;
      for (;;) {
        const left = deadline - now();
        const wait = Math.max(0, Math.min(pollSeconds, Math.ceil(left / 1000)));
        let view;
        try {
          const got = await doFetch(`${base}/v1/runs/${runId}?wait=${wait}`, { headers: await headers() });
          view = RunView.safeParse(await got.json().catch(() => undefined));
          if (!got.ok || !view.success) return { ...broken(`answered HTTP ${got.status} for run ${runId}`), runId };
        } catch (e) {
          return { ...broken(`is unreachable (${(e as Error).message})`), runId };
        }
        const { run } = view.data;
        if (run.status === 'succeeded') return { ok: true, output: run.output ?? null, runId };
        if (run.status === 'failed') {
          return { ok: false, reason: 'failed', runId, message: `The "${action.name}" action failed: ${run.error?.message ?? 'the run did not finish'}` };
        }
        if (left <= 0) {
          return {
            ok: false,
            reason: 'timeout',
            runId,
            message: `The "${action.name}" action is still running after ${Math.round(waitMs / 1000)} seconds (run ${runId}). It keeps going; its result will show in the app.`,
          };
        }
      }
    },
  };
}
