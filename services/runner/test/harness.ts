// In-process rig: a dev Kelay ID signer, the Ticket Board fixture graph with scripted nodes, and a
// recorder that keeps what would go to the control API.
import { CALLER_HEADER, GraphSpec, audienceForApp, type KelayClaims, type NodeInvocation } from '@kelay/contracts';
import overdueSummary from '@kelay/contracts/fixtures/ticket-board/graph.overdue-summary.json' with { type: 'json' };
import { createDevSigner, signCallerToken } from '@kelay/tokens';
import { LocalRunDriver, createRunner, type LocalNodeHost, type LocalNodeResult, type RunDriver, type RunRecord, type RunnerDeps } from '../src/index.ts';

export const APP = 'ticket-board';
export const GRAPH = 'overdue-summary';
export const CALLER_SECRET = 'test-caller-secret-0123456789abcdef';

export const overdueSummaryGraph = (): GraphSpec => GraphSpec.parse(structuredClone(overdueSummary));

export type NodeScript = (invocation: NodeInvocation, host: LocalNodeHost) => LocalNodeResult | Promise<LocalNodeResult>;

/** collect → (summarize ∥ prioritize) → review, each answering at once unless a test overrides it. */
export const defaultNodes: Record<string, NodeScript> = {
  collect: () => ({ output: { tickets: ['t1', 't2'] } }),
  summarize: () => ({ output: { summary: '2 overdue' }, usage: { llmCalls: 1, costUsd: 0.004 } }),
  prioritize: () => ({ output: { order: ['t2', 't1'] }, usage: { llmCalls: 1, costUsd: 0.002 } }),
  review: (inv) => ({ output: { approved: true, branches: inv.input } }),
};

export async function setup(opts: { nodes?: Record<string, NodeScript>; driver?: RunDriver; maxConcurrentPerUser?: number } = {}) {
  const signer = await createDevSigner();
  const records: RunRecord[] = [];
  const errors: Error[] = [];
  const invocations: { invocation: NodeInvocation; host: LocalNodeHost }[] = [];
  const scripts = { ...defaultNodes, ...opts.nodes };
  const driver =
    opts.driver ??
    new LocalRunDriver({
      callerSecret: CALLER_SECRET,
      apps: {
        [APP]: {
          graphs: [overdueSummaryGraph()],
          invoke: async (invocation, host) => {
            invocations.push({ invocation, host });
            return scripts[invocation.node]!(invocation, host);
          },
        },
      },
    });
  const deps: RunnerDeps = {
    driver,
    jwks: signer.verifier,
    issuer: signer.issuer,
    callerSecret: CALLER_SECRET,
    record: (r) => void records.push(r),
    onError: (e) => void errors.push(e),
    ...(opts.maxConcurrentPerUser ? { maxConcurrentPerUser: opts.maxConcurrentPerUser } : {}),
  };
  const runner = createRunner(deps);

  const userToken = (claims: Partial<KelayClaims> = {}) =>
    signer.sign({ sub: 'u_junho', app: APP, org: 'orum', role: 'member', plan: 'team', aud: audienceForApp(APP), ...claims });
  const appCaller = (app = APP, env: 'dev' | 'prod' = 'prod') => signCallerToken({ kind: 'app-runtime', app, env }, CALLER_SECRET);
  const serviceCaller = (svc = 'mcp-gateway') => signCallerToken({ kind: 'service', svc }, CALLER_SECRET);

  interface Auth {
    token?: string | null;
    caller?: string | null;
  }
  async function headers(auth: Auth = {}): Promise<Record<string, string>> {
    const token = auth.token === undefined ? await userToken() : auth.token;
    const caller = auth.caller === undefined ? await appCaller() : auth.caller;
    return { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(caller ? { [CALLER_HEADER]: caller } : {}) };
  }

  async function start(body: Record<string, unknown> = { graph: GRAPH }, auth: Auth = {}, app = APP): Promise<{ status: number; body: any; headers: Headers }> {
    const res = await runner.request(`/v1/apps/${app}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await headers(auth)) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json(), headers: res.headers };
  }

  async function get(runId: string, auth: Auth = {}, query = '?wait=5'): Promise<{ status: number; body: any }> {
    const res = await runner.request(`/v1/runs/${runId}${query}`, { headers: await headers(auth) });
    return { status: res.status, body: await res.json() };
  }

  return { runner, signer, records, errors, invocations, userToken, appCaller, serviceCaller, headers, start, get };
}

/** A node that waits until the test lets it go. */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, wait: () => opened };
}
