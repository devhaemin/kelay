import { resolve } from 'node:path';
import { ROOT } from './config.ts';

/** Written by `pnpm dev:up` so `pnpm dev:down` can stop it from another terminal. */
export const PID_FILE = resolve(ROOT, 'node_modules/.cache/kelay/dev-up.pid');
