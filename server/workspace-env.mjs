// One environment → filesystem contract for every local Dash surface. `main`
// means the primary checkout; an issue id means its isolated worktree. Keep the
// resolution here so terminals, app previews, and code review cannot disagree
// about which checkout an issue owns.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const MAIN_ENV = 'main';

export function resolveMainRepo() {
  if (process.env.LAB_MAIN_REPO) return path.resolve(process.env.LAB_MAIN_REPO);
  const checkout = path.resolve(HERE, '..', '..');
  const result = spawnSync(
    'git',
    ['-C', checkout, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8' },
  );
  const common = (result.stdout || '').trim();
  return common ? path.dirname(common) : checkout;
}

export const MAIN_REPO = resolveMainRepo();

function validIssueId(issueId) {
  return typeof issueId === 'string'
    && issueId !== '.'
    && issueId !== '..'
    && /^[A-Za-z0-9._-]+$/.test(issueId);
}

export function worktreeDir(issueId) {
  return validIssueId(issueId)
    ? path.join(MAIN_REPO, '.claude', 'worktrees', issueId)
    : null;
}

export function resolveWorktreeDir(issueId) {
  const candidate = worktreeDir(issueId);
  if (!candidate) return null;
  try { return fs.statSync(candidate).isDirectory() ? candidate : null; } catch { return null; }
}

function worktreeRecords() {
  const result = spawnSync(
    'git',
    ['-C', MAIN_REPO, 'worktree', 'list', '--porcelain'],
    { encoding: 'utf8' },
  );
  return (result.stdout || '').trim().split(/\n\n+/).filter(Boolean);
}

function parseWorktreeRecord(record) {
  const lines = record.split('\n');
  const dir = lines.find((line) => line.startsWith('worktree '))?.slice(9);
  const branch = lines.find((line) => line.startsWith('branch refs/heads/'))?.slice(18);
  return { dir, branch };
}

export function resolveRecordedWorktree(branches = []) {
  const wanted = new Set(branches);
  if (wanted.size === 0) return null;
  const match = worktreeRecords().map(parseWorktreeRecord)
    .find(({ branch }) => wanted.has(branch));
  return match?.dir ?? null;
}

export function resolveIssueWorktree(issueId, branches = []) {
  return resolveWorktreeDir(issueId) ?? resolveRecordedWorktree(branches);
}

export function workspaceDirForEnv(env) {
  return env === MAIN_ENV ? MAIN_REPO : resolveWorktreeDir(env);
}
