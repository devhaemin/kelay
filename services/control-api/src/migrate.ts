import { createDatabase, runMigrations } from './db/client.ts';
import { createLogger } from './log.ts';

const log = createLogger();
const url = process.env.CONTROL_DATABASE_URL;
if (!url) {
  log.fatal('CONTROL_DATABASE_URL is required');
  process.exit(1);
}
const database = createDatabase(url, { max: 1 });
try {
  await runMigrations(database.db);
  log.info({ type: 'migrate' }, 'migrations applied');
} catch (e) {
  log.fatal({ err: e }, 'migration failed');
  process.exitCode = 1;
} finally {
  await database.close();
}
