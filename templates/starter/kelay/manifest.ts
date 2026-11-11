// Platform file, do not edit. `pnpm check` prints what this app declares as JSON; the Builder validates
// it and sends it with every deploy, which is how the app database gets its tables and access rules.
import { app } from './schema.ts';
import { policy } from './policy.ts';

async function optionalGraphs(): Promise<unknown[]> {
  try {
    return [...(await import('./graphs.ts')).graphs];
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_MODULE_NOT_FOUND' && String((e as Error).message).includes('graphs')) return [];
    throw e;
  }
}

process.stdout.write(JSON.stringify({ schema: app, policy, graphs: await optionalGraphs() }));
