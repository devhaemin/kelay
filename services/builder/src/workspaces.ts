// One Builder workspace per app, and the turn every request goes through: the coding agent changes
// files, the workspace commits, kelay/ is checked and the app's bundles are built (a failure of either
// goes back to the agent once), the result is deployed to Development through the Control API, and
// the dev preview is started.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { AgentEvent } from './agents/types.ts';
import { BuildError, NODES_ENTRY } from './artifacts/build.ts';
import { artifactKey, type ArtifactStore } from './artifacts/store.ts';
import { checkManifest, describeProblems, type CheckResult } from './check.ts';
import type { AppInfo, ControlApi, ImprovementJob, RunOutcome } from './control.ts';
import { ManifestError, type Workspace, type WorkspaceDriver } from './drivers/types.ts';
import { ApiError } from './errors.ts';
import { EventLog, type AgentInfo, type TurnKind, type WorkspaceEventBody } from './events.ts';
import type { DatabaseProvisioner } from './provision.ts';

const MAIN = 'main';

export interface WorkspaceStatus {
  app: string;
  /** `stopped`: the workspace exists, but its sandbox and preview are not running; the next message starts them. */
  state: 'working' | 'idle' | 'stopped';
  driver: WorkspaceDriver['name'];
  /** Which coding agent answers here, so the UI can say when it is the scripted demo. */
  agent: AgentInfo;
  previewUrl: string | null;
  lastCommit: { commit: string; message: string; branch: string } | null;
  /** The version deployed to Development from this workspace, e.g. "v3". */
  version: string | null;
  turn: { id: string; kind: TurnKind } | null;
  lastEventId: number;
}

export interface TurnResult {
  status: 'succeeded' | 'failed';
  error: string | null;
  branch: string;
  versionId: string | null;
  changed: boolean;
}

interface SavedState {
  owner: string | null;
  /** The builder's handle: a deployed app is served, and therefore built, under /<handle>/<app>. */
  handle: string | null;
  sessionId: string | null;
  deployedCommit: string | null;
  version: string | null;
  versionId: string | null;
  /** The app-runtime caller token of the dev deploy, for the preview. It lives outside the workspace folder, where the agent cannot read it. */
  callerToken: string | null;
  lastCommit: WorkspaceStatus['lastCommit'];
}

interface Entry {
  app: string;
  log: EventLog;
  state: SavedState;
  stateFile: string;
  workspace: Workspace | null;
  running: { id: string; kind: TurnKind } | null;
  /** Turns of one workspace never overlap: each waits for the one before it. */
  queue: Promise<unknown>;
  lastActive: number;
}

interface TurnSpec {
  id: string;
  kind: TurnKind;
  prompt: string;
  context: string | null;
  owner: string;
  /** Improvement runs work on a branch that is merged into main once it deployed. */
  branch?: string;
}

export interface WorkspaceManagerDeps {
  driver: WorkspaceDriver;
  control: ControlApi;
  /** Transcripts and per-workspace state. It must not be inside a workspace folder. */
  stateDir: string;
  /** The agent the driver's workspaces run, reported before a workspace is open. */
  agent: AgentInfo;
  /** Creates app databases where nothing else does (the local stack). */
  provisioner?: DatabaseProvisioner;
  /**
   * Where the app's bundles go before each deploy. Without it nothing is built and a deploy names the
   * workspace commit, which only the Control API's `local` deploy driver takes.
   */
  artifacts?: ArtifactStore;
  /**
   * The address a browser opens an app's dev preview at, behind the preview proxy; `{app}` is replaced
   * with the slug. Without it the workspace's own address is reported, which only works on this machine.
   */
  previewUrlTemplate?: string;
  /** Platform URLs the dev preview needs: DATA_API_URL and CONTROL_API_URL. */
  runtimeEnv?: Record<string, string>;
  logger: Logger;
  /** A workspace nobody used for this long is stopped (docs/infrastructure.md §4.1: 15 minutes). */
  idleMs?: number;
}

class TurnFailure extends Error {}

type Built = { ok: true; artifactUrl: string; nodesArtifactUrl?: string } | { ok: false; error: string };

const EMPTY_STATE: SavedState = { owner: null, handle: null, sessionId: null, deployedCommit: null, version: null, versionId: null, callerToken: null, lastCommit: null };

const firstLine = (text: string, max: number) => {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const commitMessage = (spec: TurnSpec) =>
  spec.kind === 'build' ? `Build the first version: ${firstLine(spec.prompt, 60)}` : spec.kind === 'improvement' ? `Improvement: ${firstLine(spec.prompt, 60)}` : firstLine(spec.prompt, 72);

export class WorkspaceManager {
  private readonly entries = new Map<string, Entry>();
  private readonly idleTimer: NodeJS.Timeout | null;

  constructor(private readonly deps: WorkspaceManagerDeps) {
    const idleMs = deps.idleMs ?? 15 * 60_000;
    this.idleTimer = idleMs > 0 ? setInterval(() => void this.stopIdle(idleMs), Math.min(idleMs, 60_000)) : null;
    this.idleTimer?.unref();
  }

  get driver() {
    return this.deps.driver.name;
  }

  get agent() {
    return this.deps.agent;
  }

  private entry(app: string): Entry {
    let entry = this.entries.get(app);
    if (!entry) {
      const dir = join(this.deps.stateDir, app);
      mkdirSync(dir, { recursive: true });
      const stateFile = join(dir, 'state.json');
      const state = existsSync(stateFile) ? { ...EMPTY_STATE, ...(JSON.parse(readFileSync(stateFile, 'utf8')) as Partial<SavedState>) } : { ...EMPTY_STATE };
      entry = { app, log: new EventLog(app, join(dir, 'events.jsonl')), state, stateFile, workspace: null, running: null, queue: Promise.resolve(), lastActive: Date.now() };
      this.entries.set(app, entry);
    }
    return entry;
  }

  private publicPreviewUrl(app: string, target: string): string {
    return this.deps.previewUrlTemplate?.replaceAll('{app}', app) ?? target;
  }

  /** Where the preview proxy forwards requests for this app, or null while its preview is not running. Counts as use of the workspace. */
  previewTarget(app: string): string | null {
    const entry = this.entries.get(app);
    const target = entry?.workspace?.previewTarget() ?? null;
    if (entry && target) entry.lastActive = Date.now();
    return target;
  }

  private save(entry: Entry): void {
    writeFileSync(entry.stateFile, JSON.stringify(entry.state, null, 2), { mode: 0o600 });
  }

  /** Null when the app has never had a workspace here. */
  async status(app: string): Promise<WorkspaceStatus | null> {
    const entry = this.entry(app);
    if (!entry.running && !entry.log.last && !(await this.deps.driver.exists(app))) return null;
    entry.lastActive = Date.now();
    const target = entry.workspace?.previewTarget() ?? null;
    return {
      app,
      state: entry.running ? 'working' : entry.workspace ? 'idle' : 'stopped',
      driver: this.deps.driver.name,
      agent: entry.workspace?.agent ?? this.deps.agent,
      previewUrl: target ? this.publicPreviewUrl(app, target) : null,
      lastCommit: entry.state.lastCommit,
      version: entry.state.version,
      turn: entry.running,
      lastEventId: entry.log.last?.id ?? 0,
    };
  }

  events(app: string): EventLog {
    const entry = this.entry(app);
    entry.lastActive = Date.now();
    return entry.log;
  }

  /** The Home prompt: creates the workspace when the app has none and builds from the prompt. */
  async start(app: AppInfo, owner: string, prompt: string): Promise<{ turn: string; done: Promise<TurnResult> }> {
    const entry = this.entry(app.slug);
    if (entry.running) throw new ApiError('conflict', 'The Builder is still working on this app.');
    // Starting from the template would deploy the starter schema over an app that already has one.
    if (!(await this.deps.driver.exists(app.slug)) && app.deployedToDev) {
      throw new ApiError('conflict', `${app.name} was not built in this Builder, so its code is not here to continue from.`);
    }
    entry.state.handle = app.handle;
    return this.launch(entry, { id: randomUUID(), kind: entry.state.deployedCommit ? 'message' : 'build', prompt, context: null, owner });
  }

  /** Builder chat: one agent turn on an existing workspace. */
  async message(app: Pick<AppInfo, 'slug' | 'handle'>, owner: string, text: string, context: string | null): Promise<{ turn: string; done: Promise<TurnResult> }> {
    const entry = this.entry(app.slug);
    if (entry.running) throw new ApiError('conflict', 'The Builder is still working on the last request.');
    if (!(await this.deps.driver.exists(app.slug))) throw new ApiError('not_found', 'This app has no Builder workspace yet.');
    entry.state.handle = app.handle;
    return this.launch(entry, { id: randomUUID(), kind: entry.state.deployedCommit ? 'message' : 'build', prompt: text, context, owner });
  }

  /** An approved proposal, implemented on a branch. Waits its turn behind whatever the workspace is doing. */
  async improve(job: ImprovementJob): Promise<RunOutcome> {
    const entry = this.entry(job.run.app);
    const branch = `improve/${job.run.id.slice(0, 8)}`;
    if (!entry.state.deployedCommit || !(await this.deps.driver.exists(job.run.app))) {
      return { status: 'failed', error: 'This app has no Builder workspace with a deployed build, so there is no code to change.' };
    }
    const prompt = [job.proposal.title, job.proposal.body, job.proposal.affects && `Affects: ${job.proposal.affects}`, job.proposal.refs.length > 0 && `Feedback tickets: ${job.proposal.refs.join(', ')}`]
      .filter(Boolean)
      .join('\n\n');
    const spec: TurnSpec = { id: randomUUID(), kind: 'improvement', prompt, context: null, owner: entry.state.owner ?? 'service:builder', branch };
    const result = await this.enqueue(entry, spec);
    if (result.status === 'failed') return { status: 'failed', branch, error: result.error ?? 'the run failed' };
    if (!result.changed) return { status: 'failed', branch, error: 'The coding agent made no change for this proposal.' };
    return { status: 'succeeded', branch, ...(result.versionId ? { versionId: result.versionId } : {}) };
  }

  private launch(entry: Entry, spec: TurnSpec) {
    // Marked before the turn is queued, so a second request arriving now gets `conflict` instead of piling up.
    entry.running = { id: spec.id, kind: spec.kind };
    return { turn: spec.id, done: this.enqueue(entry, spec) };
  }

  private enqueue(entry: Entry, spec: TurnSpec): Promise<TurnResult> {
    const done = entry.queue.then(() => this.runTurn(entry, spec));
    entry.queue = done.catch(() => undefined);
    return done;
  }

  private async check(workspace: Workspace): Promise<CheckResult> {
    try {
      return checkManifest(workspace.app, await workspace.manifest());
    } catch (e) {
      if (!(e instanceof ManifestError)) throw e;
      return { ok: false, problems: [{ path: 'kelay', message: `the files in kelay/ did not load: ${e.message}` }] };
    }
  }

  /** Builds the bundles of the workspace's current commit and stores them. */
  private async build(store: ArtifactStore, entry: Entry, workspace: Workspace, graphs: number): Promise<Built> {
    if (!entry.state.handle) throw new TurnFailure('This workspace does not know its builder’s handle yet, so the app cannot be built. Send a message from the console once.');
    const { commit } = await workspace.head();
    const outDir = await mkdtemp(join(tmpdir(), 'kelay-build-'));
    try {
      const built = await workspace.build({ outDir, basePath: `/${entry.state.handle}/${entry.app}` });
      // Each graph becomes a state machine that invokes the node function, so its code has to exist.
      if (graphs > 0 && !built.nodes) return { ok: false, error: `kelay/graphs.ts declares ${graphs === 1 ? 'a graph' : 'graphs'}, but ${NODES_ENTRY} with the code of the nodes is missing.` };
      const artifactUrl = await store.put(artifactKey(entry.app, commit, 'web.zip'), built.web.file);
      const nodesArtifactUrl = built.nodes ? await store.put(artifactKey(entry.app, commit, 'nodes.zip'), built.nodes.file) : undefined;
      return { ok: true, artifactUrl, ...(nodesArtifactUrl ? { nodesArtifactUrl } : {}) };
    } catch (e) {
      if (!(e instanceof BuildError)) throw e;
      return { ok: false, error: e.message };
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }

  private async runTurn(entry: Entry, spec: TurnSpec): Promise<TurnResult> {
    const { app } = entry;
    const emit = (body: WorkspaceEventBody) => entry.log.append(spec.id, body);
    let step: { key: string; text: string } | null = null;
    const endStep = (status: 'done' | 'failed') => {
      if (step) emit({ type: 'step', ...step, status });
      step = null;
    };
    const beginStep = (key: string, text: string) => {
      endStep('done');
      step = { key, text };
      emit({ type: 'step', key, text, status: 'running' });
    };

    entry.running = { id: spec.id, kind: spec.kind };
    const branch = spec.branch ?? MAIN;
    let workspace: Workspace | null = null;
    let versionId: string | null = null;
    let changed = false;
    try {
      emit({ type: 'turn.started', kind: spec.kind, prompt: spec.prompt, context: spec.context, agent: entry.workspace?.agent ?? this.deps.agent });

      if (!entry.workspace) {
        beginStep('workspace', (await this.deps.driver.exists(app)) ? 'Opening the workspace' : 'Creating the workspace');
        entry.workspace = await this.deps.driver.open(app, spec.owner);
        entry.state.owner ??= spec.owner;
      }
      workspace = entry.workspace;
      void this.recordSandbox(entry, spec, 'running');
      if (spec.branch) await workspace.checkout(spec.branch);

      let agentSteps = 0;
      let lastText = '';
      const onAgentEvent = (event: AgentEvent) => {
        if (event.type === 'step') beginStep(`agent-${++agentSteps}`, event.text);
        else if (event.type === 'file') emit({ type: 'file', path: event.path, change: event.change });
        else if (event.text !== lastText) emit({ type: 'assistant.text', text: (lastText = event.text) });
      };
      const runAgent = async (prompt: string) => {
        const result = await workspace!.runAgent({ app, kind: spec.kind, prompt, context: spec.context, sessionId: entry.state.sessionId }, onAgentEvent);
        entry.state.sessionId = result.sessionId ?? null;
        if (result.text && result.text !== lastText) emit({ type: 'assistant.text', text: (lastText = result.text) });
      };
      const commit = async (message: string) => {
        const made = await workspace!.commit(message);
        if (!made) return;
        changed = true;
        entry.state.lastCommit = { commit: made.commit, message: made.message, branch: made.branch };
        emit({ type: 'commit', commit: made.commit, message: made.message, files: made.files, branch: made.branch });
      };

      await runAgent(spec.prompt);
      await commit(commitMessage(spec));

      const head = await workspace.head();
      entry.state.lastCommit = head;
      if (head.commit !== entry.state.deployedCommit) {
        beginStep('check', 'Checking data and access rules');
        let check = await this.check(workspace);
        emit({ type: 'validation', ok: check.ok, attempt: 1, problems: check.problems });
        // Null when this Builder keeps no artifacts: then nothing is built.
        const build = async (attempt: number, graphs: number): Promise<Built | null> => {
          const store = this.deps.artifacts;
          if (!store) return null;
          beginStep(attempt === 1 ? 'build' : 'build-2', attempt === 1 ? 'Building the app' : 'Building the app again');
          const result = await this.build(store, entry, workspace!, graphs);
          emit({ type: 'build', ok: result.ok, attempt, error: result.ok ? null : result.error });
          return result;
        };
        let built = check.ok ? await build(1, check.app.graphs.length) : null;
        if (!check.ok || built?.ok === false) {
          if (!check.ok) {
            beginStep('fix', 'Fixing what the check found');
            await runAgent(`The platform checked kelay/ after your changes and it did not pass, so nothing was deployed:\n\n${describeProblems(check.problems)}\n\nFix exactly these problems.`);
            await commit('Fix what the check of kelay/ found');
          } else if (built?.ok === false) {
            beginStep('fix', 'Fixing what the build found');
            await runAgent(`The platform built the app after your changes and the build failed, so nothing was deployed:\n\n${built.error}\n\nFix exactly what the build reports.`);
            await commit('Fix what the build found');
          }
          beginStep('check-2', 'Checking data and access rules again');
          check = await this.check(workspace);
          emit({ type: 'validation', ok: check.ok, attempt: 2, problems: check.problems });
          if (!check.ok) throw new TurnFailure('The app’s data and access rules still do not pass the check, so nothing was deployed.');
          built = await build(2, check.app.graphs.length);
          if (built?.ok === false) throw new TurnFailure(`The app still does not build, so nothing was deployed: ${firstLine(built.error, 300)}`);
        }

        beginStep('deploy', 'Deploying to Development');
        const deployed = (await workspace.head()).commit;
        try {
          if (this.deps.provisioner) await this.deps.control.setDatabase(app, 'dev', await this.deps.provisioner.ensure(app, 'dev'));
          const version = await this.deps.control.deploy(app, 'dev', {
            commit: deployed,
            ...(built?.ok ? { artifactUrl: built.artifactUrl, ...(built.nodesArtifactUrl ? { nodesArtifactUrl: built.nodesArtifactUrl } : {}) } : { artifactUrl: `workspace://${app}/${deployed}` }),
            configVersion: `cfg-${deployed.slice(0, 12)}`,
            ...check.app,
          });
          versionId = version.id;
          entry.state = { ...entry.state, deployedCommit: deployed, version: version.label, versionId: version.id, callerToken: version.callerToken ?? entry.state.callerToken };
          emit({ type: 'deploy', ok: true, env: 'dev', version: version.label, versionId: version.id, error: null });
        } catch (e) {
          emit({ type: 'deploy', ok: false, env: 'dev', version: null, versionId: null, error: (e as Error).message });
          throw new TurnFailure(`The deploy to Development failed: ${(e as Error).message}`);
        }
      }

      if (!workspace.previewTarget()) beginStep('preview', 'Starting the dev preview');
      const target = await workspace.startPreview({ ...this.deps.runtimeEnv, ...(entry.state.callerToken ? { KELAY_CALLER_TOKEN: entry.state.callerToken } : {}) });
      emit({ type: 'preview', url: this.publicPreviewUrl(app, target) });
      endStep('done');

      if (spec.branch && changed) await workspace.merge(spec.branch, MAIN);
      else if (spec.branch) await workspace.checkout(MAIN);
      emit({ type: 'turn.finished', status: 'succeeded', error: null });
      return { status: 'succeeded', error: null, branch, versionId, changed };
    } catch (e) {
      const error = e instanceof TurnFailure || e instanceof ApiError ? e.message : `The Builder could not finish: ${(e as Error).message}`;
      if (!(e instanceof TurnFailure)) this.deps.logger.error({ type: 'turn_failed', app, turn: spec.id, err: (e as Error).message }, 'turn failed');
      endStep('failed');
      // A failed improvement stays on its branch for inspection; the workspace goes back to what is deployed.
      if (spec.branch && workspace) await workspace.checkout(MAIN).catch(() => undefined);
      emit({ type: 'turn.finished', status: 'failed', error });
      return { status: 'failed', error, branch, versionId, changed };
    } finally {
      entry.running = null;
      entry.lastActive = Date.now();
      this.save(entry);
    }
  }

  private async recordSandbox(entry: Entry, spec: Pick<TurnSpec, 'kind' | 'owner'>, status: 'running' | 'stopped'): Promise<void> {
    if (!entry.workspace) return;
    try {
      await this.deps.control.recordSandbox({ taskArn: entry.workspace.ref, owner: spec.owner, app: entry.app, kind: spec.kind === 'improvement' ? 'improvement' : 'workspace', status });
    } catch (e) {
      this.deps.logger.warn({ type: 'sandbox_record_failed', app: entry.app, err: (e as Error).message }, 'could not record the sandbox');
    }
  }

  private async stopEntry(entry: Entry): Promise<void> {
    const workspace = entry.workspace;
    if (!workspace) return;
    await this.recordSandbox(entry, { kind: 'message', owner: entry.state.owner ?? 'service:builder' }, 'stopped');
    entry.workspace = null;
    await workspace.stop().catch((e: Error) => this.deps.logger.warn({ type: 'workspace_stop_failed', app: entry.app, err: e.message }, 'could not stop the workspace'));
  }

  private async stopIdle(idleMs: number): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.workspace && !entry.running && Date.now() - entry.lastActive > idleMs) {
        this.deps.logger.info({ type: 'workspace_idle', app: entry.app }, 'stopping an idle workspace');
        await this.stopEntry(entry);
      }
    }
  }

  /**
   * For a restart of this service. Local previews are its child processes and stop with it; state stays on
   * disk, so the next message resumes. Fargate tasks keep running and are found again by `open`.
   */
  async shutdown(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.deps.driver.name !== 'local') return;
    await Promise.all([...this.entries.values()].map((entry) => this.stopEntry(entry)));
  }
}
