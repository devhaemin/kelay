import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentTurn, CodingAgent } from '../src/agents/types.ts';
import type { WorkspaceEvent } from '../src/events.ts';
import { ImprovementWorker } from '../src/improvements.ts';
import { createLogger } from '../src/log.ts';
import { WorkspaceManager } from '../src/workspaces.ts';
import { createHarness, type Harness } from './harness.ts';

const APP = 'team-board';
const types = (events: WorkspaceEvent[]) => events.map((e) => (e.type === 'step' ? `step:${e.key}:${e.status}` : e.type));

describe('a workspace built by the scripted agent on the local driver', () => {
  let h: Harness;
  let token: string;
  let first: WorkspaceEvent[];

  beforeAll(async () => {
    h = await createHarness();
    h.control.addApp(APP, 'jeongyun');
    token = await h.token('jeongyun');
  });
  afterAll(() => h.close());

  it('creates the workspace from the starter template and builds from the prompt', async () => {
    expect((await h.req('GET', `/v1/workspaces/${APP}`, { token })).status).toBe(404);

    const res = await h.req('POST', '/v1/workspaces', { token, body: { app: APP, prompt: 'A Jira-style ticket board for my team' } });
    expect(res.status).toBe(202);
    expect(res.body.workspace).toMatchObject({ app: APP, state: 'working', driver: 'local', agent: { kind: 'scripted', model: null } });
    expect(res.body.turn).toEqual(expect.any(String));

    first = await h.settled(APP);

    // Files: the fixture's data under this app's slug, and the board screen.
    const schema = readFileSync(join(h.dir(APP), 'kelay/schema.ts'), 'utf8');
    expect(schema).toContain(`"app": "${APP}"`);
    expect(schema).toContain('"tickets"');
    expect(readFileSync(join(h.dir(APP), 'app/page.tsx'), 'utf8')).toContain("useCollection('tickets'");
    expect(existsSync(join(h.dir(APP), 'CLAUDE.md'))).toBe(true);

    // Git: the template commit, then the turn's commit.
    const log = await simpleGit(h.dir(APP)).log();
    expect(log.all.map((c) => c.message)).toEqual(['Build the first version: A Jira-style ticket board for my team', 'Start from the Kelay starter template']);
    expect((await simpleGit(h.dir(APP)).status()).isClean()).toBe(true);
  });

  it('reports the turn as ordered events', () => {
    expect(first.map((e) => e.id)).toEqual(first.map((_, i) => i + 1));
    expect(new Set(first.map((e) => e.turn)).size).toBe(1);
    expect(types(first)).toEqual([
      'turn.started',
      'step:workspace:running',
      'step:workspace:done',
      'step:agent-1:running',
      'step:agent-1:done',
      'step:agent-2:running',
      'file',
      'file',
      'file',
      'step:agent-2:done',
      'step:agent-3:running',
      'file',
      'file',
      'file',
      'assistant.text',
      'commit',
      'step:agent-3:done',
      'step:check:running',
      'validation',
      'step:check:done',
      'step:deploy:running',
      'deploy',
      'step:deploy:done',
      'step:preview:running',
      'preview',
      'step:preview:done',
      'turn.finished',
    ]);
    expect(first[0]).toMatchObject({ type: 'turn.started', kind: 'build', agent: { kind: 'scripted' }, prompt: 'A Jira-style ticket board for my team' });
    expect(first.find((e) => e.type === 'assistant.text')).toMatchObject({ text: expect.stringContaining('scripted demo agent') });
    expect(first.find((e) => e.type === 'validation')).toMatchObject({ ok: true, attempt: 1, problems: [] });
    expect(first.at(-1)).toMatchObject({ type: 'turn.finished', status: 'succeeded', error: null });
  });

  it('deploys the checked schema, policy and graphs to dev through the Control API', async () => {
    expect(h.control.deploys).toHaveLength(1);
    const { app, env, request } = h.control.deploys[0]!;
    const head = await simpleGit(h.dir(APP)).revparse(['HEAD']);
    expect({ app, env }).toEqual({ app: APP, env: 'dev' });
    expect(request).toMatchObject({ commit: head, artifactUrl: `workspace://${APP}/${head}`, schema: { app: APP, roles: ['admin', 'member', 'guest'] } });
    expect(request.schema.collections.map((c) => c.name)).toEqual(['projects', 'tickets', 'comments']);
    expect(request.policy.member?.tickets).toEqual({ read: 'mine_shared', create: 'all', update: 'mine', delete: 'none' });
    expect(request.graphs.map((g) => g.name)).toEqual(['overdue-summary']);
    expect(JSON.parse(request.graphs[0]!.definition)).toMatchObject({ QueryLanguage: 'JSONata' });
    // The env's database is provisioned before the deploy migrates it.
    expect(h.control.databases).toEqual([{ app: APP, env: 'dev', url: 'postgres://test/app_team_board_dev' }]);
    expect(h.control.sandboxes[0]).toMatchObject({ app: APP, owner: 'jeongyun', kind: 'workspace', status: 'running', taskArn: `local:${h.dir(APP)}` });
  });

  it('starts the preview with the runtime environment and reports the workspace', async () => {
    expect(h.previews).toHaveLength(1);
    expect(h.previews[0]).toMatchObject({ dir: h.dir(APP), env: { DATA_API_URL: 'http://localhost:4002', CONTROL_API_URL: 'http://localhost:4003', KELAY_CALLER_TOKEN: 'caller-token-1' } });
    const res = await h.req('GET', `/v1/workspaces/${APP}`, { token });
    expect(res.body.workspace).toMatchObject({ state: 'idle', previewUrl: 'http://localhost:39001', version: 'v1', turn: null, lastEventId: first.length });
    expect(res.body.workspace.lastCommit).toMatchObject({ branch: 'main', message: expect.stringContaining('Build the first version') });
  });

  it('streams the transcript over SSE and resumes after Last-Event-ID', async () => {
    const read = async (headers: Record<string, string>, expected: number) => {
      const res = await h.api.request(`/v1/workspaces/${APP}/events`, { headers: { authorization: `Bearer ${token}`, ...headers } });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      let text = '';
      while ((text.match(/\n\n/g) ?? []).length < expected) text += new TextDecoder().decode((await reader.read()).value);
      await reader.cancel();
      return text.trim().split('\n\n').map((block) => Object.fromEntries(block.split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)])));
    };
    const all = await read({}, first.length);
    expect(all.map((e) => e.event)).toEqual(first.map((e) => e.type));
    expect(all.map((e) => Number(e.id))).toEqual(first.map((e) => e.id));
    expect(JSON.parse(all[0]!.data!)).toEqual(first[0]);

    const tail = await read({ 'last-event-id': String(first.length - 2) }, 2);
    expect(tail.map((e) => e.event)).toEqual(['step', 'turn.finished']);

    const json = await h.req('GET', `/v1/workspaces/${APP}/events?format=json&after=${first.length - 1}`, { token });
    expect(json.body.events).toEqual([first.at(-1)]);
  });

  it('runs a chat message as a turn that commits and deploys', async () => {
    const res = await h.req('POST', `/v1/workspaces/${APP}/messages`, { token, body: { text: 'Add a priority to tickets', context: 'Screen · Board' } });
    expect(res.status).toBe(202);
    // One turn at a time.
    expect((await h.req('POST', `/v1/workspaces/${APP}/messages`, { token, body: { text: 'and labels' } })).status).toBe(409);

    const turn = (await h.settled(APP)).filter((e) => e.turn === res.body.turn);
    expect(turn[0]).toMatchObject({ type: 'turn.started', kind: 'message', context: 'Screen · Board' });
    expect(turn.filter((e) => e.type === 'commit')).toMatchObject([{ message: 'Add a priority to tickets', files: ['kelay/schema.ts'], branch: 'main' }]);
    expect(turn.find((e) => e.type === 'deploy')).toMatchObject({ ok: true, version: 'v2' });
    expect(h.control.deploys).toHaveLength(2);
    expect(h.control.deploys[1]!.request.schema.collections.find((c) => c.name === 'tickets')!.fields.priority).toEqual({ type: 'text', description: 'low | medium | high' });
    // The preview keeps running; it is not started twice.
    expect(h.previews).toHaveLength(1);
  });

  it('says so and deploys nothing when the scripted agent cannot do what was asked', async () => {
    const res = await h.req('POST', `/v1/workspaces/${APP}/messages`, { token, body: { text: 'Make the board purple' } });
    const turn = (await h.settled(APP)).filter((e) => e.turn === res.body.turn);
    expect(types(turn)).toEqual(['turn.started', 'assistant.text', 'preview', 'turn.finished']);
    expect(turn[1]).toMatchObject({ text: expect.stringContaining('can’t make free-form changes') });
    expect(h.control.deploys).toHaveLength(2);
  });

  it('runs an approved improvement on a branch and completes the run', async () => {
    const worker = new ImprovementWorker({ control: h.control, workspaces: h.workspaces, logger: createLogger('silent'), worker: 'test' });
    expect(await worker.runOnce()).toBe(false);

    // The scripted agent has one more change in it only once, so start from a workspace without priority.
    h.control.addApp('sprint-board', 'jeongyun');
    await h.req('POST', '/v1/workspaces', { token, body: { app: 'sprint-board', prompt: 'A ticket board' } });
    await h.settled('sprint-board');

    h.control.queue.push({
      run: { id: '7d1f0c2a-0000-4000-8000-000000000001', app: 'sprint-board', proposalId: 'p1' },
      proposal: { id: 'p1', title: 'Let people set a priority on tickets', body: 'Three people asked for it.', refs: ['FB-12'], affects: 'tickets' },
    });
    h.control.queue.push({
      run: { id: '7d1f0c2a-0000-4000-8000-000000000002', app: 'never-built', proposalId: 'p2' },
      proposal: { id: 'p2', title: 'Anything', body: '', refs: [], affects: '' },
    });
    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(true);

    expect(h.control.completed[0]).toEqual({ runId: '7d1f0c2a-0000-4000-8000-000000000001', outcome: { status: 'succeeded', branch: 'improve/7d1f0c2a', versionId: expect.any(String) } });
    expect(h.control.completed[1]).toMatchObject({ runId: '7d1f0c2a-0000-4000-8000-000000000002', outcome: { status: 'failed', error: expect.stringContaining('no Builder workspace') } });

    const git = simpleGit(h.dir('sprint-board'));
    const events = h.workspaces.events('sprint-board').since(0);
    expect(events.find((e) => e.type === 'turn.started' && e.kind === 'improvement')).toMatchObject({ prompt: expect.stringContaining('Feedback tickets: FB-12') });
    expect(events.filter((e) => e.type === 'commit').at(-1)).toMatchObject({ branch: 'improve/7d1f0c2a', message: 'Improvement: Let people set a priority on tickets' });
    // Deployed from the branch, then merged: main is where the workspace continues.
    expect((await git.branchLocal()).all).toEqual(['improve/7d1f0c2a', 'main']);
    expect((await git.status()).current).toBe('main');
    expect(await git.revparse(['main'])).toBe(await git.revparse(['improve/7d1f0c2a']));
    expect(h.control.deploys.at(-1)).toMatchObject({ app: 'sprint-board', request: { commit: await git.revparse(['main']) } });
    expect(h.control.sandboxes.at(-1)).toMatchObject({ app: 'sprint-board', kind: 'improvement' });
  });

  it('keeps the transcript and the deployed state across a restart', async () => {
    // A second manager over the same state and workspace folders stands in for the restarted process.
    const manager = new WorkspaceManager({ driver: h.driver, control: h.control, agent: { kind: 'scripted', model: null }, stateDir: join(h.root, 'state'), logger: createLogger('silent'), idleMs: 0 });
    expect(await manager.status(APP)).toMatchObject({ version: 'v2', lastEventId: h.workspaces.events(APP).last!.id });
    expect(manager.events(APP).since(0)).toEqual(h.workspaces.events(APP).since(0));
  });
});

describe('who may use a workspace', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
    h.control.addApp('mine', 'jeongyun');
    h.control.addApp('seeded', 'jeongyun', { deployedToDev: true, name: 'Seeded' });
  });
  afterAll(() => h.close());

  it('needs a builder token for the console', async () => {
    expect((await h.req('GET', '/v1/workspaces/mine')).status).toBe(401);
    expect((await h.req('GET', '/v1/workspaces/mine', { token: 'not-a-token' })).status).toBe(401);
    expect((await h.req('GET', '/v1/workspaces/mine', { token: await h.token('jeongyun', 'member') })).body.error.code).toBe('denied');
    const health = await h.req('GET', '/healthz');
    expect(health.body).toEqual({ ok: true, service: 'builder', driver: 'local', agent: { kind: 'scripted', model: null } });
  });

  it('lets only the owner in, as the Control API decides', async () => {
    const other = await h.token('someone-else');
    for (const [method, path, body] of [
      ['POST', '/v1/workspaces', { app: 'mine', prompt: 'x' }],
      ['GET', '/v1/workspaces/mine', undefined],
      ['GET', '/v1/workspaces/mine/events', undefined],
      ['POST', '/v1/workspaces/mine/messages', { text: 'x' }],
    ] as const) {
      const res = await h.req(method, path, { token: other, ...(body ? { body } : {}) });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.error.code).toBe('denied');
    }
    expect((await h.req('GET', '/v1/workspaces/nope', { token: other })).body.error.code).toBe('unknown_app');
    expect(existsSync(h.dir('mine'))).toBe(false);
  });

  it('validates input and refuses to start over an app it did not build', async () => {
    const token = await h.token('jeongyun');
    expect((await h.req('POST', '/v1/workspaces', { token, body: { app: 'mine', prompt: '  ' } })).status).toBe(400);
    expect((await h.req('POST', '/v1/workspaces/mine/messages', { token, body: { text: 'hello' } })).body.error.code).toBe('not_found');
    const seeded = await h.req('POST', '/v1/workspaces', { token, body: { app: 'seeded', prompt: 'A board' } });
    expect(seeded.status).toBe(409);
    expect(seeded.body.error.message).toContain('was not built in this Builder');
    expect(h.control.deploys).toHaveLength(0);
  });
});

/** Writes a policy for a role the schema does not have, and repairs it when told what the check found. */
class ClumsyAgent implements CodingAgent {
  readonly info = { kind: 'claude' as const, model: 'test-model' };
  prompts: string[] = [];
  constructor(private readonly repairs: boolean) {}

  async run(turn: AgentTurn, emit: (event: AgentEvent) => void) {
    this.prompts.push(turn.prompt);
    const fixing = this.prompts.length > 1;
    const role = fixing && this.repairs ? 'member' : 'visitor';
    await writeFile(
      join(turn.dir, 'kelay/policy.ts'),
      `import { definePolicy } from '@kelay/sdk';\n\nexport const policy = definePolicy({ ${role}: { notes: { read: 'all', create: 'none', update: 'none', delete: 'none' } } });\n// attempt ${this.prompts.length}\n`,
    );
    emit({ type: 'file', path: 'kelay/policy.ts', change: 'modified' });
    return { text: fixing ? 'Fixed the role.' : 'Members can read notes.', sessionId: 'session-1' };
  }
}

describe('the check after a turn', () => {
  it('feeds a failure back to the agent once, then deploys the repaired app', async () => {
    const agent = new ClumsyAgent(true);
    const h = await createHarness({ agent });
    try {
      h.control.addApp('notes-app', 'jeongyun');
      await h.req('POST', '/v1/workspaces', { token: await h.token('jeongyun'), body: { app: 'notes-app', prompt: 'Notes for my team' } });
      const events = await h.settled('notes-app');

      expect(events.filter((e) => e.type === 'validation')).toMatchObject([
        { ok: false, attempt: 1, problems: [{ path: 'policy.visitor', message: 'role "visitor" is not declared in schema.roles' }] },
        { ok: true, attempt: 2, problems: [] },
      ]);
      expect(agent.prompts).toHaveLength(2);
      expect(agent.prompts[1]).toContain('- policy.visitor: role "visitor" is not declared in schema.roles');
      expect(events.filter((e) => e.type === 'commit').map((e) => e.type === 'commit' && e.message)).toEqual(['Build the first version: Notes for my team', 'Fix what the check of kelay/ found']);
      expect(events[0]).toMatchObject({ agent: { kind: 'claude', model: 'test-model' } });
      expect(events.at(-1)).toMatchObject({ status: 'succeeded' });
      expect(h.control.deploys).toHaveLength(1);
      expect(Object.keys(h.control.deploys[0]!.request.policy)).toEqual(['member']);
    } finally {
      await h.close();
    }
  });

  it('fails the turn and deploys nothing when the repair does not pass either', async () => {
    const agent = new ClumsyAgent(false);
    const h = await createHarness({ agent });
    try {
      h.control.addApp('notes-app', 'jeongyun');
      await h.req('POST', '/v1/workspaces', { token: await h.token('jeongyun'), body: { app: 'notes-app', prompt: 'Notes for my team' } });
      const events = await h.settled('notes-app');
      expect(agent.prompts).toHaveLength(2);
      expect(events.filter((e) => e.type === 'validation').map((e) => e.type === 'validation' && e.ok)).toEqual([false, false]);
      expect(events.at(-1)).toMatchObject({ type: 'turn.finished', status: 'failed', error: expect.stringContaining('nothing was deployed') });
      expect(events.at(-2)).toMatchObject({ type: 'step', key: 'check-2', status: 'failed' });
      expect(h.control.deploys).toHaveLength(0);
      expect(h.previews).toHaveLength(0);
      expect((await h.workspaces.status('notes-app'))?.version).toBeNull();
    } finally {
      await h.close();
    }
  });

  it('reports a failed deploy on the turn', async () => {
    const h = await createHarness();
    try {
      h.control.addApp('board', 'jeongyun');
      h.control.failDeploy = 'could not apply the schema and access rules to the dev database';
      await h.req('POST', '/v1/workspaces', { token: await h.token('jeongyun'), body: { app: 'board', prompt: 'A board' } });
      const events = await h.settled('board');
      expect(events.find((e) => e.type === 'deploy')).toMatchObject({ ok: false, error: expect.stringContaining('could not apply') });
      expect(events.at(-1)).toMatchObject({ status: 'failed', error: expect.stringContaining('The deploy to Development failed') });

      // Nothing changed in the files, but the commit is still undeployed: the next message deploys it.
      h.control.failDeploy = null;
      const retry = await h.req('POST', '/v1/workspaces/board/messages', { token: await h.token('jeongyun'), body: { text: 'try again' } });
      const turn = (await h.settled('board')).filter((e) => e.turn === retry.body.turn);
      expect(turn.find((e) => e.type === 'deploy')).toMatchObject({ ok: true, version: 'v1' });
    } finally {
      await h.close();
    }
  });
});
