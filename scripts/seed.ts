// `pnpm seed`: migrate, then seed the Ticket Board scenario. Needs Postgres only (`pnpm db:up`); idempotent.
import { loadConfig } from './lib/config.ts';
import { migrate } from './lib/migrate.ts';
import { seed } from './lib/seed.ts';

const cfg = loadConfig();
await migrate(cfg);
await seed(cfg, (line) => console.log(line));
