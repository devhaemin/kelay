import type { DeployResources, EnvName, GraphDefinition } from '../db/schema.ts';

export type { GraphDefinition };

export interface DeployInput {
  app: string;
  env: EnvName;
  handle: string;
  /** App-wide version number (v12). */
  number: number;
  commit: string;
  artifactUrl: string;
  configVersion: string;
  graphs?: GraphDefinition[];
  /** Caller token for this app × env runtime (contract §4). The driver hands it to the runtime. */
  callerToken: string;
}

export interface DeployResult {
  lambdaVersion: string;
  resources: DeployResources;
  /** Where the driver put the caller token. Stored on the version; never the token itself. */
  callerTokenRef: string;
  /** Set only by drivers with nowhere to keep a secret: the deploy response then carries the token once. */
  callerToken?: string;
}

export interface ActivateInput {
  app: string;
  env: EnvName;
  lambdaVersion: string;
  resources: DeployResources;
}

/**
 * How a version reaches an environment. `local` only records and returns the caller token to whoever
 * runs the app; `aws` provisions Lambda and Step Functions and keeps the token in the functions' environment.
 */
export interface DeployDriver {
  readonly name: string;
  deploy(input: DeployInput): Promise<DeployResult>;
  /** Points the env's live alias at an already deployed version (publishing a prod version again, or rollback). */
  activate(input: ActivateInput): Promise<void>;
}

export class DeployError extends Error {
  constructor(
    message: string,
    readonly badInput = false,
  ) {
    super(message);
    this.name = 'DeployError';
  }
}

/** Default of the runtime Terraform module's `app_resource_prefix`, which the Deploy role's IAM is scoped to. */
export const APP_RESOURCE_PREFIX = 'kelay-app-';

export const resourcePrefix = (app: string, env: EnvName, base = APP_RESOURCE_PREFIX) => `${base}${app}-${env}`;

export class LocalDeployDriver implements DeployDriver {
  readonly name = 'local';
  readonly deployed: DeployInput[] = [];
  readonly activated: ActivateInput[] = [];

  async deploy(input: DeployInput): Promise<DeployResult> {
    this.deployed.push(input);
    return {
      lambdaVersion: `local-${input.number}`,
      resources: {},
      callerTokenRef: `local:${resourcePrefix(input.app, input.env)}`,
      callerToken: input.callerToken,
    };
  }

  async activate(input: ActivateInput): Promise<void> {
    this.activated.push(input);
  }
}
