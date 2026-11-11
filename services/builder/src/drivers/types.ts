// Where a Builder workspace lives (docs/infrastructure.md §4.1). The sandbox holds the app's git repo,
// the coding agent and `next dev`; everything that needs a platform secret stays outside it.
import type { AgentEvent, AgentResult, AgentTurn } from '../agents/types.ts';
import type { AppArtifacts } from '../artifacts/build.ts';
import type { AgentInfo } from '../events.ts';

export interface CommitInfo {
  commit: string;
  message: string;
  branch: string;
  files: string[];
}

export interface Workspace {
  readonly app: string;
  /** What identifies the sandbox in the control DB's `sandboxes.task_arn`: an ECS task ARN, or `local:<dir>`. */
  readonly ref: string;
  /** True when `open` created the repo from the template just now. */
  readonly created: boolean;
  readonly agent: AgentInfo;

  runAgent(turn: Omit<AgentTurn, 'dir'>, emit: (event: AgentEvent) => void): Promise<AgentResult>;
  /** Commits everything that changed. Null when nothing did. */
  commit(message: string): Promise<CommitInfo | null>;
  head(): Promise<{ commit: string; message: string; branch: string }>;
  /** Switches to `branch`, creating it from the current commit when it does not exist. */
  checkout(branch: string): Promise<void>;
  /** Fast-forwards `into` to `branch` and leaves the workspace on `into`. */
  merge(branch: string, into: string): Promise<void>;
  /** What kelay/schema.ts, kelay/policy.ts and kelay/graphs.ts declare, as plain JSON. Throws `ManifestError` when they do not load. */
  manifest(): Promise<unknown>;
  /**
   * Builds the deployable bundles of the files as they are now (src/artifacts/build.ts) and puts
   * `web.zip` and `nodes.zip` in `outDir` on the caller's side. Throws `BuildError` when the app does not build.
   */
  build(opts: { outDir: string; basePath: string }): Promise<AppArtifacts>;
  /** Starts the dev preview when it is not running and returns its URL. `env` is the runtime's platform environment. */
  startPreview(env: Record<string, string>): Promise<string>;
  previewUrl(): string | null;
  stop(): Promise<void>;
}

export interface WorkspaceDriver {
  readonly name: 'local' | 'fargate';
  /** Whether a workspace for this app was created before, without starting anything. */
  exists(app: string): Promise<boolean>;
  /** Creates the workspace from the starter template on first use, and starts its sandbox. */
  open(app: string, owner: string): Promise<Workspace>;
}

/** kelay/*.ts did not evaluate. The message is the tail of what the app printed. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}
