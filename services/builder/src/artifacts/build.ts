// Turns a workspace into what the Control API's `aws` deploy driver creates functions from
// (docs/infrastructure.md §1 "App runtime"): `web.zip`, the Next.js app packaged by OpenNext with the
// handler `index.handler`, and `nodes.zip`, the app's agent nodes behind @kelay/runtime's Lambda
// handler as `nodes.handler`.
import { createWriteStream, existsSync, realpathSync } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readdir, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';
import { build as esbuild } from 'esbuild';
import { execa } from 'execa';

const require = createRequire(import.meta.url);
const WEB_HANDLER = fileURLToPath(new URL('./web-handler.ts', import.meta.url));
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb'];
/** Never part of a build: installed or generated files, and the repo itself. */
const SKIP = new Set(['node_modules', '.next', '.open-next', '.git', 'next-env.d.ts', 'tsconfig.tsbuildinfo', 'open-next.config.ts']);
/** The app's agent-node code. It runs in the node function, so it is left out of the Next.js build. */
export const NODES_ENTRY = 'kelay/nodes.ts';
const ASSETS_DIR = 'assets';

export interface BuildOptions {
  /** Where `web.zip` and `nodes.zip` are written. */
  outDir: string;
  /**
   * The path the app is served under, `/<handle>/<app>`: the Router forwards the whole request path
   * to the function, so the app is built with this as its Next.js `basePath`.
   */
  basePath?: string;
  /**
   * Scratch folder for the build. It has to sit inside the toolchain root (the folder with the lockfile
   * and the installed packages), because Next.js traces the files a server needs from that root.
   * @default <toolchain root>/.kelay/builds
   */
  buildRoot?: string;
  /** Receives the build tools' output, line by line. */
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}

export interface BuiltArtifact {
  file: string;
  bytes: number;
  /** `<file>.<export>` as Lambda takes it. */
  handler: string;
}

export interface AppArtifacts {
  web: BuiltArtifact;
  /** Null when the app has no `kelay/nodes.ts`. */
  nodes: BuiltArtifact | null;
}

export class BuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildError';
  }
}

/** Only what a build tool needs: the build runs agent-written code, so it gets none of this process's settings. */
const buildEnv = (extra: Record<string, string>): Record<string, string> => ({
  ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
  NEXT_TELEMETRY_DISABLED: '1',
  NODE_ENV: 'production',
  ...extra,
});

/** The folder whose lockfile and `node_modules` the workspace's packages come from. */
function toolchainRootOf(workspaceDir: string): { root: string; modules: string } {
  const link = join(workspaceDir, 'node_modules');
  if (!existsSync(link)) throw new BuildError('the workspace has no node_modules, so there is no toolchain to build it with');
  const modules = realpathSync(link);
  for (let dir = dirname(modules); ; dir = dirname(dir)) {
    if (LOCKFILES.some((name) => existsSync(join(dir, name)))) return { root: dir, modules };
    if (dirname(dir) === dir) throw new BuildError(`no lockfile above ${modules}: the toolchain is not an installed package tree`);
  }
}

const openNextConfig = `// Written by the Kelay Builder for this build.
// One function behind a Lambda function URL (the API Gateway v2 event format). There is no bucket,
// table or queue next to an app function, so pages render on request and nothing is revalidated.
const config = {
  default: { override: { wrapper: 'aws-lambda', converter: 'aws-apigw-v2', incrementalCache: 'dummy', tagCache: 'dummy', queue: 'dummy' } },
  // No image function is deployed; \`false\` keeps the build from downloading sharp for one.
  imageOptimization: { install: false },
  dangerous: { disableIncrementalCache: true, disableTagCache: true },
  buildCommand: 'node node_modules/next/dist/bin/next build',
};
export default config;
`;

async function run(command: string, args: string[], cwd: string, env: Record<string, string>, opts: BuildOptions, what: string): Promise<void> {
  const child = execa(command, args, { cwd, env, extendEnv: false, reject: false, all: true, buffer: false, ...(opts.signal ? { cancelSignal: opts.signal } : {}) });
  let tail = '';
  child.all?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    tail = (tail + text).slice(-4000);
    if (opts.onLog) for (const line of text.split('\n')) if (line.trim()) opts.onLog(line);
  });
  const result = await child;
  if (result.exitCode !== 0) throw new BuildError(`${what} failed${result.exitCode === undefined ? '' : ` (exit ${result.exitCode})`}:\n${tail.trim() || result.shortMessage}`);
}

/** Zips a folder as Lambda unpacks it: paths relative to the folder, links kept as links. */
async function zipDir(dir: string, file: string): Promise<number> {
  await mkdir(dirname(file), { recursive: true });
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const out = createWriteStream(file);
  const done = new Promise<void>((ok, fail) => {
    out.on('close', ok);
    out.on('error', fail);
    archive.on('error', fail);
    archive.on('warning', fail);
  });
  archive.pipe(out);
  // A fixed time, so the same build gives the same bytes.
  const date = new Date('2000-01-01T00:00:00Z');
  const walk = async (rel: string): Promise<void> => {
    for (const name of (await readdir(join(dir, rel))).sort()) {
      const path = rel ? `${rel}/${name}` : name;
      const info = await lstat(join(dir, path));
      if (info.isSymbolicLink()) archive.symlink(path, await readlink(join(dir, path)), 0o755);
      else if (info.isDirectory()) await walk(path);
      else if (info.isFile()) archive.file(join(dir, path), { name: path, date, mode: info.mode & 0o111 ? 0o755 : 0o644 });
    }
  };
  await walk('');
  await archive.finalize();
  await done;
  return (await stat(file)).size;
}

async function buildWeb(stage: string, toolchainRoot: string, opts: BuildOptions): Promise<BuiltArtifact> {
  await writeFile(join(stage, 'open-next.config.ts'), openNextConfig);
  const env = buildEnv({ KELAY_TOOLCHAIN_ROOT: toolchainRoot, ...(opts.basePath ? { KELAY_BASE_PATH: opts.basePath } : {}) });
  await run(process.execPath, [require.resolve('@opennextjs/aws/index.js'), 'build'], stage, env, opts, 'the Next.js build');

  // In a package tree OpenNext keeps the app at its path below the root and puts an index.mjs that
  // re-exports its handler at the top of the function.
  const fn = join(stage, '.open-next/server-functions/default');
  if (!existsSync(join(fn, 'index.mjs'))) throw new BuildError('OpenNext produced no server function');
  await rename(join(fn, 'index.mjs'), join(fn, 'open-next.mjs'));
  // No CDN or bucket sits in front of an app function, so it serves its own static files.
  const assets = join(stage, '.open-next/assets');
  if (existsSync(assets)) await cp(assets, join(fn, ASSETS_DIR), { recursive: true });
  const entry = join(stage, '.open-next/kelay-web-entry.ts');
  await writeFile(
    entry,
    [
      `import { handler as app } from './open-next.mjs';`,
      `import { createWebHandler } from ${JSON.stringify(WEB_HANDLER)};`,
      `export const handler = createWebHandler(app, { assetsDir: new URL('./${ASSETS_DIR}/', import.meta.url), basePath: ${JSON.stringify(opts.basePath ?? '')} });`,
      '',
    ].join('\n'),
  );
  await esbuild({
    entryPoints: [entry],
    outfile: join(fn, 'index.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external: ['./open-next.mjs'],
    logLevel: 'silent',
  });

  const file = join(resolve(opts.outDir), 'web.zip');
  return { file, bytes: await zipDir(fn, file), handler: 'index.handler' };
}

async function buildNodes(workspaceDir: string, stage: string, opts: BuildOptions): Promise<BuiltArtifact | null> {
  const nodes = join(workspaceDir, NODES_ENTRY);
  if (!existsSync(nodes)) return null;
  const out = join(stage, '.kelay-nodes');
  await mkdir(out, { recursive: true });
  const entry = join(out, 'entry.ts');
  await writeFile(
    entry,
    [`import { createLambdaHandler } from '@kelay/runtime';`, `import { graphs } from ${JSON.stringify(nodes)};`, `export const handler = createLambdaHandler(graphs);`, ''].join('\n'),
  );
  try {
    await esbuild({
      entryPoints: [entry],
      outfile: join(out, 'fn/nodes.mjs'),
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      // Node code is written against the platform's packages (@kelay/runtime and what it brings), which
      // come with the Builder, not with the app.
      nodePaths: [fileURLToPath(new URL('../../node_modules', import.meta.url))],
      // Bundled CommonJS dependencies call require() for Node built-ins.
      banner: { js: "import { createRequire as __kelayCreateRequire } from 'node:module'; const require = __kelayCreateRequire(import.meta.url);" },
      logLevel: 'silent',
    });
  } catch (e) {
    throw new BuildError(`${NODES_ENTRY} did not bundle:\n${(e as Error).message}`);
  }
  const file = join(resolve(opts.outDir), 'nodes.zip');
  return { file, bytes: await zipDir(join(out, 'fn'), file), handler: 'nodes.handler' };
}

/**
 * Builds the app in `workspaceDir` and writes `web.zip` and, when the app has `kelay/nodes.ts`,
 * `nodes.zip` to `opts.outDir`. The workspace itself is not touched: the build runs on a copy.
 */
export async function buildAppArtifacts(workspaceDir: string, opts: BuildOptions): Promise<AppArtifacts> {
  const workspace = resolve(workspaceDir);
  if (opts.basePath !== undefined && !/^(\/[a-z0-9][a-z0-9-]*)+$/.test(opts.basePath)) throw new BuildError(`invalid base path ${JSON.stringify(opts.basePath)}`);
  const { root, modules } = toolchainRootOf(workspace);
  const buildRoot = resolve(opts.buildRoot ?? join(root, '.kelay/builds'));
  if (!(buildRoot + sep).startsWith(root + sep)) throw new BuildError(`the build folder ${buildRoot} must be inside the toolchain root ${root}`);
  await mkdir(buildRoot, { recursive: true });
  const stage = await mkdtemp(join(buildRoot, `${basename(workspace)}-`));
  try {
    await cp(workspace, stage, {
      recursive: true,
      filter: (src) => !SKIP.has(basename(src)) && relative(workspace, src).split(sep).join('/') !== NODES_ENTRY,
    });
    await symlink(modules, join(stage, 'node_modules'), 'dir');
    await mkdir(resolve(opts.outDir), { recursive: true });
    const web = await buildWeb(stage, root, opts);
    const nodes = await buildNodes(workspace, stage, opts);
    return { web, nodes };
  } finally {
    // KELAY_KEEP_BUILD=1 leaves the build folder in place, to look at what the tools produced.
    if (!process.env.KELAY_KEEP_BUILD) await rm(stage, { recursive: true, force: true });
  }
}
