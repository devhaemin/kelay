// Workspaces as ECS Fargate tasks (docs/infrastructure.md §1 "Sandboxes", §4.1). Each app has its own
// EFS access point, so a task can only ever see that app's repo, and a task definition that mounts it.
// The task runs the workspace runtime (src/runtime-server.ts); the service reaches it over the VPC.
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  StopTaskCommand,
  type Task,
} from '@aws-sdk/client-ecs';
import { CreateAccessPointCommand, DescribeAccessPointsCommand, EFSClient } from '@aws-sdk/client-efs';
import { SLUG } from '@kelay/contracts';
import { RemoteWorkspace } from './runtime.ts';
import type { Workspace, WorkspaceDriver } from './types.ts';

const CONTAINER = 'workspace';
const VOLUME = 'workspace';
const MOUNT_PATH = '/workspace';
const APP_TAG = 'kelay:app';
const RUNTIME_TOKEN_ENV = 'KELAY_RUNTIME_TOKEN';

export interface FargateDriverOptions {
  cluster: string;
  /** EFS file system that holds every app's working tree. */
  fileSystemId: string;
  subnets: string[];
  securityGroups: string[];
  /** Image with the SDK toolchain, the coding agent and the workspace runtime pre-baked. */
  image: string;
  executionRoleArn: string;
  /** Role of the task itself. It needs EFS client access through the access point and nothing else. */
  taskRoleArn: string;
  /**
   * Environment of the workspace container: the coding agent's model access through the LLM gateway
   * (ANTHROPIC_BASE_URL and the gateway's key for builder workspaces). Never a provider key or the caller secret.
   */
  environment?: Record<string, string>;
  cpu?: string;
  memory?: string;
  runtimePort?: number;
  previewPort?: number;
  /** How long to wait for a task to reach RUNNING, and how often to look. */
  startTimeoutMs?: number;
  pollMs?: number;
  ecs?: ECSClient;
  efs?: EFSClient;
  fetch?: typeof fetch;
}

export class FargateWorkspaceDriver implements WorkspaceDriver {
  readonly name = 'fargate';
  private readonly ecs: ECSClient;
  private readonly efs: EFSClient;
  private readonly runtimePort: number;
  private readonly previewPort: number;

  constructor(private readonly opts: FargateDriverOptions) {
    this.ecs = opts.ecs ?? new ECSClient({});
    this.efs = opts.efs ?? new EFSClient({});
    this.runtimePort = opts.runtimePort ?? 4007;
    this.previewPort = opts.previewPort ?? 3000;
  }

  private family(app: string): string {
    if (!SLUG.test(app)) throw new Error(`invalid app slug ${JSON.stringify(app)}`);
    return `kelay-workspace-${app}`;
  }

  private async findAccessPoint(app: string): Promise<string | null> {
    let NextToken: string | undefined;
    do {
      const page = await this.efs.send(new DescribeAccessPointsCommand({ FileSystemId: this.opts.fileSystemId, ...(NextToken ? { NextToken } : {}) }));
      const found = page.AccessPoints?.find((ap) => ap.Tags?.some((t) => t.Key === APP_TAG && t.Value === app) && ap.LifeCycleState !== 'deleting');
      if (found?.AccessPointId) return found.AccessPointId;
      NextToken = page.NextToken;
    } while (NextToken);
    return null;
  }

  /** The app's state outlives its tasks: it is whatever sits behind this access point. */
  async exists(app: string) {
    this.family(app);
    return (await this.findAccessPoint(app)) !== null;
  }

  private async ensureAccessPoint(app: string): Promise<string> {
    const existing = await this.findAccessPoint(app);
    if (existing) return existing;
    const created = await this.efs.send(
      new CreateAccessPointCommand({
        FileSystemId: this.opts.fileSystemId,
        // Idempotency: two opens racing for the same app get the same access point.
        ClientToken: `kelay-workspace-${app}`,
        Tags: [{ Key: APP_TAG, Value: app }, { Key: 'Name', Value: `kelay-workspace-${app}` }],
        PosixUser: { Uid: 1000, Gid: 1000 },
        RootDirectory: { Path: `/workspaces/${app}`, CreationInfo: { OwnerUid: 1000, OwnerGid: 1000, Permissions: '750' } },
      }),
    );
    if (!created.AccessPointId) throw new Error(`EFS did not return an access point for ${app}`);
    return created.AccessPointId;
  }

  private async ensureTaskDefinition(app: string, accessPointId: string): Promise<string> {
    const family = this.family(app);
    try {
      const { taskDefinition: current } = await this.ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: family }));
      const mounted = current?.volumes?.[0]?.efsVolumeConfiguration?.authorizationConfig?.accessPointId;
      const image = current?.containerDefinitions?.[0]?.image;
      if (current?.taskDefinitionArn && current.status === 'ACTIVE' && mounted === accessPointId && image === this.opts.image) return current.taskDefinitionArn;
    } catch (e) {
      // ECS answers "Unable to describe task definition" as a ClientException when the family is new.
      if ((e as { name?: string }).name !== 'ClientException') throw e;
    }
    const { taskDefinition } = await this.ecs.send(
      new RegisterTaskDefinitionCommand({
        family,
        requiresCompatibilities: ['FARGATE'],
        networkMode: 'awsvpc',
        cpu: this.opts.cpu ?? '1024',
        memory: this.opts.memory ?? '4096',
        executionRoleArn: this.opts.executionRoleArn,
        taskRoleArn: this.opts.taskRoleArn,
        runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
        containerDefinitions: [
          {
            name: CONTAINER,
            image: this.opts.image,
            essential: true,
            portMappings: [{ containerPort: this.runtimePort }, { containerPort: this.previewPort }],
            mountPoints: [{ sourceVolume: VOLUME, containerPath: MOUNT_PATH }],
            environment: [
              { name: 'KELAY_APP', value: app },
              { name: 'KELAY_WORKSPACES_ROOT', value: MOUNT_PATH },
              { name: 'PORT', value: String(this.runtimePort) },
            ],
          },
        ],
        volumes: [
          {
            name: VOLUME,
            efsVolumeConfiguration: {
              fileSystemId: this.opts.fileSystemId,
              transitEncryption: 'ENABLED',
              authorizationConfig: { accessPointId, iam: 'ENABLED' },
            },
          },
        ],
        tags: [{ key: APP_TAG, value: app }],
      }),
    );
    if (!taskDefinition?.taskDefinitionArn) throw new Error(`ECS did not register a task definition for ${app}`);
    return taskDefinition.taskDefinitionArn;
  }

  private async runningTask(app: string): Promise<Task | null> {
    const { taskArns } = await this.ecs.send(new ListTasksCommand({ cluster: this.opts.cluster, family: this.family(app), desiredStatus: 'RUNNING' }));
    if (!taskArns?.length) return null;
    const { tasks } = await this.ecs.send(new DescribeTasksCommand({ cluster: this.opts.cluster, tasks: taskArns }));
    return tasks?.find((t) => t.lastStatus !== 'STOPPED' && t.lastStatus !== 'DEPROVISIONING') ?? null;
  }

  private async waitUntilRunning(taskArn: string): Promise<Task> {
    const deadline = Date.now() + (this.opts.startTimeoutMs ?? 180_000);
    for (;;) {
      const { tasks, failures } = await this.ecs.send(new DescribeTasksCommand({ cluster: this.opts.cluster, tasks: [taskArn] }));
      const task = tasks?.[0];
      if (!task) throw new Error(`workspace task ${taskArn} is gone: ${failures?.[0]?.reason ?? 'no reason given'}`);
      if (task.lastStatus === 'RUNNING') return task;
      if (task.lastStatus === 'STOPPED' || task.lastStatus === 'DEPROVISIONING') throw new Error(`workspace task stopped while starting: ${task.stoppedReason ?? 'no reason given'}`);
      if (Date.now() > deadline) throw new Error(`workspace task ${taskArn} did not reach RUNNING in time`);
      await sleep(this.opts.pollMs ?? 3000);
    }
  }

  async open(app: string, owner: string): Promise<Workspace> {
    this.family(app);
    const accessPointId = await this.ensureAccessPoint(app);
    const taskDefinition = await this.ensureTaskDefinition(app, accessPointId);

    let task = await this.runningTask(app);
    if (!task) {
      const run = await this.ecs.send(
        new RunTaskCommand({
          cluster: this.opts.cluster,
          taskDefinition,
          launchType: 'FARGATE',
          count: 1,
          startedBy: `kelay-builder`,
          enableExecuteCommand: false,
          networkConfiguration: { awsvpcConfiguration: { subnets: this.opts.subnets, securityGroups: this.opts.securityGroups, assignPublicIp: 'DISABLED' } },
          overrides: {
            containerOverrides: [
              {
                name: CONTAINER,
                environment: [
                  ...Object.entries(this.opts.environment ?? {}).map(([name, value]) => ({ name, value })),
                  // Only this service knows it, so nothing else in the VPC can drive the workspace.
                  { name: RUNTIME_TOKEN_ENV, value: randomBytes(24).toString('hex') },
                ],
              },
            ],
          },
          tags: [{ key: APP_TAG, value: app }, { key: 'kelay:owner', value: owner.slice(0, 256) }],
        }),
      );
      task = run.tasks?.[0] ?? null;
      if (!task?.taskArn) throw new Error(`could not start a workspace task for ${app}: ${run.failures?.[0]?.reason ?? 'no task returned'}`);
    }
    const taskArn = task.taskArn!;
    const running = task.lastStatus === 'RUNNING' ? task : await this.waitUntilRunning(taskArn);

    const ip = running.attachments?.flatMap((a) => a.details ?? []).find((d) => d.name === 'privateIPv4Address')?.value;
    const token = running.overrides?.containerOverrides?.find((c) => c.name === CONTAINER)?.environment?.find((e) => e.name === RUNTIME_TOKEN_ENV)?.value;
    if (!ip || !token) throw new Error(`workspace task ${taskArn} has no private address or runtime token`);

    const workspace = new RemoteWorkspace({
      app,
      ref: taskArn,
      endpoint: `http://${ip}:${this.runtimePort}`,
      token,
      previewTarget: `http://${ip}:${this.previewPort}`,
      stop: async () => {
        await this.ecs.send(new StopTaskCommand({ cluster: this.opts.cluster, task: taskArn, reason: 'Builder workspace idle' }));
      },
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
    });
    // A task is RUNNING a moment before the runtime inside it listens.
    for (let attempt = 1; ; attempt++) {
      try {
        return await workspace.connect();
      } catch (e) {
        if (attempt >= 20) throw new Error(`the workspace runtime of ${app} did not answer: ${(e as Error).message}`);
        await sleep(this.opts.pollMs ?? 3000);
      }
    }
  }
}
