// `pnpm dev:up`: Postgres, migrations, seed, then every service plus the console on real data.
// With ANTHROPIC_API_KEY set it also starts the LLM gateway (LiteLLM); without it the stack runs
// with no gateway, and whatever needs a model says so.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execa } from 'execa';
import { COMPOSE_FILES, ROOT, loadConfig } from './lib/config.ts';
import { BUILDER, HANDLE, PASSWORD, TEAM } from './lib/data.ts';
import { migrate } from './lib/migrate.ts';
import { PID_FILE } from './lib/pid.ts';
import { seed } from './lib/seed.ts';
import { startStack } from './lib/services.ts';

const cfg = loadConfig();
const step = (text: string) => console.log(`\n▸ ${text}`);

step('Postgres (docker compose)');
await execa('docker', ['compose', 'up', '-d', '--wait', 'postgres'], { cwd: ROOT, stdio: 'inherit' });

step('Migrations: control DB, Kelay ID, ticket-board app DB');
await migrate(cfg);

step('Seed');
await seed(cfg, (line) => console.log(`  ${line}`));

if (cfg.startLlmGateway) {
  step('LLM gateway (LiteLLM, docker compose)');
  await execa('docker', ['compose', ...COMPOSE_FILES, 'up', '-d', '--wait', 'litellm'], { cwd: ROOT, stdio: 'inherit' });
}

step('Services');
const stack = await startStack(cfg, { watch: true, console: true, builder: true });
mkdirSync(dirname(PID_FILE), { recursive: true });
writeFileSync(PID_FILE, String(process.pid));

const health = (await fetch(`${cfg.builderUrl}/healthz`).then((r) => r.json()).catch(() => null)) as { agent?: { kind: string; model: string | null } } | null;
const builderAgent =
  health?.agent?.kind === 'claude' ? `Claude (${health.agent.model})` : 'scripted Ticket Board demo; set ANTHROPIC_API_KEY in .env to build from the prompt with Claude';

console.log(`
Kelay is running on local data.

  Console        ${cfg.consoleUrl}   sign in with Kelay ID; ${cfg.devLoginUrl}/ signs you in as the seeded builder
  Kelay ID       ${cfg.issuer}
  Data API       ${cfg.dataApiUrl}
  Control API    ${cfg.controlApiUrl}
  MCP gateway    ${cfg.mcpPublicBaseUrl}/${HANDLE}/ticket-board/mcp
  Runner         ${cfg.runnerUrl}
  LLM gateway    ${
    cfg.llmGatewayUrl
      ? `${cfg.llmGatewayUrl}${cfg.startLlmGateway ? ' (LiteLLM, started here)' : ''}`
      : 'not configured: set ANTHROPIC_API_KEY in .env to start it. Until then triage, reports and agent nodes that call a model fail with "LLM gateway not configured".'
  }
  Builder        ${cfg.builderUrl}   coding agent: ${builderAgent}

  Builder        ${BUILDER.email}
  Team           ${TEAM.map((p) => `${p.email} (${p.role})`).join(', ')}
  Password       ${PASSWORD}

Ctrl-C stops the services; \`pnpm dev:down\` also stops Postgres.
`);

try {
  await stack.done;
} finally {
  rmSync(PID_FILE, { force: true });
}
