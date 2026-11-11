// Claims approved improvement runs from the Control API and runs each as an agent turn on a branch
// (docs/infrastructure.md §4.3). The run is always completed, also when the turn throws.
import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from 'pino';
import type { ControlApi, RunOutcome } from './control.ts';
import type { WorkspaceManager } from './workspaces.ts';

export interface ImprovementWorkerDeps {
  control: ControlApi;
  workspaces: WorkspaceManager;
  logger: Logger;
  /** Name stored on the run as its worker. */
  worker: string;
  pollMs?: number;
}

export class ImprovementWorker {
  private stopped = false;
  private loop: Promise<void> | null = null;

  constructor(private readonly deps: ImprovementWorkerDeps) {}

  /** Claims and runs one queued run. False when the queue was empty. */
  async runOnce(): Promise<boolean> {
    const { control, workspaces, logger } = this.deps;
    const job = await control.claimImprovement(this.deps.worker);
    if (!job) return false;
    logger.info({ type: 'improvement_claimed', run: job.run.id, app: job.run.app }, 'improvement run claimed');
    let outcome: RunOutcome;
    try {
      outcome = await workspaces.improve(job);
    } catch (e) {
      outcome = { status: 'failed', error: (e as Error).message };
    }
    await control.completeImprovement(job.run.id, { ...outcome, ...(outcome.error ? { error: outcome.error.slice(0, 5000) } : {}) });
    logger.info({ type: 'improvement_completed', run: job.run.id, app: job.run.app, status: outcome.status }, 'improvement run completed');
    return true;
  }

  start(): void {
    this.loop ??= (async () => {
      while (!this.stopped) {
        try {
          if (await this.runOnce()) continue;
        } catch (e) {
          this.deps.logger.warn({ type: 'improvement_poll_failed', err: (e as Error).message }, 'could not poll improvement runs');
        }
        await sleep(this.deps.pollMs ?? 5000);
      }
    })();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}
