import {
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs';
import { CreateAccessPointCommand, DescribeAccessPointsCommand, EFSClient } from '@aws-sdk/client-efs';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { FargateWorkspaceDriver } from '../src/drivers/fargate.ts';
import { RUNTIME_TOKEN_HEADER } from '../src/drivers/runtime.ts';

const ecs = mockClient(ECSClient);
const efs = mockClient(EFSClient);

const TASK = 'arn:aws:ecs:ap-northeast-2:123456789012:task/kelay-workspaces/abc123';
const TASK_DEF = 'arn:aws:ecs:ap-northeast-2:123456789012:task-definition/kelay-workspace-team-board:1';
const IMAGE = '123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/kelay-workspace:1';

const runtimeCalls: { url: string; token: string | null }[] = [];
const RUNTIME_INFO = { app: 'team-board', created: true, agent: { kind: 'claude', model: 'claude-opus-5-5' }, previewing: false };
let runtimeResponse: unknown = RUNTIME_INFO;
const runtimeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  runtimeCalls.push({ url: String(input), token: new Headers(init?.headers).get(RUNTIME_TOKEN_HEADER) });
  return Response.json(runtimeResponse);
}) as typeof fetch;

const driver = () =>
  new FargateWorkspaceDriver({
    cluster: 'kelay-workspaces',
    fileSystemId: 'fs-0abc',
    subnets: ['subnet-1', 'subnet-2'],
    securityGroups: ['sg-1'],
    image: IMAGE,
    executionRoleArn: 'arn:aws:iam::123456789012:role/kelay-workspace-exec',
    taskRoleArn: 'arn:aws:iam::123456789012:role/kelay-workspace-task',
    environment: { ANTHROPIC_BASE_URL: 'https://llm.kelay.internal', ANTHROPIC_API_KEY: 'gateway-key-for-builder-workspaces' },
    pollMs: 1,
    ecs: new ECSClient({ region: 'ap-northeast-2' }),
    efs: new EFSClient({ region: 'ap-northeast-2' }),
    fetch: runtimeFetch,
  });

const running = (token: string) => ({
  taskArn: TASK,
  lastStatus: 'RUNNING',
  attachments: [{ type: 'ElasticNetworkInterface', details: [{ name: 'subnetId', value: 'subnet-1' }, { name: 'privateIPv4Address', value: '10.0.3.17' }] }],
  overrides: { containerOverrides: [{ name: 'workspace', environment: [{ name: 'KELAY_RUNTIME_TOKEN', value: token }] }] },
});

beforeEach(() => {
  ecs.reset();
  efs.reset();
  runtimeCalls.length = 0;
  runtimeResponse = RUNTIME_INFO;
});

describe('Fargate workspace driver', () => {
  it('creates the app’s access point and task definition, runs a task and connects to its runtime', async () => {
    efs.on(DescribeAccessPointsCommand).resolves({ AccessPoints: [{ AccessPointId: 'fsap-other', Tags: [{ Key: 'kelay:app', Value: 'other-app' }] }] });
    efs.on(CreateAccessPointCommand).resolves({ AccessPointId: 'fsap-team' });
    ecs.on(DescribeTaskDefinitionCommand).rejects(Object.assign(new Error('Unable to describe task definition.'), { name: 'ClientException' }));
    ecs.on(RegisterTaskDefinitionCommand).resolves({ taskDefinition: { taskDefinitionArn: TASK_DEF } });
    ecs.on(ListTasksCommand).resolves({ taskArns: [] });
    ecs.on(RunTaskCommand).callsFake((input) => ({ tasks: [{ taskArn: TASK, lastStatus: 'PROVISIONING', overrides: input.overrides }] }));
    let polls = 0;
    ecs.on(DescribeTasksCommand).callsFake(() => {
      const token = ecs.commandCalls(RunTaskCommand)[0]!.args[0].input.overrides!.containerOverrides![0]!.environment!.find((e) => e.name === 'KELAY_RUNTIME_TOKEN')!.value!;
      return { tasks: [++polls < 3 ? { taskArn: TASK, lastStatus: 'PENDING' } : running(token)] };
    });

    const d = driver();
    expect(await d.exists('team-board')).toBe(false);
    const ws = await d.open('team-board', 'jeongyun');

    expect(efs.commandCalls(CreateAccessPointCommand)[0]!.args[0].input).toMatchObject({
      FileSystemId: 'fs-0abc',
      ClientToken: 'kelay-workspace-team-board',
      RootDirectory: { Path: '/workspaces/team-board' },
      Tags: expect.arrayContaining([{ Key: 'kelay:app', Value: 'team-board' }]),
    });
    const registered = ecs.commandCalls(RegisterTaskDefinitionCommand)[0]!.args[0].input;
    // The architecture is the one the image is built for.
    expect(registered).toMatchObject({ family: 'kelay-workspace-team-board', requiresCompatibilities: ['FARGATE'], networkMode: 'awsvpc', runtimePlatform: { cpuArchitecture: 'X86_64' } });
    expect(registered.volumes).toEqual([
      { name: 'workspace', efsVolumeConfiguration: { fileSystemId: 'fs-0abc', transitEncryption: 'ENABLED', authorizationConfig: { accessPointId: 'fsap-team', iam: 'ENABLED' } } },
    ]);
    expect(registered.containerDefinitions![0]).toMatchObject({ image: IMAGE, mountPoints: [{ sourceVolume: 'workspace', containerPath: '/workspace' }] });

    const run = ecs.commandCalls(RunTaskCommand)[0]!.args[0].input;
    expect(run).toMatchObject({
      cluster: 'kelay-workspaces',
      taskDefinition: TASK_DEF,
      launchType: 'FARGATE',
      networkConfiguration: { awsvpcConfiguration: { subnets: ['subnet-1', 'subnet-2'], securityGroups: ['sg-1'], assignPublicIp: 'DISABLED' } },
      tags: expect.arrayContaining([{ key: 'kelay:app', value: 'team-board' }, { key: 'kelay:owner', value: 'jeongyun' }]),
    });
    const environment = Object.fromEntries(run.overrides!.containerOverrides![0]!.environment!.map((e) => [e.name, e.value]));
    // The agent's model access is the gateway and its key; the task gets no caller secret.
    expect(environment).toMatchObject({ ANTHROPIC_BASE_URL: 'https://llm.kelay.internal', ANTHROPIC_API_KEY: 'gateway-key-for-builder-workspaces' });
    expect(Object.keys(environment).sort()).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'KELAY_RUNTIME_TOKEN']);

    expect(polls).toBe(3);
    expect(ws).toMatchObject({ app: 'team-board', ref: TASK, created: true, agent: { kind: 'claude', model: 'claude-opus-5-5' } });
    expect(runtimeCalls).toEqual([{ url: 'http://10.0.3.17:4007/runtime/info', token: environment.KELAY_RUNTIME_TOKEN }]);
    runtimeCalls.length = 0;
    expect(ws.previewTarget()).toBeNull();
    // Once the preview runs, the proxy reaches it at the task's address; a browser never does.
    runtimeResponse = { url: 'http://localhost:3000' };
    expect(await ws.startPreview({})).toBe('http://10.0.3.17:3000');
    expect(ws.previewTarget()).toBe('http://10.0.3.17:3000');

    ecs.on(StopTaskCommand).resolves({});
    await ws.stop();
    expect(ecs.commandCalls(StopTaskCommand)[0]!.args[0].input).toMatchObject({ cluster: 'kelay-workspaces', task: TASK });
  });

  it('reuses the access point, the task definition and a task that is already running', async () => {
    efs.on(DescribeAccessPointsCommand)
      .resolvesOnce({ AccessPoints: [], NextToken: 'page-2' })
      .resolves({ AccessPoints: [{ AccessPointId: 'fsap-team', Tags: [{ Key: 'kelay:app', Value: 'team-board' }] }] });
    ecs.on(DescribeTaskDefinitionCommand).resolves({
      taskDefinition: {
        taskDefinitionArn: TASK_DEF,
        status: 'ACTIVE',
        runtimePlatform: { cpuArchitecture: 'X86_64' },
        containerDefinitions: [{ image: IMAGE }],
        volumes: [{ efsVolumeConfiguration: { fileSystemId: 'fs-0abc', authorizationConfig: { accessPointId: 'fsap-team' } } }],
      },
    });
    ecs.on(ListTasksCommand).resolves({ taskArns: [TASK] });
    ecs.on(DescribeTasksCommand).resolves({ tasks: [running('known-token')] });

    const d = driver();
    const ws = await d.open('team-board', 'jeongyun');

    expect(efs.commandCalls(DescribeAccessPointsCommand)).toHaveLength(2);
    expect(efs.commandCalls(CreateAccessPointCommand)).toHaveLength(0);
    expect(ecs.commandCalls(RegisterTaskDefinitionCommand)).toHaveLength(0);
    expect(ecs.commandCalls(RunTaskCommand)).toHaveLength(0);
    expect(ecs.commandCalls(ListTasksCommand)[0]!.args[0].input).toEqual({ cluster: 'kelay-workspaces', family: 'kelay-workspace-team-board', desiredStatus: 'RUNNING' });
    expect(ws.ref).toBe(TASK);
    expect(runtimeCalls[0]).toEqual({ url: 'http://10.0.3.17:4007/runtime/info', token: 'known-token' });
    expect(await d.exists('team-board')).toBe(true);
  });

  it('registers a new revision when the image changed', async () => {
    efs.on(DescribeAccessPointsCommand).resolves({ AccessPoints: [{ AccessPointId: 'fsap-team', Tags: [{ Key: 'kelay:app', Value: 'team-board' }] }] });
    ecs.on(DescribeTaskDefinitionCommand).resolves({
      taskDefinition: { taskDefinitionArn: TASK_DEF, status: 'ACTIVE', runtimePlatform: { cpuArchitecture: 'X86_64' }, containerDefinitions: [{ image: 'old-image' }], volumes: [{ efsVolumeConfiguration: { fileSystemId: 'fs-0abc', authorizationConfig: { accessPointId: 'fsap-team' } } }] },
    });
    ecs.on(RegisterTaskDefinitionCommand).resolves({ taskDefinition: { taskDefinitionArn: TASK_DEF.replace(':1', ':2') } });
    ecs.on(ListTasksCommand).resolves({});
    ecs.on(RunTaskCommand).resolves({ tasks: [running('t')] });

    await driver().open('team-board', 'jeongyun');
    expect(ecs.commandCalls(RunTaskCommand)[0]!.args[0].input.taskDefinition).toBe(TASK_DEF.replace(':1', ':2'));
  });

  it('names families, logs and sizes the way the env’s Terraform expects', async () => {
    efs.on(DescribeAccessPointsCommand).resolves({ AccessPoints: [{ AccessPointId: 'fsap-team', Tags: [{ Key: 'kelay:app', Value: 'team-board' }] }] });
    ecs.on(DescribeTaskDefinitionCommand).rejects(Object.assign(new Error('nope'), { name: 'ClientException' }));
    ecs.on(RegisterTaskDefinitionCommand).resolves({ taskDefinition: { taskDefinitionArn: TASK_DEF } });
    ecs.on(ListTasksCommand).resolves({});
    ecs.on(RunTaskCommand).resolves({ tasks: [running('t')] });

    const d = new FargateWorkspaceDriver({
      cluster: 'kelay-staging-sandboxes',
      fileSystemId: 'fs-0abc',
      subnets: ['subnet-1'],
      securityGroups: ['sg-1'],
      image: IMAGE,
      executionRoleArn: 'arn:aws:iam::123456789012:role/kelay-staging-sandbox-exec',
      taskRoleArn: 'arn:aws:iam::123456789012:role/kelay-staging-sandbox-task',
      // The launcher policy allows RunTask on task-definition/kelay-staging-workspace*.
      familyPrefix: 'kelay-staging-workspace',
      cpuArchitecture: 'ARM64',
      logGroup: '/kelay/staging/sandboxes',
      region: 'ap-northeast-2',
      cpu: '2048',
      memory: '8192',
      pollMs: 1,
      ecs: new ECSClient({ region: 'ap-northeast-2' }),
      efs: new EFSClient({ region: 'ap-northeast-2' }),
      fetch: runtimeFetch,
    });
    await d.open('team-board', 'jeongyun');
    const registered = ecs.commandCalls(RegisterTaskDefinitionCommand)[0]!.args[0].input;
    expect(registered).toMatchObject({ family: 'kelay-staging-workspace-team-board', cpu: '2048', memory: '8192', runtimePlatform: { cpuArchitecture: 'ARM64' } });
    expect(registered.containerDefinitions![0]).toMatchObject({
      portMappings: [{ containerPort: 4007 }, { containerPort: 3000 }],
      linuxParameters: { initProcessEnabled: true },
      logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': '/kelay/staging/sandboxes', 'awslogs-region': 'ap-northeast-2', 'awslogs-stream-prefix': 'workspace' } },
    });
    expect(ecs.commandCalls(ListTasksCommand)[0]!.args[0].input.family).toBe('kelay-staging-workspace-team-board');
  });

  it('fails with the reason when ECS cannot place or keep the task', async () => {
    efs.on(DescribeAccessPointsCommand).resolves({ AccessPoints: [{ AccessPointId: 'fsap-team', Tags: [{ Key: 'kelay:app', Value: 'team-board' }] }] });
    ecs.on(DescribeTaskDefinitionCommand).rejects(Object.assign(new Error('nope'), { name: 'ClientException' }));
    ecs.on(RegisterTaskDefinitionCommand).resolves({ taskDefinition: { taskDefinitionArn: TASK_DEF } });
    ecs.on(ListTasksCommand).resolves({});
    ecs.on(RunTaskCommand).resolvesOnce({ tasks: [], failures: [{ reason: 'RESOURCE:ENI' }] }).resolves({ tasks: [{ taskArn: TASK, lastStatus: 'PROVISIONING' }] });
    ecs.on(DescribeTasksCommand).resolves({ tasks: [{ taskArn: TASK, lastStatus: 'STOPPED', stoppedReason: 'CannotPullContainerError' }] });

    await expect(driver().open('team-board', 'jeongyun')).rejects.toThrow('RESOURCE:ENI');
    await expect(driver().open('team-board', 'jeongyun')).rejects.toThrow('CannotPullContainerError');
    await expect(driver().open('Not A Slug', 'jeongyun')).rejects.toThrow('invalid app slug');
  });
});
