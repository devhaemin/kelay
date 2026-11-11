// Workspaces on this machine: a directory per app under a workspaces root, a git repo started from
// templates/starter, and `next dev` on a free port as the preview.
import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { execa } from 'execa';
import getPort from 'get-port';
import { simpleGit, type SimpleGit } from 'simple-git';
import { SLUG } from '@kelay/contracts';
import type { AgentEvent, AgentTurn, CodingAgent } from '../agents/types.ts';
import { buildAppArtifacts } from '../artifacts/build.ts';
import { ManifestError, type CommitInfo, type Workspace, type WorkspaceDriver } from './types.ts';

const TEMPLATE_SLUG = 'starter-app';
const MAIN = 'main';
const SKIP = new Set(['node_modules', '.next', 'next-env.d.ts', 'tsconfig.tsbuildinfo']);

export interface Preview {
  url: string;
  stop(): Promise<void>;
}

/** Starts the preview server of a workspace and resolves once it answers. */
export type PreviewLauncher = (opts: { dir: string; env: Record<string, string> }) => Promise<Preview>;

export interface LocalDriverOptions {
  /** One directory per app is created here. */
  root: string;
  /** templates/starter, with its dependencies installed: the SDK toolchain every workspace shares. */
  templateDir: string;
  agent: CodingAgent;
  /** Defaults to `next dev` from the toolchain. */
  preview?: PreviewLauncher;
}

/** Only what a build tool needs. The service's own environment (caller secret, API keys) is never passed on. */
const toolEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  NEXT_TELEMETRY_DISABLED: '1',
  ...extra,
});

function commonAncestor(a: string, b: string): string {
  const [x, y] = [a.split(sep), b.split(sep)];
  let i = 0;
  while (i < x.length && x[i] === y[i]) i++;
  return x.slice(0, i).join(sep) || sep;
}

/** `next dev` from the workspace's toolchain, on `fixedPort` or else on any free port. */
export const nextDevPreview = (fixedPort?: number): PreviewLauncher => async ({ dir, env }) => {
  const port = fixedPort ?? (await getPort());
  const toolchain = realpathSync(join(dir, 'node_modules'));
  const child = execa(process.execPath, [join(dir, 'node_modules/next/dist/bin/next'), 'dev', '--port', String(port)], {
    cwd: dir,
    extendEnv: false,
    env: toolEnv({ ...env, KELAY_TOOLCHAIN_ROOT: commonAncestor(realpathSync(dir), toolchain), PORT: String(port) }),
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so stopping the preview also stops the workers `next dev` starts.
    detached: true,
    reject: false,
    // The server runs for hours: keep the last lines for an error message, not everything it prints.
    buffer: false,
  });
  let tail = '';
  let exited = false;
  for (const out of [child.stdout, child.stderr]) out?.on('data', (chunk: Buffer) => (tail = (tail + chunk.toString()).slice(-1500)));
  void child.then(() => (exited = true));

  const signal = (name: NodeJS.Signals) => {
    try {
      if (child.pid !== undefined && !exited) process.kill(-child.pid, name);
    } catch {
      // Already gone.
    }
  };
  const stop = async () => {
    signal('SIGTERM');
    await Promise.race([child, sleep(5000)]);
    signal('SIGKILL');
  };

  const url = `http://localhost:${port}`;
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (exited) throw new Error(`the preview server exited while starting: ${tail.trim() || 'no output'}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      await res.body?.cancel();
      // Any answer means the server is up. A page that fails to compile is the agent's to fix, and shows in the preview.
      return { url, stop };
    } catch {
      if (Date.now() > deadline) {
        await stop();
        throw new Error(`the preview did not answer at ${url} in time: ${tail.trim()}`);
      }
      await sleep(300);
    }
  }
};

class LocalWorkspace implements Workspace {
  readonly ref: string;
  private preview: Preview | null = null;
  private starting: Promise<Preview> | null = null;

  constructor(
    readonly app: string,
    readonly dir: string,
    readonly created: boolean,
    private readonly coder: CodingAgent,
    private readonly git: SimpleGit,
    private readonly launch: PreviewLauncher,
  ) {
    this.ref = `local:${dir}`;
  }

  get agent() {
    return this.coder.info;
  }

  runAgent(turn: Omit<AgentTurn, 'dir'>, emit: (event: AgentEvent) => void) {
    return this.coder.run({ ...turn, dir: this.dir }, emit);
  }

  async commit(message: string): Promise<CommitInfo | null> {
    await this.git.add(['-A']);
    const status = await this.git.status();
    if (status.files.length === 0) return null;
    const files = status.files.map((f) => f.path);
    const result = await this.git.commit(message);
    const commit = await this.git.revparse(['HEAD']);
    return { commit, message, branch: result.branch || status.current || MAIN, files };
  }

  async head() {
    const log = await this.git.log({ maxCount: 1 });
    const branch = (await this.git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    return { commit: log.latest!.hash, message: log.latest!.message, branch };
  }

  async checkout(branch: string) {
    const { all } = await this.git.branchLocal();
    await (all.includes(branch) ? this.git.checkout(branch) : this.git.checkoutLocalBranch(branch));
  }

  async merge(branch: string, into: string) {
    await this.git.checkout(into);
    await this.git.merge(['--ff-only', branch]);
  }

  async manifest(): Promise<unknown> {
    const run = await execa(process.execPath, [join(this.dir, 'node_modules/tsx/dist/cli.mjs'), 'kelay/manifest.ts'], {
      cwd: this.dir,
      extendEnv: false,
      env: toolEnv(),
      reject: false,
      timeout: 60_000,
    });
    if (run.exitCode !== 0) throw new ManifestError((run.stderr || run.shortMessage || 'kelay/manifest.ts failed').slice(-1500));
    try {
      return JSON.parse(run.stdout);
    } catch {
      throw new ManifestError(`kelay/manifest.ts printed something that is not JSON: ${run.stdout.slice(0, 300)}`);
    }
  }

  build(opts: { outDir: string; basePath: string }) {
    return buildAppArtifacts(this.dir, opts);
  }

  async startPreview(env: Record<string, string>): Promise<string> {
    if (this.preview) return this.preview.url;
    this.starting ??= this.launch({ dir: this.dir, env }).finally(() => (this.starting = null));
    this.preview = await this.starting;
    return this.preview.url;
  }

  previewUrl() {
    return this.preview?.url ?? null;
  }

  async stop() {
    const preview = this.preview ?? (await this.starting?.catch(() => null)) ?? null;
    this.preview = null;
    await preview?.stop();
  }
}

export class LocalWorkspaceDriver implements WorkspaceDriver {
  readonly name = 'local';
  private readonly root: string;
  private readonly open_ = new Map<string, Promise<LocalWorkspace>>();

  constructor(private readonly opts: LocalDriverOptions) {
    this.root = resolve(opts.root);
  }

  private dirOf(app: string): string {
    if (!SLUG.test(app)) throw new Error(`invalid app slug ${JSON.stringify(app)}`);
    return join(this.root, app);
  }

  async exists(app: string) {
    return existsSync(join(this.dirOf(app), '.git'));
  }

  open(app: string, _owner?: string): Promise<Workspace> {
    let ws = this.open_.get(app);
    if (!ws) {
      ws = this.create(app);
      this.open_.set(app, ws);
      ws.catch(() => this.open_.delete(app));
    }
    return ws;
  }

  private async create(app: string): Promise<LocalWorkspace> {
    const dir = this.dirOf(app);
    const created = !(await this.exists(app));
    if (created) await this.scaffold(app, dir);
    return new LocalWorkspace(app, dir, created, this.opts.agent, simpleGit(dir), this.opts.preview ?? nextDevPreview());
  }

  private async scaffold(app: string, dir: string): Promise<void> {
    const template = resolve(this.opts.templateDir);
    await mkdir(dir, { recursive: true });
    await cp(template, dir, { recursive: true, filter: (src) => !SKIP.has(basename(src)) });
    const schema = join(dir, 'kelay/schema.ts');
    await writeFile(schema, (await readFile(schema, 'utf8')).replace(`'${TEMPLATE_SLUG}'`, `'${app}'`));
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    await writeFile(join(dir, 'package.json'), `${JSON.stringify({ ...pkg, name: app }, null, 2)}\n`);
    // The toolchain is installed once, with the template. Workspaces share it instead of installing their own.
    if (existsSync(join(template, 'node_modules'))) await symlink(join(template, 'node_modules'), join(dir, 'node_modules'), 'dir');

    const git = simpleGit(dir);
    await git.init(['--initial-branch', MAIN]);
    await git.addConfig('user.name', 'Kelay Builder');
    await git.addConfig('user.email', 'builder@kelay.app');
    await git.addConfig('commit.gpgsign', 'false');
    await git.add(['-A']);
    await git.commit('Start from the Kelay starter template');
  }
}
