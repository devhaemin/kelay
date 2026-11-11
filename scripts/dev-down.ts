// `pnpm dev:down`: stops a running `pnpm dev:up` and the Postgres container. Data stays in the
// compose volume; `pnpm dev:down --volumes` removes it too. Extra arguments go to `docker compose down`.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { execa } from 'execa';
import { ROOT } from './lib/config.ts';
import { PID_FILE } from './lib/pid.ts';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

if (existsSync(PID_FILE)) {
  const pid = Number(readFileSync(PID_FILE, 'utf8'));
  if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
    console.log(`Stopping services (pid ${pid})`);
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 100 && alive(pid); i++) await sleep(100);
  }
  rmSync(PID_FILE, { force: true });
}

await execa('docker', ['compose', 'down', ...process.argv.slice(2)], { cwd: ROOT, stdio: 'inherit' });
