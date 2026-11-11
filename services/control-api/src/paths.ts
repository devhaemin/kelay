import { fileURLToPath } from 'node:url';

// This file sits one level below the package root both as src/paths.ts and when bundled into dist/*.js,
// so `../migrations` resolves to the committed migrations in either layout.
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
