// Where built app bundles go before a deploy. The Control API's `aws` deploy driver creates the app's
// Lambda functions from `s3://<artifacts bucket>/builds/…` (infra/terraform/modules/runtime), so a
// deployed Builder uses `s3`; `local` keeps them in a folder for runs without an AWS account.
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface ArtifactStore {
  readonly name: 'local' | 's3';
  /** Stores the file under `key` and returns the URL a deploy names it by. Storing a key again replaces it. */
  put(key: string, file: string): Promise<string>;
}

const KEY = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

function checkKey(key: string): string {
  if (!KEY.test(key) || key.split('/').some((part) => part === '.' || part === '..')) throw new Error(`invalid artifact key ${JSON.stringify(key)}`);
  return key;
}

/** `builds/<app>/<commit>/<name>`: the prefix the Deploy role may read and the Builder may write. */
export const artifactKey = (app: string, commit: string, name: string) => `builds/${app}/${commit}/${name}`;

export class LocalArtifactStore implements ArtifactStore {
  readonly name = 'local';
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(key: string, file: string): Promise<string> {
    const target = join(this.root, ...checkKey(key).split('/'));
    if (!target.startsWith(this.root + sep)) throw new Error(`invalid artifact key ${JSON.stringify(key)}`);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(file, target);
    return pathToFileURL(target).toString();
  }
}

export interface S3ArtifactStoreOptions {
  bucket: string;
  region?: string;
  client?: S3Client;
}

export class S3ArtifactStore implements ArtifactStore {
  readonly name = 's3';
  private readonly client: S3Client;

  constructor(private readonly opts: S3ArtifactStoreOptions) {
    this.client = opts.client ?? new S3Client(opts.region ? { region: opts.region } : {});
  }

  async put(key: string, file: string): Promise<string> {
    checkKey(key);
    // A stream needs its length up front: S3 does not accept a chunked body without one.
    const { size } = await stat(file);
    await this.client.send(new PutObjectCommand({ Bucket: this.opts.bucket, Key: key, Body: createReadStream(file), ContentLength: size, ContentType: 'application/zip' }));
    return `s3://${this.opts.bucket}/${key}`;
  }
}

export interface ArtifactStoreEnv {
  BUILDER_ARTIFACT_STORE?: string | undefined;
  BUILDER_ARTIFACTS_DIR?: string | undefined;
  BUILDER_ARTIFACTS_BUCKET?: string | undefined;
  AWS_REGION?: string | undefined;
}

/**
 * `BUILDER_ARTIFACT_STORE=local|s3`. Unset means the Builder builds no bundles and deploys name the
 * workspace commit instead, which only the Control API's `local` deploy driver accepts.
 */
export function artifactStoreFromEnv(env: ArtifactStoreEnv, defaultDir: string): ArtifactStore | null {
  const kind = env.BUILDER_ARTIFACT_STORE?.trim();
  if (!kind) return null;
  if (kind === 'local') return new LocalArtifactStore(env.BUILDER_ARTIFACTS_DIR || defaultDir);
  if (kind === 's3') {
    if (!env.BUILDER_ARTIFACTS_BUCKET) throw new Error('BUILDER_ARTIFACT_STORE=s3 needs BUILDER_ARTIFACTS_BUCKET');
    return new S3ArtifactStore({ bucket: env.BUILDER_ARTIFACTS_BUCKET, ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}) });
  }
  throw new Error(`BUILDER_ARTIFACT_STORE must be local or s3, got ${JSON.stringify(kind)}`);
}
