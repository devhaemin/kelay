#!/usr/bin/env node
// Renders the Terraform var file that says which image every platform service runs and at what size:
// `image_tag` plus the `service_overrides` map of infra/terraform/envs/<env> (which becomes the
// platform module's `services` map). Sizes and counts come from services/<env>.json in this directory.
//
//   node infra/deploy/render-services.mjs --env staging --tag 3f2a9c1d0b7e
//   node infra/deploy/render-services.mjs --env staging --tag 3f2a9c1d0b7e --set identity=8c1e55aa02d4
//   node infra/deploy/render-services.mjs --env staging --tag 3f2a9c1d0b7e --out infra/deploy/out/staging/services.tfvars.json
//
// It prints to stdout unless --out is given. Pass the file to Terraform with -var-file: Terraform
// replaces a variable as a whole, so `image_tag` and `service_overrides` in terraform.tfvars no longer
// count once this file is passed, and sizing has to live in services/<env>.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));

// Keys of `service_overrides` in infra/terraform/envs/*/variables.tf, and the services of main.tf.
const OVERRIDE_KEYS = ['image', 'image_tag', 'cpu', 'memory', 'desired_count', 'autoscaling', 'spot', 'env'];
const SERVICES = ['console', 'control-api', 'identity', 'data-api', 'mcp-gateway', 'llm-gateway', 'preview-proxy', 'otel-collector'];
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    env: { type: 'string' },
    tag: { type: 'string' },
    set: { type: 'string', multiple: true, default: [] },
    out: { type: 'string' },
  },
});

if (values.env !== 'staging' && values.env !== 'prod') fail('--env must be staging or prod');
if (!values.tag || !TAG.test(values.tag)) fail('--tag must be an image tag, e.g. the git commit the images were built from');

const built = JSON.parse(readFileSync(resolve(here, 'images.json'), 'utf8')).map((image) => image.service);
const { $comment: _comment, ...sizing } = JSON.parse(readFileSync(resolve(here, 'services', `${values.env}.json`), 'utf8'));

for (const [service, override] of Object.entries(sizing)) {
  if (!SERVICES.includes(service)) fail(`services/${values.env}.json: unknown service "${service}"`);
  const unknown = Object.keys(override).filter((key) => !OVERRIDE_KEYS.includes(key));
  if (unknown.length) fail(`services/${values.env}.json: ${service} has keys Terraform does not take: ${unknown.join(', ')}`);
}

const overrides = structuredClone(sizing);
for (const pair of values.set) {
  const [service, tag, ...rest] = pair.split('=');
  if (!service || !tag || rest.length || !TAG.test(tag)) fail(`--set takes <service>=<tag>, got "${pair}"`);
  if (!built.includes(service)) fail(`--set ${service}: images.json builds no image for it (it builds: ${built.join(', ')})`);
  if (tag !== values.tag) overrides[service] = { ...overrides[service], image_tag: tag };
}

// A service runs `<ecr>/kelay-<env>/<service>:<tag>` unless it names another image. Nothing in this
// repo builds an image for the rest, so their tasks could never start; they must stay at zero.
for (const service of SERVICES) {
  const override = overrides[service] ?? {};
  if (built.includes(service) || override.image) continue;
  if (override.desired_count !== 0 || override.autoscaling) {
    fail(`${service} has no image in images.json; set "image" for it in services/${values.env}.json, or "desired_count": 0 and no "autoscaling"`);
  }
}

const rendered = `${JSON.stringify({ image_tag: values.tag, service_overrides: overrides }, null, 2)}\n`;
if (values.out) {
  const path = resolve(values.out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rendered);
  console.error(`wrote ${path}`);
} else {
  process.stdout.write(rendered);
}
