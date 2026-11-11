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
}

export interface DeployResult {
  lambdaVersion: string;
  resources: DeployResources;
}

export interface ActivateInput {
  app: string;
  env: EnvName;
  lambdaVersion: string;
  resources: DeployResources;
}

/** How a version reaches an environment. `local` only records; `aws` provisions Lambda and Step Functions. */
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

export const resourcePrefix = (app: string, env: EnvName) => `kelay-app-${app}-${env}`;

export class LocalDeployDriver implements DeployDriver {
  readonly name = 'local';
  readonly deployed: DeployInput[] = [];
  readonly activated: ActivateInput[] = [];

  async deploy(input: DeployInput): Promise<DeployResult> {
    this.deployed.push(input);
    return { lambdaVersion: `local-${input.number}`, resources: {} };
  }

  async activate(input: ActivateInput): Promise<void> {
    this.activated.push(input);
  }
}
