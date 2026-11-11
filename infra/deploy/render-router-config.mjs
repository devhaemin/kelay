#!/usr/bin/env node
// Renders the wrangler config that deploys the Router Worker of one env, from that env's Terraform
// outputs. Terraform creates the Worker, its KV namespace and its route; `wrangler deploy` with this
// config ships new Router code to the same Worker without a Terraform run.
//
//   terraform -chdir=infra/terraform/envs/staging output -json > infra/deploy/out/staging/tf-outputs.json
//   node infra/deploy/render-router-config.mjs --env staging --outputs infra/deploy/out/staging/tf-outputs.json \
//     --out infra/deploy/out/staging/wrangler.json
//   pnpm --filter @kelay/router exec wrangler deploy --config "$PWD/infra/deploy/out/staging/wrangler.json" --dry-run
//
// It prints to stdout unless --out is given. Without --outputs, pass --kv-namespace-id and --zone
// (and --app-host when the app domain is not the zone apex).
//
// The bindings repeat `router_vars` of infra/terraform/envs/<env>/main.tf, because a deploy replaces
// every plain-text binding; keep the two in step (they are what services/router/src/index.ts reads).
// Secrets set with `wrangler secret put` are kept.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    env: { type: 'string' },
    outputs: { type: 'string' },
    'kv-namespace-id': { type: 'string' },
    zone: { type: 'string' },
    'app-host': { type: 'string' },
    'script-name': { type: 'string' },
    region: { type: 'string', default: 'ap-northeast-2' },
    out: { type: 'string' },
  },
});

if (values.env !== 'staging' && values.env !== 'prod') fail('--env must be staging or prod');

let kvNamespaceId = values['kv-namespace-id'];
let scriptName = values['script-name'] ?? `kelay-${values.env}-router`;
let hosts;
if (values.outputs) {
  const outputs = JSON.parse(readFileSync(values.outputs, 'utf8'));
  const output = (name) => outputs[name]?.value ?? fail(`${values.outputs} has no "${name}" output; was the env applied?`);
  kvNamespaceId ??= output('routes_kv_namespace_id');
  scriptName = values['script-name'] ?? output('router_script_name');
  hosts = output('hosts');
} else {
  if (!values.zone) fail('pass --outputs <terraform output -json file>, or --kv-namespace-id and --zone');
  const host = (label) => `${label}.${values.zone}`;
  hosts = { api: host('api'), mcp: host('mcp'), app: values['app-host'] ?? values.zone };
}
if (!/^[0-9a-f]{32}$/.test(kvNamespaceId ?? '')) fail('the ROUTES KV namespace id must be 32 hex characters');

const outPath = values.out ? resolve(values.out) : undefined;
// wrangler resolves `main` against the config file. Printed to stdout, the config is meant to be saved in services/router.
const main = outPath ? relative(dirname(outPath), resolve(root, 'services/router/src/index.ts')) : 'src/index.ts';

const config = {
  name: scriptName,
  main,
  // Same as router_compatibility_date and router_compatibility_flags of the edge module.
  compatibility_date: '2026-10-01',
  compatibility_flags: ['nodejs_compat'],
  // Terraform owns the route on the app domain; the Worker is not served anywhere else.
  workers_dev: false,
  preview_urls: false,
  observability: { enabled: true, head_sampling_rate: 1 },
  kv_namespaces: [{ binding: 'ROUTES', id: kvNamespaceId }],
  vars: {
    AWS_REGION: values.region,
    MCP_ORIGIN: `https://${hosts.mcp}`,
    // Store pages (/<handle>) come from the control API's public routes.
    CONTROL_ORIGIN: `https://${hosts.api}`,
  },
};

const rendered = `${JSON.stringify(config, null, 2)}\n`;
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, rendered);
  console.error(`wrote ${outPath}`);
} else {
  process.stdout.write(rendered);
}
