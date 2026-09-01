// Read-only repository model for the Dash Code view. A snapshot includes every
// tracked/untracked file and overlays its change relative to main; a file read
// returns either a Monaco source model or the original/modified pair for a diff.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './proc.mjs';
import { OVERSIZE, readObject, warmObjects } from './git-objects.mjs';
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
    // `error` set means the CHILD NEVER RAN — spawn itself failed, typically
    // EAGAIN/EMFILE when the machine is out of processes or descriptors. Say so.
    // Falling through to the generic text reports a resource exhaustion as
    // "git rev-parse failed", which reads as a repository problem and sends the
    // next reader looking at the wrong thing entirely.
    if (result.error) {
      throw new CodeBrowserError(`could not run git (${result.error.code || result.error.message})`, 500);
    }
    throw new CodeBrowserError(result.stderr.trim() || `git ${args[0]} failed`, 500);
  }
  return result.stdout;
}

async function commit(root, ref) {
  const output = await git(root, ['rev-parse', '--verify', `${ref}^{commit}`]);
  return output.trim();
}

// The checked-out branch and the ref to review against, resolved together —
// every caller that wants one wants the other, and asking git twice for the
// current branch is a whole-repo call this path can't afford to spend twice.
async function repositoryBase(root, explicitRef = null) {
  const branch = (await git(root, ['branch', '--show-current'])).trim();
  const head = async () => ({ branch, label: 'HEAD', sha: await commit(root, 'HEAD') });
  if (explicitRef) return { branch, label: explicitRef, sha: await commit(root, explicitRef) };
  if (!branch || branch === 'main') return head();

  for (const label of ['main', 'origin/main']) {
    try {
      const result = await run('git', ['-C', root, 'merge-base', 'HEAD', label]);
      if (result.status === 0 && result.stdout.trim()) return { branch, label, sha: result.stdout.trim() };
    } catch { /* try the next conventional main ref */ }
  }
  return head();
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

// The working-tree side of the view. The ceiling is enforced by the READ, and
// only by the read: this is a live working tree, so a size taken from the stat
// is a guess that a file an agent is writing invalidates between the two calls.
// Streaming and stopping the moment it passes the ceiling is exact where the
// stat was approximate, and it is the whole guard rather than a second one —
// one invariant, one mechanism, and a mechanism a test can actually reach.
async function currentBuffer(root, relative, status, maxBytes) {
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
  const chunks = [];
  let total = 0;
  for await (const chunk of fs.createReadStream(real)) {
    total += chunk.length;
    if (total > maxBytes) return OVERSIZE; // ends the stream
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

// The base version of a changed file — the only git the click path still needs,
// and it is a lookup rather than a program: `git-objects.mjs` keeps one
// `cat-file --batch` open per repository so this costs a pipe round-trip instead
// of a fork+exec. An added file has no base version to fetch and never asks.
async function originalBuffer(root, baseSha, relative, status, maxBytes) {
  if (status === 'added' || !relative) return Buffer.alloc(0);
  return (await readObject(root, `${baseSha}:${relative}`, { maxBytes })) ?? Buffer.alloc(0);
}

// Why the view can't show what it was asked for. Each side is a Buffer, or one
// of two answers that isn't bytes at all: `null` for a symlink, `OVERSIZE` for
// something real but too big to have read.
function unsupported(buffers) {
  if (buffers.some((buffer) => buffer === null)) return 'symlink';
  if (buffers.some((buffer) => buffer === OVERSIZE)) return 'large';
  if (buffers.some((buffer) => buffer.includes(0))) return 'binary';
  return null;
}

// A snapshot is a whole-repo scan — `ls-files --others` walks every untracked
// path and `diff --name-status` stats every tracked one — which measures ~1.7s on
// an idle machine and 10-17s on a loaded one, against a client that polls it
// every 3s per open pane. The old shape cached the PROMISE under a 2s TTL, which
// is SHORTER than that poll, so no poll ever hit it; worse, a poll arriving past
// the TTL started a second whole-repo scan while the first was still running, and
// under load that settles into several concurrent scans per repo which make the
// machine they are measuring slower still.
//
// The cure isn't a longer lifetime. The pane wants a live tree, and a value held
// past its own computation is stale for exactly as long as you hold it. It's
// that READERS COALESCE: a request arriving while a scan is running JOINS that
// scan instead of starting another. The cache's lifetime is the computation,
// which is the only lifetime that matches how this is consumed — every response
// still reflects a scan no older than the one in flight.
//
// And A MUTATION SUPERSEDES: something that just changed the repository installs
// the next scan itself (rescan, below) rather than letting readers join one that
// started before the change. So a repo CAN be scanned twice at once — briefly,
// two per key, twice per destructive action. The axis that matters is not
// "sometimes two" versus "never two"; it is BOUNDED-BY-A-HUMAN-ACTION versus
// UNBOUNDED-BY-A-POLL-LOOP, and only the second was ever the pathology this
// replaced.
//
// Instant repaint on revisit is the CLIENT's half of this (fetch-cache.js), and
// it stays honest because the poll behind it refreshes what it painted.
const scans = new Map(); // `${root}\0${baseRef}` → in-flight Promise<snapshot>

function startScan(root, baseRef) {
  const key = `${root}\0${baseRef ?? ''}`;
  // Settled — success or failure — means no scan is in flight, so the next
  // caller starts a fresh one rather than inheriting an old answer or a
  // remembered error. The identity check is also what makes superseding safe:
  // a scan replaced mid-flight will not delete its replacement's entry.
  const scan = computeSnapshot(root, baseRef)
    .finally(() => { if (scans.get(key) === scan) scans.delete(key); });
  scans.set(key, scan);
  return scan;
}

// Start a scan that is guaranteed to have begun AFTER this call, and make it the
// one readers join. For callers that just changed the repository: joining the
// running scan would hand back a tree computed before the change, which for a
// destructive action reads as "the button did nothing".
export function rescan(root, { baseRef = null } = {}) {
  return startScan(root, baseRef);
}

export async function repositorySnapshot(root, { baseRef = null } = {}) {
  const key = `${root}\0${baseRef ?? ''}`;
  return scans.get(key) || startScan(root, baseRef);
}

async function computeSnapshot(root, baseRef) {
  // Whoever is asking for the tree is about to click something in it, and the
  // pane re-asks every 3s for as long as it stays open. Opening the object
  // session here is what makes the FIRST click free too — otherwise it is the
  // one click that still pays for a process.
  warmObjects(root);
  const base = await repositoryBase(root, baseRef);
  const [head, trackedRaw, untrackedRaw, changedRaw] = await Promise.all([
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
  // Again, now that the scan is done. The session ages out on time since it was
  // last wanted, and this scan is itself slow — on a loaded machine it can take
  // longer than that window, which would let the session it opened expire before
  // the tree it belongs to ever reached the client. The click that follows must
  // find it open, and the click follows THIS moment, not the one above.
  warmObjects(root);
  return {
    branch: base.branch || '(detached)',
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

  const current = await currentBuffer(root, entry.path, entry.status, maxBytes);
  const originalPath = entry.oldPath || entry.path;
  const original = entry.status
    ? await originalBuffer(root, baseSha, originalPath, entry.status, maxBytes)
    : Buffer.alloc(0);
  const reason = unsupported(entry.status ? [original, current] : [current]);
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

export function environmentRoot(env) {
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
