// Approved proposals become improvement runs. The improvement_runs row is always the record of a run;
// the queue decides how a worker (the sandbox orchestrator) learns about it.
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { improvementRuns, proposals, type ImprovementRunRow } from '../db/schema.ts';

export interface ImprovementQueue {
  readonly kind: 'postgres' | 'sqs';
  /** Called after the approval commits, so the run row is visible to any worker that reacts. */
  enqueue(run: ImprovementRunRow): Promise<void>;
}

export const IMPROVEMENT_CHANNEL = 'kelay_improvement_runs';

/** Queue backed by the improvement_runs table: workers LISTEN for a wake-up and claim rows with SKIP LOCKED. */
export class PgImprovementQueue implements ImprovementQueue {
  readonly kind = 'postgres';

  constructor(private readonly db: Db) {}

  async enqueue(run: ImprovementRunRow): Promise<void> {
    await this.db.execute(sql`select pg_notify(${IMPROVEMENT_CHANNEL}, ${run.id})`);
  }
}

export interface SqsQueueOptions {
  queueUrl: string;
  client?: SQSClient;
}

/** Same rows, plus a message per run for an SQS-driven orchestrator. Consumers still claim through the API. */
export class SqsImprovementQueue implements ImprovementQueue {
  readonly kind = 'sqs';
  private readonly client: SQSClient;

  constructor(private readonly opts: SqsQueueOptions) {
    this.client = opts.client ?? new SQSClient({});
  }

  async enqueue(run: ImprovementRunRow): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.opts.queueUrl,
        MessageBody: JSON.stringify({ runId: run.id, proposalId: run.proposalId, app: run.app }),
        MessageAttributes: { app: { DataType: 'String', StringValue: run.app } },
      }),
    );
  }
}

/** Takes the oldest queued run, optionally for one app. Concurrent workers never get the same row. */
export async function claimRun(db: Db, worker: string, app?: string): Promise<ImprovementRunRow | null> {
  const appFilter = app ? sql`and app = ${app}` : sql``;
  const res = await db.execute<{ id: string }>(sql`
    update improvement_runs set status = 'running', worker = ${worker}, started_at = now()
    where id = (
      select id from improvement_runs where status = 'queued' ${appFilter}
      order by created_at for update skip locked limit 1
    )
    returning id`);
  const id = res.rows[0]?.id;
  if (!id) return null;
  return (await db.query.improvementRuns.findFirst({ where: eq(improvementRuns.id, id) })) ?? null;
}

export interface RunOutcome {
  status: 'succeeded' | 'failed';
  branch?: string;
  versionId?: string;
  error?: string;
}

/** Marks a running run finished; a successful run marks its proposal `built`. Returns null if the run was not running. */
export async function completeRun(db: Db, id: string, outcome: RunOutcome): Promise<ImprovementRunRow | null> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .update(improvementRuns)
      .set({
        status: outcome.status,
        branch: outcome.branch ?? null,
        versionId: outcome.versionId ?? null,
        error: outcome.error ?? null,
        finishedAt: new Date(),
      })
      .where(and(eq(improvementRuns.id, id), eq(improvementRuns.status, 'running')))
      .returning();
    if (!run) return null;
    if (outcome.status === 'succeeded') {
      await tx
        .update(proposals)
        .set({ status: 'built' })
        .where(and(eq(proposals.id, run.proposalId), eq(proposals.status, 'approved')));
    }
    return run;
  });
}
