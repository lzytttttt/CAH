/** Development runner: starts the API server (tsx watch) and the Vite dev server. */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';

const children: ChildProcess[] = [];

function run(label: string, command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWindows,
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`[dev] ${label} exited with code ${code}`);
  });
  children.push(child);
  return child;
}

run('server', 'pnpm', ['exec', 'tsx', 'watch', 'apps/server/src/main.ts']);
run('web', 'pnpm', ['exec', 'vite', '--config', 'apps/web/vite.config.ts']);

function shutdown(): void {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 200);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
