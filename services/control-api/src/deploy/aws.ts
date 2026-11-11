// Deploys an app × env onto AWS Lambda (web + agent nodes) and Step Functions (one state machine per graph).
// Resources are named kelay-app-<app>-<env>-* and tagged kelay:app / kelay:env. Function URLs use AWS_IAM auth:
// only the Router Worker, signing with SigV4, may call them.
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
  waitUntilFunctionActiveV2,
  waitUntilFunctionUpdatedV2,
  type Runtime,
} from '@aws-sdk/client-lambda';
import { CreateStateMachineCommand, SFNClient, StateMachineDoesNotExist, UpdateStateMachineCommand } from '@aws-sdk/client-sfn';
import type { DeployResources } from '../db/schema.ts';
import { DeployError, resourcePrefix, type ActivateInput, type DeployDriver, type DeployInput, type DeployResult } from './driver.ts';

export const LIVE_ALIAS = 'live';
export const NODE_ARN_PLACEHOLDER = '${NodeFunctionArn}';

export interface AwsDeployOptions {
  /** Execution role for app functions: logs only (docs/infrastructure.md §3). */
  lambdaRoleArn: string;
  /** Role Step Functions assumes to invoke the node function. */
  stepFunctionsRoleArn: string;
  /** Principal allowed to call function URLs (the Router Worker's IAM identity). */
  routerPrincipal?: string;
  runtime?: Runtime;
  webHandler?: string;
  nodeHandler?: string;
  memorySize?: number;
  timeoutSeconds?: number;
  /** Extra environment for every app function, e.g. platform service URLs. Never secrets. */
  runtimeEnv?: Record<string, string>;
  lambda?: LambdaClient;
  sfn?: SFNClient;
  region?: string;
  /** Upper bound for each wait on a function update, in seconds. */
  maxWaitSeconds?: number;
}

const isNotFound = (e: unknown) => e instanceof ResourceNotFoundException || (e as Error)?.name === 'ResourceNotFoundException';

function parseS3(url: string): { S3Bucket: string; S3Key: string } {
  const m = url.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!m?.[1] || !m[2]) throw new DeployError('artifactUrl must be s3://<bucket>/<key> for the aws driver', true);
  return { S3Bucket: m[1], S3Key: m[2] };
}

export class AwsDeployDriver implements DeployDriver {
  readonly name = 'aws';
  private readonly lambda: LambdaClient;
  private readonly sfn: SFNClient;

  constructor(private readonly opts: AwsDeployOptions) {
    const region = opts.region ? { region: opts.region } : {};
    this.lambda = opts.lambda ?? new LambdaClient(region);
    this.sfn = opts.sfn ?? new SFNClient(region);
  }

  async deploy(input: DeployInput): Promise<DeployResult> {
    const code = parseS3(input.artifactUrl);
    const prefix = resourcePrefix(input.app, input.env);
    const tags = { 'kelay:app': input.app, 'kelay:env': input.env };
    const environment = {
      ...this.opts.runtimeEnv,
      KELAY_APP: input.app,
      KELAY_ENV: input.env,
      KELAY_HANDLE: input.handle,
      KELAY_VERSION: String(input.number),
      KELAY_COMMIT: input.commit,
      KELAY_CONFIG_VERSION: input.configVersion,
    };
    const description = `v${input.number} ${input.commit}`.slice(0, 256);

    const web = await this.release(`${prefix}-web`, this.opts.webHandler ?? 'index.handler', code, environment, tags, description);
    const url = await this.ensureFunctionUrl(`${prefix}-web`);
    const resources: DeployResources = { functionName: `${prefix}-web`, functionArn: web.aliasArn, functionUrl: url };

    const graphs = input.graphs ?? [];
    if (graphs.length > 0) {
      const nodes = await this.release(`${prefix}-nodes`, this.opts.nodeHandler ?? 'nodes.handler', code, environment, tags, description);
      resources.nodeFunctionName = `${prefix}-nodes`;
      resources.nodeLambdaVersion = nodes.version;
      resources.stateMachineArns = [];
      for (const g of graphs) {
        const definition = g.definition.split(NODE_ARN_PLACEHOLDER).join(nodes.aliasArn);
        resources.stateMachineArns.push(await this.ensureStateMachine(`${prefix}-${g.name}`, definition, g.type ?? 'EXPRESS', web.aliasArn, tags, description));
      }
    }
    return { lambdaVersion: web.version, resources };
  }

  async activate(input: ActivateInput): Promise<void> {
    const prefix = resourcePrefix(input.app, input.env);
    await this.pointAlias(input.resources.functionName ?? `${prefix}-web`, input.lambdaVersion);
    if (input.resources.nodeFunctionName && input.resources.nodeLambdaVersion) {
      await this.pointAlias(input.resources.nodeFunctionName, input.resources.nodeLambdaVersion);
    }
  }

  /** Creates or updates a function, publishes a version and moves the live alias to it. */
  private async release(
    name: string,
    handler: string,
    code: { S3Bucket: string; S3Key: string },
    variables: Record<string, string>,
    tags: Record<string, string>,
    description: string,
  ): Promise<{ version: string; aliasArn: string }> {
    const waiter = { client: this.lambda, maxWaitTime: this.opts.maxWaitSeconds ?? 300, minDelay: 1, maxDelay: 5 };
    if (await this.exists(name)) {
      await this.lambda.send(new UpdateFunctionCodeCommand({ FunctionName: name, ...code }));
      await waitUntilFunctionUpdatedV2(waiter, { FunctionName: name });
      await this.lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: name, Handler: handler, Environment: { Variables: variables } }));
      await waitUntilFunctionUpdatedV2(waiter, { FunctionName: name });
    } else {
      await this.lambda.send(
        new CreateFunctionCommand({
          FunctionName: name,
          Role: this.opts.lambdaRoleArn,
          Runtime: this.opts.runtime ?? 'nodejs22.x',
          Handler: handler,
          Architectures: ['arm64'],
          MemorySize: this.opts.memorySize ?? 1024,
          Timeout: this.opts.timeoutSeconds ?? 30,
          Code: code,
          Environment: { Variables: variables },
          Tags: tags,
        }),
      );
      await waitUntilFunctionActiveV2(waiter, { FunctionName: name });
    }
    const published = await this.lambda.send(new PublishVersionCommand({ FunctionName: name, Description: description }));
    if (!published.Version) throw new DeployError(`PublishVersion returned no version for ${name}`);
    const aliasArn = await this.pointAlias(name, published.Version);
    return { version: published.Version, aliasArn };
  }

  private async exists(name: string): Promise<boolean> {
    try {
      await this.lambda.send(new GetFunctionCommand({ FunctionName: name }));
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }

  private async pointAlias(name: string, version: string): Promise<string> {
    try {
      const res = await this.lambda.send(new UpdateAliasCommand({ FunctionName: name, Name: LIVE_ALIAS, FunctionVersion: version }));
      return res.AliasArn ?? '';
    } catch (e) {
      if (!isNotFound(e)) throw e;
      const res = await this.lambda.send(new CreateAliasCommand({ FunctionName: name, Name: LIVE_ALIAS, FunctionVersion: version }));
      return res.AliasArn ?? '';
    }
  }

  private async ensureFunctionUrl(name: string): Promise<string> {
    try {
      const res = await this.lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: name, Qualifier: LIVE_ALIAS }));
      return res.FunctionUrl ?? '';
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    const res = await this.lambda.send(
      new CreateFunctionUrlConfigCommand({ FunctionName: name, Qualifier: LIVE_ALIAS, AuthType: 'AWS_IAM' }),
    );
    if (this.opts.routerPrincipal) {
      await this.lambda.send(
        new AddPermissionCommand({
          FunctionName: name,
          Qualifier: LIVE_ALIAS,
          StatementId: 'kelay-router-invoke-url',
          Action: 'lambda:InvokeFunctionUrl',
          Principal: this.opts.routerPrincipal,
          FunctionUrlAuthType: 'AWS_IAM',
        }),
      );
    }
    return res.FunctionUrl ?? '';
  }

  private async ensureStateMachine(
    name: string,
    definition: string,
    type: 'EXPRESS' | 'STANDARD',
    anyFunctionArn: string,
    tags: Record<string, string>,
    description: string,
  ): Promise<string> {
    // arn:aws:lambda:<region>:<account>:function:<name>[:alias]
    const [, , , region, account] = anyFunctionArn.split(':');
    if (!region || !account) throw new DeployError(`cannot derive region and account from ${anyFunctionArn}`);
    const arn = `arn:aws:states:${region}:${account}:stateMachine:${name}`;
    try {
      await this.sfn.send(
        new UpdateStateMachineCommand({
          stateMachineArn: arn,
          definition,
          roleArn: this.opts.stepFunctionsRoleArn,
          publish: true,
          versionDescription: description,
        }),
      );
      return arn;
    } catch (e) {
      if (!(e instanceof StateMachineDoesNotExist || (e as Error)?.name === 'StateMachineDoesNotExist')) throw e;
    }
    const res = await this.sfn.send(
      new CreateStateMachineCommand({
        name,
        definition,
        roleArn: this.opts.stepFunctionsRoleArn,
        type,
        publish: true,
        versionDescription: description,
        tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
      }),
    );
    return res.stateMachineArn ?? arn;
  }
}
