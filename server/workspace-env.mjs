// One environment → filesystem contract for every local Dash surface. `main`
// means the primary checkout; an issue id means its isolated worktree. Keep the
// resolution here so terminals, app previews, and code review cannot disagree
// about which checkout an issue owns.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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

// A stable short id for THIS checkout's repo root — sha1 of the main-repo path.
// Every clone on a machine has a distinct value, and the root dash plus all of
// its worktree dashes share ONE value (they resolve the same git common dir),
// which is exactly the scope of "per clone, across its worktrees". It namespaces
// the machine-local per-clone state that must not cross-pollinate between clones:
// the main-chats list (main-chats-store) and the mirror-sweep lease.
export function repoKey() {
  return crypto.createHash('sha1').update(MAIN_REPO).digest('hex').slice(0, 12);
}

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
  return parseWorktreeList(result.stdout || '');
}

// `git worktree list --porcelain` → [{ dir, branch }]. Parsing lives here, one
// copy, because the reaper reads the same output over an ASYNC git: this runs on
// its five-minute sweep inside the dash's single event loop, where a spawnSync
// over dozens of worktrees is the terminal-typing-freeze pattern all over again
// (dash/no-sync-ps.test.mjs). Sync stays legal only on the one-shot request
// paths below.
export function parseWorktreeList(stdout) {
  return stdout.trim().split(/\n\n+/).filter(Boolean).map((record) => {
    const lines = record.split('\n');
    return {
      dir: lines.find((line) => line.startsWith('worktree '))?.slice(9),
      branch: lines.find((line) => line.startsWith('branch refs/heads/'))?.slice(18),
    };
  });
}

export function resolveRecordedWorktree(branches = []) {
  const wanted = new Set(branches);
  if (wanted.size === 0) return null;
  const match = worktreeRecords().find(({ branch }) => wanted.has(branch));
  return match?.dir ?? null;
}

export function resolveIssueWorktree(issueId, branches = []) {
  return resolveWorktreeDir(issueId) ?? resolveRecordedWorktree(branches);
}

export function workspaceDirForEnv(env) {
  return env === MAIN_ENV ? MAIN_REPO : resolveWorktreeDir(env);
}

// Map every workspace FOLDER name to the canonical issue it belongs to. A
// worktree named for its issue maps id→id; one named for a branch maps branch→id
// (first row that lists the branch wins); MAIN_ENV maps to itself. This is the
// one resolution that anything reading a folder against the board must do first,
// because `workspaceForDir` hands back the folder name while the board keys by
// issue id — the mirror sweep places Cursor chats with it, the reaper decides its
// own stand-down with it, and issueChats derives an issue's Cursor chats with it,
// off the SAME model rather than three drifting copies.
export function workspaceIssueMap(rows) {
  const map = new Map([[MAIN_ENV, MAIN_ENV]]);
  for (const row of rows || []) {
    map.set(row.id, row.id);
    for (const b of row.branches || []) if (!map.has(b)) map.set(b, row.id);
  }
  return map;
}

// The reverse: which workspace FOLDER a directory sits in — MAIN_ENV for the repo
// root, else the worktree folder's own name, or null for a path outside this
// checkout entirely. Needed because some chats record only where they ran — a
// Cursor conversation knows its folder and nothing about issues. Note the folder
// name is NOT always the canonical issue id: a branch-named worktree's folder is
// its branch, so anything matching this against the board must run it through
// workspaceIssueMap first (hence the deliberately folder-shaped name).
//
// Containment, not name-matching: the worktrees directory is itself inside the
// repo root, so the longest enclosing workspace wins and a chat opened in a
// worktree can never be mistaken for a chat on main. A subdirectory belongs to
// its enclosing workspace, the same way git resolves a repo from any path
// inside it.
export function workspaceForDir(dir) {
  if (!dir) return null;
  const resolved = path.resolve(dir);
  const within = (base) => resolved === base || resolved.startsWith(base + path.sep);
  const worktrees = path.join(MAIN_REPO, '.claude', 'worktrees');
  if (within(worktrees)) {
    const [name] = path.relative(worktrees, resolved).split(path.sep);
    return validIssueId(name) ? name : null;
  }
  return within(MAIN_REPO) ? MAIN_ENV : null;
}
