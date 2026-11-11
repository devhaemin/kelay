// Entry of the workspace image (the Fargate task): one app's workspace on the EFS mount, served to the
// Builder service over the runtime protocol. It holds the gateway key for the coding agent and nothing else.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { selectAgent } from './agents/select.ts';
import { LocalWorkspaceDriver, nextDevPreview } from './drivers/local.ts';
import { createRuntimeApp } from './drivers/runtime.ts';

const env = process.env;
const need = (name: string): string => {
  const v = env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};

const root = resolve(need('KELAY_WORKSPACES_ROOT'));
const app = need('KELAY_APP');
const driver = new LocalWorkspaceDriver({
  root: resolve(root, 'repo'),
  templateDir: resolve(env.KELAY_TEMPLATE_DIR ?? fileURLToPath(new URL('../../../templates/starter', import.meta.url))),
  agent: selectAgent(env, resolve(root, 'agent-home')),
  preview: nextDevPreview(Number(env.KELAY_PREVIEW_PORT ?? 3000)),
});
const workspace = await driver.open(app, 'runtime');

const server = serve({ fetch: createRuntimeApp(workspace, need('KELAY_RUNTIME_TOKEN')).fetch, port: Number(env.PORT ?? 4007) }, (info) => {
  console.log(JSON.stringify({ type: 'listen', service: 'builder-runtime', app, port: info.port, agent: workspace.agent }));
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close();
    void workspace.stop().finally(() => process.exit(0));
  });
}
