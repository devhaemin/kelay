// Action tools and A2A messages against the real run orchestrator, in process: the gateway starts
// the run, the runner executes the Ticket Board fixture graph with scripted nodes, and records it.
import { describe, expect, it, vi } from 'vitest';
import { CALLER_HEADER, GraphSpec, audienceForApp, type NodeInvocation } from '@kelay/contracts';
import overdueSummary from '@kelay/contracts/fixtures/ticket-board/graph.overdue-summary.json' with { type: 'json' };
import { LocalRunDriver, createRunner, type RunRecord } from '@kelay/runner';
import { signCallerToken } from '@kelay/tokens';
import { createRunnerActionRunner, type AppLinks } from '../src/index.ts';
import { BASE, CALLER_SECRET, CLIENT_ID, METADATA_URL, setup } from './harness.ts';

const A2A_PATH = '/orum/ticket-board/a2a';
const OUTPUT = { approved: true, summary: '2 overdue tickets', count: 2 };

type Script = (invocation: NodeInvocation) => unknown;

const textOf = (result: { content?: unknown }): string => ((result.content ?? []) as { text?: string }[])[0]?.text ?? '';

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, wait: () => opened };
}

async function rig(opts: { nodes?: Record<string, Script>; waitMs?: number; links?: AppLinks; runner?: boolean } = {}) {
  const records: RunRecord[] = [];
  const invocations: NodeInvocation[] = [];
  const scripts: Record<string, Script> = {
    collect: () => ({ tickets: ['t1', 't2'] }),
    summarize: () => ({ summary: OUTPUT.summary }),
    prioritize: () => ({ order: ['t2', 't1'] }),
    review: () => OUTPUT,
    ...opts.nodes,
  };
  const linkCalls: string[] = [];
  const links: AppLinks = opts.links ?? {
    connected: async (from, _to, kind) => from === 'team-wiki' && kind === 'A2A',
    recordCall: (from, to, kind) => void linkCalls.push(`${from}>${to}:${kind}`),
  };
  const s = await setup({
    links,
    ...(opts.runner === false
      ? {}
      : {
          actions: (signer) => {
            const runner = createRunner({
              driver: new LocalRunDriver({
                callerSecret: CALLER_SECRET,
                apps: {
                  'ticket-board': {
                    graphs: [GraphSpec.parse(structuredClone(overdueSummary))],
                    invoke: async (invocation) => {
                      invocations.push(invocation);
                      return { output: await scripts[invocation.node]!(invocation) };
                    },
                  },
                },
              }),
              jwks: signer.verifier,
              issuer: signer.issuer,
              callerSecret: CALLER_SECRET,
              record: (r) => void records.push(r),
            });
            return createRunnerActionRunner({
              runnerUrl: 'http://runner.test',
              callerSecret: CALLER_SECRET,
              fetch: (async (input: string | URL | Request, init?: RequestInit) => runner.fetch(new Request(input, init))) as typeof fetch,
              ...(opts.waitMs ? { waitMs: opts.waitMs } : {}),
            });
          },
        }),
  });

  const sendMessage = (parts: unknown[] = [{ text: 'Summarize my overdue tickets' }], extra: Record<string, unknown> = {}) => ({
    jsonrpc: '2.0',
    id: 7,
    method: 'SendMessage',
    params: { message: { messageId: 'm-1', role: 'ROLE_USER', parts, ...extra } },
  });

  /** `from` is the calling app's slug; without it the request comes from a member's own agent. */
  async function a2a(body: unknown, o: { bearer?: string | null; from?: string; caller?: string; version?: string | null } = {}) {
    const bearer = o.bearer === undefined ? await s.token(o.from || o.caller ? { aud: audienceForApp('ticket-board'), azp: undefined } : {}) : o.bearer;
    const caller = o.caller ?? (o.from ? await signCallerToken({ kind: 'app-runtime', app: o.from, env: 'prod' }, CALLER_SECRET) : undefined);
    const res = await s.gateway.request(A2A_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(o.version === null ? {} : { 'a2a-version': o.version ?? '1.0' }),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(caller ? { [CALLER_HEADER]: caller } : {}),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, body: (await res.json()) as any };
  }

  return { ...s, records, invocations, linkCalls, sendMessage, a2a };
}

describe('action tools through the run orchestrator', () => {
  it('runs the action’s graph as the user and returns its output, recorded as a personal agent run', async () => {
    const { connect, token, records, invocations, calls } = await rig();
    const userToken = await token();
    const client = await connect(userToken);
    const result = await client.callTool({ name: 'action_summarize_overdue', arguments: {} });
    await client.close();
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(OUTPUT);
    expect(JSON.parse(textOf(result))).toEqual(OUTPUT);

    expect(invocations.map((i) => i.node)).toEqual(['collect', 'summarize', 'prioritize', 'review']);
    expect(invocations[0]).toMatchObject({ app: 'ticket-board', graph: 'overdue-summary', input: {}, userToken });
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0]).toMatchObject({ app: 'ticket-board', action: 'summarize_overdue', status: 'ok', userId: 'u_1', caller: { kind: 'agent', id: CLIENT_ID } });
    expect(records[0]!.nodes.map((n) => n.node)).toEqual(['collect', 'summarize', 'prioritize', 'review']);
    expect(calls).toMatchObject([{ tool: 'action_summarize_overdue', ok: true }]);
  });

  it('answers a failed run as a tool error with the node’s message', async () => {
    const { connect, token, calls } = await rig({
      nodes: {
        prioritize: () => {
          throw new Error('LLM gateway not configured: LLM_GATEWAY_URL is not set');
        },
      },
    });
    const client = await connect(await token());
    const result = await client.callTool({ name: 'action_summarize_overdue', arguments: {} });
    await client.close();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('The "summarize_overdue" action failed: LLM gateway not configured: LLM_GATEWAY_URL is not set');
    expect(calls).toMatchObject([{ ok: false }]);
  });

  it('stops waiting after the bound and says the run goes on', async () => {
    const hold = gate();
    const { connect, token, records } = await rig({ waitMs: 20, nodes: { collect: async () => (await hold.wait(), {}) } });
    const client = await connect(await token());
    const result = await client.callTool({ name: 'action_summarize_overdue', arguments: {} });
    await client.close();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^The "summarize_overdue" action is still running after 0 seconds \(run [0-9a-f-]{36}\)\./);
    hold.open();
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0]!.status).toBe('ok');
  });

  it('passes on the runner’s cap on concurrent runs per user', async () => {
    const hold = gate();
    const { connect, token } = await rig({ nodes: { collect: async () => (await hold.wait(), {}) } });
    const client = await connect(await token());
    const call = () => client.callTool({ name: 'action_summarize_overdue', arguments: {} });
    const running = [call(), call()];
    // Both runs must hold their slot before the third call arrives.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const third = await call();
    expect(third.isError).toBe(true);
    expect(textOf(third)).toContain('Too many agent runs at once: you already have 2 agent runs in progress');
    hold.open();
    for (const result of await Promise.all(running)) expect(result.structuredContent).toEqual(OUTPUT);
    await client.close();
  });
});

describe('A2A SendMessage', () => {
  it('runs the default action for a member’s own agent and answers with a direct agent message', async () => {
    const { a2a, sendMessage, records, linkCalls } = await rig();
    const { status, body } = await a2a(sendMessage(undefined, { contextId: 'ctx-1' }));
    expect(status).toBe(200);
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      id: 7,
      result: {
        message: {
          role: 'ROLE_AGENT',
          contextId: 'ctx-1',
          parts: [{ data: OUTPUT, mediaType: 'application/json' }],
          metadata: { action: 'summarize_overdue', runId: expect.stringMatching(/^[0-9a-f-]{36}$/) },
        },
      },
    });
    expect(body.result.message.messageId).toBeTruthy();
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0]).toMatchObject({ action: 'summarize_overdue', caller: { kind: 'agent', id: CLIENT_ID }, userId: 'u_1' });
    expect(linkCalls).toEqual([]);
  });

  it('lets a connected app call as the user, and counts the call on the grant', async () => {
    const { a2a, sendMessage, records, linkCalls, invocations, token } = await rig();
    const bearer = await token({ aud: audienceForApp('ticket-board'), azp: undefined, sub: 'u_junho' });
    const { status, body } = await a2a(sendMessage([{ data: { action: 'summarize_overdue', input: {} } }]), { from: 'team-wiki', bearer });
    expect(status).toBe(200);
    expect(body.result.message.parts[0].data).toEqual(OUTPUT);
    expect(invocations[0]).toMatchObject({ userToken: bearer });
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0]).toMatchObject({ action: 'summarize_overdue', userId: 'u_junho', caller: { kind: 'app', id: 'team-wiki' } });
    expect(linkCalls).toEqual(['team-wiki>ticket-board:A2A']);
  });

  it('refuses an app that is not connected, and anything that is not another app’s runtime', async () => {
    const { a2a, sendMessage, records, invocations } = await rig();
    const refused = await a2a(sendMessage(), { from: 'docs' });
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: { code: 'denied', message: 'docs is not connected to ticket-board over A2A. The owner of ticket-board allows the link on the App Graph.' } });

    expect((await a2a(sendMessage(), { from: 'ticket-board' })).body).toMatchObject({ error: { code: 'forbidden_caller' } });
    expect((await a2a(sendMessage(), { caller: await signCallerToken({ kind: 'service', svc: 'data-api' }, CALLER_SECRET) })).status).toBe(403);
    expect((await a2a(sendMessage(), { caller: 'not-a-token' })).status).toBe(403);
    expect(invocations).toEqual([]);
    expect(records).toEqual([]);
  });

  it('challenges a call without a valid user token, like the MCP endpoint', async () => {
    const { a2a, sendMessage, token } = await rig();
    const anonymous = await a2a(sendMessage(), { bearer: null });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${METADATA_URL}"`);
    // A screen token names no client, so on its own it is not an agent's credential.
    expect((await a2a(sendMessage(), { bearer: await token({ aud: audienceForApp('ticket-board'), azp: undefined }) })).status).toBe(401);
    expect((await a2a(sendMessage(), { from: 'team-wiki', bearer: await token({ app: 'team-wiki', aud: audienceForApp('team-wiki') }) })).status).toBe(401);
    expect((await a2a(sendMessage(), { from: 'team-wiki', bearer: await token({ aud: `${BASE}/orum/wiki/mcp` }) })).status).toBe(401);
  });

  it('fails closed when the grant cannot be checked', async () => {
    const { a2a, sendMessage, errors } = await rig({
      links: {
        connected: async () => {
          throw new Error('control API answered HTTP 503 to a grant check');
        },
        recordCall: () => {},
      },
    });
    const res = await a2a(sendMessage(), { from: 'team-wiki' });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: { code: 'internal' } });
    expect(errors.map((e) => e.message)).toEqual(['control API answered HTTP 503 to a grant check']);
  });

  it('picks the action from a data part or the skill id, and validates its input', async () => {
    const { a2a, sendMessage } = await rig();
    expect((await a2a(sendMessage([{ text: 'hi' }], { metadata: { skillId: 'action_summarize_overdue' } }))).body.result.message.metadata.action).toBe('summarize_overdue');
    expect((await a2a(sendMessage([{ data: { action: 'archive_everything' } }]))).body.error).toMatchObject({ code: -32602, message: 'This app has no action "archive_everything".' });
    const invalid = await a2a(sendMessage([{ data: { action: 'summarize_overdue', input: { since: 'yesterday' } } }]));
    expect(invalid.body.error.code).toBe(-32602);
    expect(invalid.body.error.message).toContain('Invalid input for summarize_overdue');
    // A data part without `action` is the input of the default action.
    expect((await a2a(sendMessage([{ data: { since: 'yesterday' } }]))).body.error.code).toBe(-32602);
  });

  it('answers protocol errors as JSON-RPC errors', async () => {
    const { a2a, sendMessage, invocations } = await rig();
    expect((await a2a('{not json')).body).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } });
    expect((await a2a({ id: 1, method: 'SendMessage' })).body.error.code).toBe(-32600);
    expect((await a2a({ jsonrpc: '2.0', id: 2, method: 'DoSomething', params: {} })).body).toMatchObject({ id: 2, error: { code: -32601 } });
    for (const method of ['GetTask', 'CancelTask', 'SendStreamingMessage', 'tasks/get']) {
      expect((await a2a({ jsonrpc: '2.0', id: 3, method, params: {} })).body.error.code, method).toBe(-32004);
    }
    expect((await a2a({ jsonrpc: '2.0', id: 4, method: 'SendMessage', params: {} })).body.error.code).toBe(-32602);
    expect((await a2a(sendMessage(undefined, { role: 'ROLE_AGENT' }))).body.error.code).toBe(-32602);
    expect((await a2a(sendMessage(), { version: '2.0' })).body.error).toMatchObject({ code: -32009, message: 'A2A version 2.0 is not supported. Supported: 1.0, 0.3.' });
    expect(invocations).toEqual([]);
  });

  it('still answers 0.3 clients that call message/send, in the 0.3 shape', async () => {
    const { a2a } = await rig();
    const legacy = {
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'message/send',
      params: { message: { kind: 'message', messageId: 'm-1', role: 'user', parts: [{ kind: 'text', text: 'Summarize my overdue tickets' }] } },
    };
    const { body } = await a2a(legacy, { version: null });
    expect(body).toMatchObject({ id: 'req-1', result: { kind: 'message', role: 'agent', parts: [{ kind: 'data', data: OUTPUT }], metadata: { action: 'summarize_overdue' } } });
  });

  it('reports a failed run, and a gateway without a runner, as an internal error with a reason', async () => {
    const failing = await rig({
      nodes: {
        review: () => {
          throw new Error('no summary to review');
        },
      },
    });
    expect((await failing.a2a(failing.sendMessage())).body.error).toEqual({
      code: -32603,
      message: 'The "summarize_overdue" action failed: no summary to review',
      data: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'FAILED', domain: 'kelay.app' }],
    });

    const bare = await rig({ runner: false });
    expect((await bare.a2a(bare.sendMessage())).body.error).toMatchObject({ code: -32603, message: 'The "summarize_overdue" action isn\'t available yet.', data: [{ reason: 'UNAVAILABLE' }] });
  });

  it('shares the per-user rate limit with the MCP endpoint', async () => {
    const s = await setup({ ratePerMin: 1 });
    const bearer = await s.token();
    const post = () =>
      s.gateway.request(A2A_PATH, { method: 'POST', headers: { 'content-type': 'application/json', 'a2a-version': '1.0', authorization: `Bearer ${bearer}` }, body: '{}' });
    expect((await post()).status).toBe(200);
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect((await s.rpc(bearer, 'tools/list')).status).toBe(429);
  });
});
