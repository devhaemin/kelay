import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  AddPermissionCommand,
  CreateAliasCommand,
  CreateFunctionCommand,
  CreateFunctionUrlConfigCommand,
  GetFunctionCommand,
  GetFunctionUrlConfigCommand,
  LambdaClient,
  PublishVersionCommand,
  ResourceNotFoundException,
  UpdateAliasCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';
import { CreateStateMachineCommand, DescribeStateMachineCommand, SFNClient, StateMachineDoesNotExist, UpdateStateMachineCommand } from '@aws-sdk/client-sfn';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { AwsDeployDriver } from '../src/deploy/aws.ts';
import { DeployError, type DeployInput } from '../src/deploy/driver.ts';
import { SqsImprovementQueue } from '../src/queue/improvement.ts';
import type { ImprovementRunRow } from '../src/db/schema.ts';
import { createHarness, seedApp } from './harness.ts';

const REGION = 'ap-northeast-2';
const ACCOUNT = '123456789012';
const fnArn = (name: string) => `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${name}`;
const notFound = () => new ResourceNotFoundException({ message: 'Function not found', $metadata: {} });

/** In-memory Lambda + Step Functions behind aws-sdk-client-mock. */
function fakeAws() {
  const lambdaClient = new LambdaClient({ region: REGION });
  const sfnClient = new SFNClient({ region: REGION });
  const lambda = mockClient(lambdaClient);
  const sfn = mockClient(sfnClient);
  const functions = new Map<string, number>();
  const aliases = new Map<string, string>();
  const urls = new Set<string>();
  const machines = new Set<string>();

  lambda.on(GetFunctionCommand).callsFake(({ FunctionName }) => {
    if (!functions.has(FunctionName)) throw notFound();
    return { Configuration: { FunctionName, FunctionArn: fnArn(FunctionName), State: 'Active', LastUpdateStatus: 'Successful' } };
  });
  lambda.on(CreateFunctionCommand).callsFake(({ FunctionName }) => {
    functions.set(FunctionName, 0);
    return { FunctionArn: fnArn(FunctionName), State: 'Pending' };
  });
  lambda.on(UpdateFunctionCodeCommand).resolves({ LastUpdateStatus: 'InProgress' });
  lambda.on(UpdateFunctionConfigurationCommand).resolves({ LastUpdateStatus: 'InProgress' });
  lambda.on(PublishVersionCommand).callsFake(({ FunctionName }) => {
    const n = (functions.get(FunctionName) ?? 0) + 1;
    functions.set(FunctionName, n);
    return { Version: String(n), FunctionArn: `${fnArn(FunctionName)}:${n}` };
  });
  lambda.on(UpdateAliasCommand).callsFake(({ FunctionName, Name, FunctionVersion }) => {
    if (!aliases.has(FunctionName)) throw notFound();
    aliases.set(FunctionName, FunctionVersion);
    return { AliasArn: `${fnArn(FunctionName)}:${Name}` };
  });
  lambda.on(CreateAliasCommand).callsFake(({ FunctionName, Name, FunctionVersion }) => {
    aliases.set(FunctionName, FunctionVersion);
    return { AliasArn: `${fnArn(FunctionName)}:${Name}` };
  });
  lambda.on(GetFunctionUrlConfigCommand).callsFake(({ FunctionName }) => {
    if (!urls.has(FunctionName)) throw notFound();
    return { FunctionUrl: `https://${FunctionName}.lambda-url.${REGION}.on.aws/`, AuthType: 'AWS_IAM' };
  });
  lambda.on(CreateFunctionUrlConfigCommand).callsFake(({ FunctionName }) => {
    urls.add(FunctionName);
    return { FunctionUrl: `https://${FunctionName}.lambda-url.${REGION}.on.aws/`, AuthType: 'AWS_IAM' };
  });
  lambda.on(AddPermissionCommand).resolves({});
  sfn.on(DescribeStateMachineCommand).callsFake(({ stateMachineArn }) => {
    if (!machines.has(stateMachineArn)) throw new StateMachineDoesNotExist({ message: 'does not exist', $metadata: {} });
    return { stateMachineArn };
  });
  // As the Deploy role sees it: updating a state machine that is not there is refused, not "missing".
  sfn.on(UpdateStateMachineCommand).callsFake(({ stateMachineArn }) => {
    if (!machines.has(stateMachineArn)) throw Object.assign(new Error('not authorized to perform states:UpdateStateMachine'), { name: 'AccessDeniedException' });
    return { updateDate: new Date() };
  });
  sfn.on(CreateStateMachineCommand).callsFake(({ name }) => {
    const arn = `arn:aws:states:${REGION}:${ACCOUNT}:stateMachine:${name}`;
    machines.add(arn);
    return { stateMachineArn: arn, creationDate: new Date() };
  });

  const driver = new AwsDeployDriver({
    platformEnv: 'staging',
    lambdaRoleArn: `arn:aws:iam::${ACCOUNT}:role/kelay-app-runtime`,
    stepFunctionsRoleArn: `arn:aws:iam::${ACCOUNT}:role/kelay-app-sfn`,
    routerPrincipal: `arn:aws:iam::${ACCOUNT}:role/kelay-router`,
    runtimeEnv: { DATA_API_URL: 'https://data.kelay.internal' },
    lambda: lambdaClient,
    sfn: sfnClient,
  });
  return { driver, lambda, sfn, aliases };
}

const input = (over: Partial<DeployInput> = {}): DeployInput => ({
  app: 'ticket-board',
  env: 'dev',
  handle: 'jeongyun',
  number: 1,
  commit: 'a1b2c3',
  artifactUrl: 's3://kelay-builds/ticket-board/a1b2c3.zip',
  configVersion: 'cfg-31',
  callerToken: 'caller.jwt',
  graphs: [{ name: 'overdue-summary', definition: '{"StartAt":"collect","States":{"collect":{"Type":"Task","Resource":"${NodeFunctionArn}","End":true}}}' }],
  ...over,
});

describe('aws deploy driver', () => {
  let aws: ReturnType<typeof fakeAws>;
  beforeEach(() => {
    aws = fakeAws();
  });

  it('creates tagged functions, a live alias, an IAM function URL and state machines on first deploy', async () => {
    const res = await aws.driver.deploy(input());
    const web = 'kelay-app-ticket-board-dev-web';
    const nodes = 'kelay-app-ticket-board-dev-nodes';
    expect(res).toEqual({
      lambdaVersion: '1',
      callerTokenRef: `lambda-env:${web}#KELAY_CALLER_TOKEN`,
      resources: {
        functionName: web,
        functionArn: `${fnArn(web)}:live`,
        functionUrl: `https://${web}.lambda-url.${REGION}.on.aws/`,
        nodeFunctionName: nodes,
        nodeLambdaVersion: '1',
        stateMachineArns: [`arn:aws:states:${REGION}:${ACCOUNT}:stateMachine:kelay-app-ticket-board-dev-overdue-summary`],
      },
    });

    const created = aws.lambda.commandCalls(CreateFunctionCommand).map((c) => c.args[0].input);
    expect(created.map((c) => c.FunctionName)).toEqual([web, nodes]);
    expect(created[0]).toMatchObject({
      Role: `arn:aws:iam::${ACCOUNT}:role/kelay-app-runtime`,
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
      Code: { S3Bucket: 'kelay-builds', S3Key: 'ticket-board/a1b2c3.zip' },
      Tags: { 'kelay:app': 'ticket-board', 'kelay:env': 'staging', 'kelay:app-env': 'dev', 'kelay:managed-by': 'kelay-deploy' },
      Environment: {
        Variables: expect.objectContaining({ KELAY_APP: 'ticket-board', KELAY_ENV: 'dev', KELAY_CONFIG_VERSION: 'cfg-31', DATA_API_URL: 'https://data.kelay.internal', KELAY_CALLER_TOKEN: 'caller.jwt' }),
      },
    });
    expect(created[1]?.Handler).toBe('nodes.handler');
    expect(aws.lambda.commandCalls(PublishVersionCommand)[0]?.args[0].input).toMatchObject({ FunctionName: web, Description: 'v1 a1b2c3' });
    expect(aws.lambda.commandCalls(CreateAliasCommand).map((c) => c.args[0].input)).toEqual([
      { FunctionName: web, Name: 'live', FunctionVersion: '1' },
      { FunctionName: nodes, Name: 'live', FunctionVersion: '1' },
    ]);
    expect(aws.lambda.commandCalls(CreateFunctionUrlConfigCommand).map((c) => c.args[0].input)).toEqual([
      { FunctionName: web, Qualifier: 'live', AuthType: 'AWS_IAM' },
    ]);
    expect(aws.lambda.commandCalls(AddPermissionCommand)[0]?.args[0].input).toMatchObject({
      FunctionName: web,
      Qualifier: 'live',
      Action: 'lambda:InvokeFunctionUrl',
      Principal: `arn:aws:iam::${ACCOUNT}:role/kelay-router`,
      FunctionUrlAuthType: 'AWS_IAM',
    });

    const machine = aws.sfn.commandCalls(CreateStateMachineCommand)[0]?.args[0].input;
    expect(machine).toMatchObject({
      name: 'kelay-app-ticket-board-dev-overdue-summary',
      roleArn: `arn:aws:iam::${ACCOUNT}:role/kelay-app-sfn`,
      type: 'EXPRESS',
      publish: true,
      tags: [
        { key: 'kelay:app', value: 'ticket-board' },
        { key: 'kelay:env', value: 'staging' },
        { key: 'kelay:app-env', value: 'dev' },
        { key: 'kelay:managed-by', value: 'kelay-deploy' },
      ],
    });
    expect(JSON.parse(machine!.definition!).States.collect.Resource).toBe(`${fnArn(nodes)}:live`);
  });

  it('updates code and config, publishes a new version and moves the alias on later deploys', async () => {
    await aws.driver.deploy(input());
    aws.lambda.resetHistory();
    aws.sfn.resetHistory();
    const res = await aws.driver.deploy(input({ number: 2, commit: 'd4e5f6', artifactUrl: 's3://kelay-builds/ticket-board/d4e5f6.zip', configVersion: 'cfg-32' }));
    expect(res.lambdaVersion).toBe('2');
    expect(aws.lambda.commandCalls(CreateFunctionCommand)).toHaveLength(0);
    expect(aws.lambda.commandCalls(UpdateFunctionCodeCommand)[0]?.args[0].input).toEqual({
      FunctionName: 'kelay-app-ticket-board-dev-web',
      S3Bucket: 'kelay-builds',
      S3Key: 'ticket-board/d4e5f6.zip',
    });
    expect(aws.lambda.commandCalls(UpdateFunctionConfigurationCommand)[0]?.args[0].input.Environment?.Variables?.KELAY_CONFIG_VERSION).toBe('cfg-32');
    expect(aws.lambda.commandCalls(UpdateAliasCommand).map((c) => c.args[0].input.FunctionVersion)).toEqual(['2', '2']);
    expect(aws.lambda.commandCalls(CreateFunctionUrlConfigCommand)).toHaveLength(0);
    expect(aws.sfn.commandCalls(UpdateStateMachineCommand)[0]?.args[0].input).toMatchObject({
      stateMachineArn: `arn:aws:states:${REGION}:${ACCOUNT}:stateMachine:kelay-app-ticket-board-dev-overdue-summary`,
      publish: true,
      versionDescription: 'v2 d4e5f6',
    });
    expect(aws.sfn.commandCalls(CreateStateMachineCommand)).toHaveLength(0);
  });

  it('activates an earlier version by moving the live aliases', async () => {
    const first = await aws.driver.deploy(input());
    await aws.driver.deploy(input({ number: 2 }));
    await aws.driver.activate({ app: 'ticket-board', env: 'dev', lambdaVersion: first.lambdaVersion, resources: first.resources });
    expect(aws.aliases.get('kelay-app-ticket-board-dev-web')).toBe('1');
    expect(aws.aliases.get('kelay-app-ticket-board-dev-nodes')).toBe('1');
  });

  it('skips the node function and state machines for apps without graphs, and rejects non-S3 artifacts', async () => {
    const res = await aws.driver.deploy(input({ graphs: [] }));
    expect(res.resources.nodeFunctionName).toBeUndefined();
    expect(aws.sfn.calls()).toHaveLength(0);
    const err = await aws.driver.deploy(input({ artifactUrl: 'https://example.com/a.zip' })).catch((e) => e);
    expect(err).toBeInstanceOf(DeployError);
    expect(err.badInput).toBe(true);
    await expect(aws.driver.deploy(input({ nodesArtifactUrl: 'file:///tmp/nodes.zip' }))).rejects.toThrow('nodesArtifactUrl must be s3://');
  });

  it('creates the node function from its own bundle when the build has one', async () => {
    const built = { artifactUrl: 's3://kelay-builds/builds/ticket-board/a1b2c3/web.zip', nodesArtifactUrl: 's3://kelay-builds/builds/ticket-board/a1b2c3/nodes.zip' };
    await aws.driver.deploy(input(built));
    const created = Object.fromEntries(aws.lambda.commandCalls(CreateFunctionCommand).map((c) => [c.args[0].input.FunctionName, c.args[0].input]));
    expect(created['kelay-app-ticket-board-dev-web']).toMatchObject({ Handler: 'index.handler', Code: { S3Bucket: 'kelay-builds', S3Key: 'builds/ticket-board/a1b2c3/web.zip' } });
    expect(created['kelay-app-ticket-board-dev-nodes']).toMatchObject({ Handler: 'nodes.handler', Code: { S3Bucket: 'kelay-builds', S3Key: 'builds/ticket-board/a1b2c3/nodes.zip' } });

    await aws.driver.deploy(input({ number: 2, artifactUrl: built.artifactUrl.replace('a1b2c3', 'd4e5f6'), nodesArtifactUrl: built.nodesArtifactUrl.replace('a1b2c3', 'd4e5f6') }));
    expect(aws.lambda.commandCalls(UpdateFunctionCodeCommand).map((c) => c.args[0].input.S3Key)).toEqual(['builds/ticket-board/d4e5f6/web.zip', 'builds/ticket-board/d4e5f6/nodes.zip']);
  });

  it('serves deploy and publish through the API with the aws driver', async () => {
    const h = await createHarness({ deploy: aws.driver });
    try {
      const builder = await seedApp(h, 'jeongyun', 'ticket-board');
      const dev = await h.req('POST', '/v1/apps/ticket-board/envs/dev/deploy', {
        token: builder,
        body: { commit: 'a1b2c3', artifactUrl: 's3://kelay-builds/ticket-board/a1b2c3.zip', configVersion: 'cfg-31', graphs: input().graphs },
      });
      expect(dev.status).toBe(201);
      expect(dev.body.version.resources.functionUrl).toContain('kelay-app-ticket-board-dev-web');
      expect(dev.body.version.nodesArtifactUrl).toBeNull();

      const bad = await h.req('POST', '/v1/apps/ticket-board/envs/dev/deploy', {
        token: builder,
        body: { commit: 'x', artifactUrl: 'https://example.com/x.zip', configVersion: 'c' },
      });
      expect(bad.status).toBe(400);

      const prod = await h.req('POST', '/v1/apps/ticket-board/publish', { token: builder, body: { versionId: dev.body.version.id } });
      expect(prod.status).toBe(200);
      expect(prod.body.version.resources).toMatchObject({
        functionName: 'kelay-app-ticket-board-prod-web',
        stateMachineArns: [`arn:aws:states:${REGION}:${ACCOUNT}:stateMachine:kelay-app-ticket-board-prod-overdue-summary`],
      });
      const prodCreate = aws.lambda.commandCalls(CreateFunctionCommand).find((c) => c.args[0].input.FunctionName === 'kelay-app-ticket-board-prod-web');
      expect(prodCreate?.args[0].input.Tags).toEqual({ 'kelay:app': 'ticket-board', 'kelay:env': 'staging', 'kelay:app-env': 'prod', 'kelay:managed-by': 'kelay-deploy' });
    } finally {
      await h.close();
    }
  });
});

describe('sqs improvement queue', () => {
  const sqsClient = new SQSClient({ region: REGION });
  const sqs = mockClient(sqsClient);
  afterAll(() => sqs.restore());

  it('sends one message per run', async () => {
    sqs.on(SendMessageCommand).resolves({ MessageId: 'm-1' });
    const queue = new SqsImprovementQueue({ queueUrl: 'https://sqs.ap-northeast-2.amazonaws.com/123456789012/kelay-improvements', client: sqsClient });
    await queue.enqueue({ id: 'run-1', proposalId: 'p-1', app: 'ticket-board' } as ImprovementRunRow);
    const sent = sqs.commandCalls(SendMessageCommand)[0]?.args[0].input;
    expect(sent?.QueueUrl).toContain('kelay-improvements');
    expect(JSON.parse(sent!.MessageBody!)).toEqual({ runId: 'run-1', proposalId: 'p-1', app: 'ticket-board' });
  });
});
