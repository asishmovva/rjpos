import { loadEnvironment } from '@rjpos/config';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const environment = loadEnvironment();
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const migration = spawnSync(command, ['exec', 'prisma', 'migrate', 'deploy'], {
  cwd: packageDirectory,
  env: { ...process.env, DATABASE_URL: environment.DATABASE_URL },
  shell: process.platform === 'win32',
  stdio: 'inherit',
});
if (migration.status !== 0) {
  throw new Error(`Development database migration failed with exit code ${migration.status}`);
}
