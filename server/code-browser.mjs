// Read-only repository model for the Dash Code view. A snapshot includes every
// tracked/untracked file and overlays its change relative to main; a file read
// returns either a Monaco source model or the original/modified pair for a diff.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './proc.mjs';
import { MAIN_ENV, workspaceDirForEnv } from './workspace-env.mjs';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export class CodeBrowserError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

async function git(root, args, { binary = false } = {}) {
  const result = await run('git', ['-C', root, ...args], { binary });
  if (result.status !== 0) {
    throw new CodeBrowserError(result.stderr.trim() || `git ${args[0]} failed`, 500);
  }
  return result.stdout;
}

async function commit(root, ref) {
  const output = await git(root, ['rev-parse', '--verify', `${ref}^{commit}`]);
  return output.trim();
}

async function repositoryBase(root, explicitRef = null) {
  if (explicitRef) return { label: explicitRef, sha: await commit(root, explicitRef) };
  const branch = (await git(root, ['branch', '--show-current'])).trim();
  if (!branch || branch === 'main') return { label: 'HEAD', sha: await commit(root, 'HEAD') };

  for (const label of ['main', 'origin/main']) {
    try {
      const result = await run('git', ['-C', root, 'merge-base', 'HEAD', label]);
      if (result.status === 0 && result.stdout.trim()) return { label, sha: result.stdout.trim() };
    } catch { /* try the next conventional main ref */ }
  }
  return { label: 'HEAD', sha: await commit(root, 'HEAD') };
}

function parseTracked(raw) {
  const files = [];
  const symlinks = [];
  for (const entry of raw.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    if (tab === -1) continue;
    const file = entry.slice(tab + 1);
    files.push(file);
    if (entry.slice(0, 6) === '120000') symlinks.push(file);
  }
  return { files, symlinks };
}

// A directory symlink resolving inside the workspace is browsable, not a dead
// leaf: graft the target's tracked files under the link path so `.agents/…`
// mirrors `.claude/…` as an ordinary (unchanged) folder. Links that dangle,
// point at a file, or escape the workspace are left alone to bail safely.
async function graftDirectorySymlinks(root, paths, changes, symlinks) {
  if (!symlinks.length) return;
  const realRoot = await fs.promises.realpath(root);
  for (const link of symlinks) {
    const linkFull = path.resolve(root, link);
    let real;
    let stat;
    try {
      real = await fs.promises.realpath(linkFull);
      stat = await fs.promises.stat(linkFull);
    } catch { continue; }
    if (!stat.isDirectory() || !real.startsWith(realRoot + path.sep)) continue;
    const targetRel = path.relative(realRoot, real);
    if (!targetRel || targetRel.startsWith('..')) continue;
    const prefix = `${targetRel}/`;
    let grafted = false;
    for (const file of [...paths]) {
      if (!file.startsWith(prefix)) continue;
      paths.add(`${link}/${file.slice(prefix.length)}`);
      grafted = true;
    }
    if (grafted) {
      paths.delete(link);
      changes.delete(link);
    }
  }
}

function parseChanged(raw) {
  const tokens = raw.split('\0');
  const changes = new Map();
  for (let i = 0; i < tokens.length;) {
    const code = tokens[i++];
    if (!code) continue;
    if (code.startsWith('R')) {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      if (oldPath && newPath) changes.set(newPath, { status: 'renamed', oldPath });
      continue;
    }
    const file = tokens[i++];
    if (!file) continue;
    const status = code.startsWith('A') ? 'added'
      : code.startsWith('D') ? 'deleted'
        : code.startsWith('C') ? 'added'
          : 'modified';
    changes.set(file, { status });
  }
  return changes;
}

function languageFor(file) {
  const name = path.basename(file).toLowerCase();
  const ext = path.extname(name).slice(1);
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'makefile';
  return ({
    c: 'c', cc: 'cpp', cpp: 'cpp', css: 'css', go: 'go', html: 'html', htm: 'html',
    java: 'java', js: 'javascript', jsx: 'javascript', json: 'json', md: 'markdown',
    mjs: 'javascript', cjs: 'javascript', py: 'python', rb: 'ruby', rs: 'rust',
    sh: 'shell', sql: 'sql', svg: 'xml', ts: 'typescript', tsx: 'typescript',
    txt: 'plaintext', xml: 'xml', yaml: 'yaml', yml: 'yaml', toml: 'ini',
  })[ext] || 'plaintext';
}

function safeRelative(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') || relative.includes('\\')) {
    throw new CodeBrowserError('invalid file path', 400);
  }
  const normalized = path.posix.normalize(relative);
  const full = path.resolve(root, normalized);
  const prefix = path.resolve(root) + path.sep;
  if (normalized === '..' || normalized.startsWith('../') || (!full.startsWith(prefix) && full !== path.resolve(root))) {
    throw new CodeBrowserError('file is outside the workspace', 403);
  }
  return { relative: normalized, full };
}

async function currentBuffer(root, relative, status) {
  if (status === 'deleted') return Buffer.alloc(0);
  const { full } = safeRelative(root, relative);
  let stat;
  try { stat = await fs.promises.lstat(full); } catch (error) {
    if (error.code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  }
  if (stat.isSymbolicLink()) return null;
  if (!stat.isFile()) throw new CodeBrowserError('not a file', 400);
  const [real, realRoot] = await Promise.all([
    fs.promises.realpath(full),
    fs.promises.realpath(root),
  ]);
  if (!real.startsWith(realRoot + path.sep)) throw new CodeBrowserError('file is outside the workspace', 403);
  return fs.promises.readFile(real);
}

async function originalBuffer(root, baseSha, relative, status) {
  if (status === 'added' || !relative) return Buffer.alloc(0);
  const result = await run('git', ['-C', root, 'show', `${baseSha}:${relative}`], { binary: true });
  if (result.status !== 0) return Buffer.alloc(0);
  return result.stdout;
}

function unsupported(buffers, maxBytes) {
  if (buffers.some((buffer) => buffer === null)) return 'symlink';
  if (buffers.some((buffer) => buffer.length > maxBytes)) return 'large';
  if (buffers.some((buffer) => buffer.includes(0))) return 'binary';
  return null;
}

// A full snapshot runs 4 whole-repo git calls (ls-files ×2, diff, rev-parse), so
// recomputing it on EVERY file open — plus the client's 3s poll — was the reason
// opening a file felt slow: each click re-scanned the entire tree just to look up
// one entry's status + baseSha. Coalesce with a short TTL keyed by root+baseRef:
// the poll refreshes it every few seconds and file opens reuse that snapshot,
// paying only for the one file's own git-show. The cached value is the PROMISE,
// so a poll and an open firing together share a single computation.
const SNAPSHOT_TTL_MS = 2000;
const snapshotCache = new Map(); // `${root}\0${baseRef}` → { at, promise }

export async function repositorySnapshot(root, { baseRef = null } = {}) {
  const key = `${root}\0${baseRef ?? ''}`;
  const hit = snapshotCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < SNAPSHOT_TTL_MS) return hit.promise;
  const promise = computeSnapshot(root, baseRef);
  snapshotCache.set(key, { at: now, promise });
  // Don't cache a rejection — drop it so the next call retries.
  promise.catch(() => { if (snapshotCache.get(key)?.promise === promise) snapshotCache.delete(key); });
  return promise;
}

async function computeSnapshot(root, baseRef) {
  const base = await repositoryBase(root, baseRef);
  const [branch, head, trackedRaw, untrackedRaw, changedRaw] = await Promise.all([
    git(root, ['branch', '--show-current']),
    commit(root, 'HEAD'),
    git(root, ['ls-files', '--cached', '-s', '-z']),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
    git(root, ['diff', '--name-status', '-z', '-M', base.sha, '--']),
  ]);
  const changes = parseChanged(changedRaw);
  const tracked = parseTracked(trackedRaw);
  const paths = new Set(tracked.files);
  await graftDirectorySymlinks(root, paths, changes, tracked.symlinks);
  for (const file of untrackedRaw.split('\0').filter(Boolean)) {
    paths.add(file);
    changes.set(file, { status: 'added' });
  }
  for (const [file, change] of changes) {
    paths.add(file);
    if (change.oldPath) paths.delete(change.oldPath);
  }
  const files = [...paths]
    .map((file) => ({ path: file, ...(changes.get(file) || { status: null }) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    branch: branch.trim() || '(detached)',
    base: base.label,
    baseSha: base.sha,
    head: head.trim(),
    changedCount: files.filter((file) => file.status).length,
    files,
  };
}

// A new file the chat created is an untracked add that `git diff` omits, so we
// count its lines the way git would — every '\n', plus one for a final line with
// no trailing newline. Binary (a NUL byte) or unreadable files score zero, the
// same guard `unsupported` uses.
async function countAddedLines(full) {
  let buf;
  try { buf = await fs.promises.readFile(full); } catch { return 0; }
  if (buf.length === 0 || buf.includes(0)) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  if (buf[buf.length - 1] !== 10) n++;
  return n;
}

// Total +/- lines the worktree carries vs its base — the SAME merge-base-main the
// snapshot diffs against, so the code-pane LOC badge agrees with the file list it
// sits above. `git diff --numstat` covers tracked changes (committed + working
// tree); untracked adds are counted separately since git leaves them out. Binary
// blobs (numstat '-') are skipped. This is the deterministic per-worktree LOC the
// codex chat-status reads — codex, unlike claude, keeps no self-reported count.
export async function repositoryLoc(root) {
  const base = await repositoryBase(root);
  const [numstat, untrackedRaw] = await Promise.all([
    git(root, ['diff', '--numstat', '-M', base.sha, '--']),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  let added = 0;
  let removed = 0;
  for (const line of numstat.split('\n')) {
    if (!line) continue;
    const [a, r] = line.split('\t');
    if (a === '-' || r === '-') continue; // binary: numstat marks it '-'
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }
  for (const rel of untrackedRaw.split('\0')) {
    if (rel) added += await countAddedLines(path.join(root, rel));
  }
  return { added, removed };
}

export async function repositoryFile(root, file, { baseRef = null, maxBytes = DEFAULT_MAX_BYTES, hint = null } = {}) {
  const safe = safeRelative(root, file);
  let entry;
  let baseSha;
  let baseLabel;
  // Fast path: the client already knows each file's status + the base sha from
  // the tree snapshot it polls, so trust those and read just this one file — the
  // whole-repo snapshot (4 git calls over the entire tree) is what made opening a
  // file slow. `safeRelative` still confines the path, and a bad sha/status only
  // yields a stale diff that the next poll corrects. No hint ⇒ snapshot fallback.
  if (hint && hint.baseSha) {
    entry = { path: safe.relative, status: hint.status || null, oldPath: hint.oldPath || null };
    baseSha = hint.baseSha;
    baseLabel = hint.base || hint.baseSha;
  } else {
    const snapshot = await repositorySnapshot(root, { baseRef });
    entry = snapshot.files.find((candidate) => candidate.path === safe.relative);
    if (!entry) throw new CodeBrowserError('file not found', 404);
    baseSha = snapshot.baseSha;
    baseLabel = snapshot.base;
  }

  const current = await currentBuffer(root, entry.path, entry.status);
  const originalPath = entry.oldPath || entry.path;
  const original = entry.status
    ? await originalBuffer(root, baseSha, originalPath, entry.status)
    : Buffer.alloc(0);
  const reason = unsupported(entry.status ? [original, current] : [current], maxBytes);
  const common = {
    path: entry.path,
    oldPath: entry.oldPath || null,
    status: entry.status,
    language: languageFor(entry.path),
    base: baseLabel,
  };
  if (reason) return { ...common, kind: 'unsupported', reason };
  if (entry.status) {
    return {
      ...common,
      kind: 'diff',
      original: original.toString('utf8'),
      modified: current.toString('utf8'),
    };
  }
  return { ...common, kind: 'source', text: current.toString('utf8') };
}

function environmentRoot(env) {
  const root = workspaceDirForEnv(env);
  if (!root) throw new CodeBrowserError('No workspace is available for this issue.', 404);
  return root;
}

export async function environmentSnapshot(env) {
  return { env, ...(await repositorySnapshot(environmentRoot(env), { baseRef: env === MAIN_ENV ? 'HEAD' : null })) };
}

export async function environmentFile(env, file, hint = null) {
  return repositoryFile(environmentRoot(env), file, { baseRef: env === MAIN_ENV ? 'HEAD' : null, hint });
}
