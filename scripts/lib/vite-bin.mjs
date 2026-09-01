import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Resolve the version-locked Vite executable for any checkout. Linked git
// worktrees normally share main's node_modules and have no local .bin tree.
export function resolveViteBin(checkout) {
  const local = path.join(checkout, 'node_modules', '.bin', 'vite');
  if (existsSync(local)) return local;
  const result = spawnSync(
    'git',
    ['-C', checkout, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`cannot resolve the shared Vite binary for ${checkout}: ${(result.stderr || '').trim()}`);
  }
  const common = (result.stdout || '').trim();
  const shared = path.join(path.dirname(common), 'node_modules', '.bin', 'vite');
  if (!existsSync(shared)) {
    throw new Error(`Vite binary is missing at ${shared}; install dependencies in the main checkout`);
  }
  return shared;
}
