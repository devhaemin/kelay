// Loads the MVP app registry file (contract §6). Paths in the file are relative to the file itself.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { AppRegistry, AppSchema, AppSlug, PolicyMatrix } from './index.ts';

const FileEntry = z.object({
  handle: AppSlug,
  databaseUrl: z.string(),
  schema: AppSchema.optional(),
  schemaFile: z.string().optional(),
  policy: PolicyMatrix.optional(),
  policyFile: z.string().optional(),
});
const RegistryFile = z.object({ apps: z.record(AppSlug, FileEntry) });

export function loadAppRegistry(path: string): AppRegistry {
  const base = dirname(resolve(path));
  const raw = RegistryFile.parse(JSON.parse(readFileSync(path, 'utf8')));
  const readJson = (p: string): unknown => JSON.parse(readFileSync(resolve(base, p), 'utf8'));
  const apps: AppRegistry['apps'] = {};
  for (const [slug, e] of Object.entries(raw.apps)) {
    const schema = e.schema ?? (e.schemaFile ? AppSchema.parse(readJson(e.schemaFile)) : undefined);
    if (!schema) throw new Error(`registry: app ${slug} has neither schema nor schemaFile`);
    if (schema.app !== slug) throw new Error(`registry: app ${slug} schema declares app ${schema.app}`);
    const policy = e.policy ?? (e.policyFile ? PolicyMatrix.parse(readJson(e.policyFile)) : undefined);
    apps[slug] = { handle: e.handle, databaseUrl: e.databaseUrl, schema, ...(policy ? { policy } : {}) };
  }
  return AppRegistry.parse({ apps });
}
