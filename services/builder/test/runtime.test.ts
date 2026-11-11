import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScriptedAgent } from '../src/agents/scripted.ts';
import type { AgentEvent } from '../src/agents/types.ts';
import { BuildError } from '../src/artifacts/build.ts';
import { checkManifest } from '../src/check.ts';
import { LocalWorkspaceDriver } from '../src/drivers/local.ts';
import { RemoteWorkspace, createRuntimeApp } from '../src/drivers/runtime.ts';
import { ManifestError } from '../src/drivers/types.ts';
import { TEMPLATE_DIR } from './harness.ts';

// What a Fargate task runs, reached the way the Builder service reaches it, without the network.
describe('a workspace behind the runtime protocol', () => {
  const root = mkdtempSync(join(tmpdir(), 'kelay-runtime-'));
  let remote: RemoteWorkspace;
  let stopped = false;
  const builds: string[] = [];
  let failBuild: string | null = null;

  beforeAll(async () => {
    const driver = new LocalWorkspaceDriver({ root, templateDir: TEMPLATE_DIR, agent: new ScriptedAgent(), preview: async () => ({ url: 'http://localhost:3000', stop: async () => {} }) });
    const local = await driver.open('team-board');
    // The real build is covered in artifacts.test.ts; here it only has to cross the protocol.
    local.build = async ({ outDir, basePath }) => {
      builds.push(basePath);
      if (failBuild) throw new BuildError(failBuild);
      writeFileSync(join(outDir, 'web.zip'), 'web bytes');
      writeFileSync(join(outDir, 'nodes.zip'), 'nodes bytes');
      return { web: { file: join(outDir, 'web.zip'), bytes: 9, handler: 'index.handler' }, nodes: { file: join(outDir, 'nodes.zip'), bytes: 11, handler: 'nodes.handler' } };
    };
    const runtime = createRuntimeApp(local, 'runtime-token');
    const fetchRuntime = ((input: string | URL | Request, init?: RequestInit) => runtime.request(String(input).replace('http://task', ''), init)) as typeof fetch;
    remote = new RemoteWorkspace({ app: 'team-board', ref: 'arn:task', endpoint: 'http://task', token: 'runtime-token', previewTarget: 'http://10.0.3.17:3000', stop: async () => void (stopped = true), fetch: fetchRuntime });

    const wrong = new RemoteWorkspace({ app: 'team-board', ref: 'arn:task', endpoint: 'http://task', token: 'guess', previewTarget: '', stop: async () => {}, fetch: fetchRuntime });
    await expect(wrong.connect()).rejects.toThrow('wrong runtime token');
    await remote.connect();
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reports what the task holds', () => {
    expect(remote).toMatchObject({ created: true, agent: { kind: 'scripted', model: null } });
    expect(remote.previewTarget()).toBeNull();
  });

  it('runs an agent turn, streaming its events, then commits and reads the manifest', async () => {
    const events: AgentEvent[] = [];
    const result = await remote.runAgent({ app: 'team-board', kind: 'build', prompt: 'A board' }, (e) => events.push(e));
    expect(events.filter((e) => e.type === 'step').map((e) => e.text)).toEqual(['Understood the request', 'Created data: projects, tickets, comments', 'Generated the board screen']);
    expect(events.filter((e) => e.type === 'file')).toHaveLength(7);
    expect(result.text).toContain('Ticket Board');

    const commit = await remote.commit('Build the first version');
    expect(commit).toMatchObject({ message: 'Build the first version', branch: 'main' });
    expect(commit!.files).toEqual(expect.arrayContaining(['kelay/schema.ts', 'kelay/nodes.ts', 'app/page.tsx']));
    expect(await remote.commit('nothing')).toBeNull();
    expect(await remote.head()).toEqual({ commit: commit!.commit, message: 'Build the first version', branch: 'main' });

    const check = checkManifest('team-board', await remote.manifest());
    expect(check.ok && check.app.graphs.map((g) => g.name)).toEqual(['overdue-summary']);
  });

  it('branches, merges, starts the preview at the task’s address and stops', async () => {
    await remote.checkout('improve/abc');
    expect((await remote.head()).branch).toBe('improve/abc');
    await remote.merge('improve/abc', 'main');
    expect((await remote.head()).branch).toBe('main');

    expect(await remote.startPreview({ KELAY_CALLER_TOKEN: 't' })).toBe('http://10.0.3.17:3000');
    expect(remote.previewTarget()).toBe('http://10.0.3.17:3000');
    await remote.stop();
    expect(stopped).toBe(true);
    expect(remote.previewTarget()).toBeNull();
  });

  it('builds in the task and brings the bundles over, since the task may not write to the artifact store', async () => {
    const out = join(root, 'fetched');
    const built = await remote.build({ outDir: out, basePath: '/orum/team-board' });
    expect(builds).toEqual(['/orum/team-board']);
    expect(built).toEqual({ web: { file: join(out, 'web.zip'), bytes: 9, handler: 'index.handler' }, nodes: { file: join(out, 'nodes.zip'), bytes: 11, handler: 'nodes.handler' } });
    expect(readFileSync(built.web.file, 'utf8')).toBe('web bytes');
    expect(readFileSync(built.nodes!.file, 'utf8')).toBe('nodes bytes');

    failBuild = "Type 'string' is not assignable to type 'number'";
    const failure = await remote.build({ outDir: out, basePath: '/orum/team-board' }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(BuildError);
    expect((failure as Error).message).toContain('not assignable');
  });

  it('carries a manifest that does not load as a ManifestError', async () => {
    const file = join(root, 'team-board/kelay/policy.ts');
    const good = readFileSync(file, 'utf8');
    writeFileSync(file, `${good}\nthrow new Error('boom in policy');\n`);
    await expect(remote.manifest()).rejects.toThrow(ManifestError);
    await expect(remote.manifest()).rejects.toThrow('boom in policy');
    writeFileSync(file, good);
  });
});

describe('checkManifest', () => {
  const schema = { app: 'notes-app', roles: ['admin', 'member'], collections: [{ name: 'notes', fields: { title: { type: 'text', required: true } } }] };
  const policy = { member: { notes: { read: 'all', create: 'all', update: 'mine', delete: 'none' } } };
  const graph = { name: 'digest', start: 'collect', nodes: { collect: { next: 'write' }, write: {} } };

  it('passes an app and compiles its graphs for the deploy route', () => {
    const check = checkManifest('notes-app', { schema: { ...schema, actions: [{ name: 'send_digest', description: 'Send the digest', input: {}, graph: 'digest' }] }, policy, graphs: [graph] });
    expect(check).toMatchObject({ ok: true, problems: [], app: { schema: { app: 'notes-app' }, policy } });
    const definition = check.ok ? JSON.parse(check.app.graphs[0]!.definition) : null;
    expect(JSON.stringify(definition)).toContain('${NodeFunctionArn}');
    expect(checkManifest('notes-app', { schema, policy })).toMatchObject({ ok: true, app: { graphs: [] } });
  });

  it('lists every problem with where it is', () => {
    const paths = (manifest: unknown) => {
      const check = checkManifest('notes-app', manifest);
      return check.ok ? [] : check.problems.map((p) => `${p.path}: ${p.message}`);
    };
    expect(paths(null)).toEqual(['kelay: the app did not report a schema and a policy']);
    expect(paths({ schema: { ...schema, app: 'other-app' }, policy })).toEqual(['schema.app: must stay "notes-app", got "other-app"']);
    expect(paths({ schema, policy: { guest: policy.member, member: { tasks: policy.member.notes } } })).toEqual([
      'policy.guest: role "guest" is not declared in schema.roles',
      'policy.member.tasks: collection "tasks" is not declared in the schema',
    ]);
    expect(paths({ schema: { ...schema, actions: [{ name: 'send_digest', description: 'Send the digest', input: {}, graph: 'digest' }] }, policy, graphs: [] })).toEqual([
      'schema.actions.send_digest.graph: graph "digest" is not declared in kelay/graphs.ts',
    ]);
    expect(paths({ schema, policy, graphs: [{ ...graph, start: 'nowhere' }, graph, graph] })).toEqual([
      'graphs.digest.start: unknown node "nowhere"',
      'graphs.digest: two graphs have this name',
    ]);
    expect(paths({ schema, policy, graphs: 'none' })).toEqual(['graphs: must be a list of graphs']);
  });
});
