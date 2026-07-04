// Dash terminal sidecar — per-issue dev environments built on real `claude`
// Claude Code sessions, streamed to the browser over WebSockets.
//
// MODEL
//   issue  ──1:1──▶  git worktree  (.claude/worktrees/<issueId>, branch <issueId>)
//   worktree ──1:N──▶  chats
//   chat   = one real `claude` session, durable identity = its session-id (uuid),
//            persisted in the issue's Supabase `conversations[]`.
//
// A chat's PTY is keyed by SESSION ID (not issue id), so an issue's multiple
// chats coexist as separate live PTYs. Persistence across a server restart comes
// for free: `claude --resume <uuid>` reads the on-disk transcript, so a chat that
// was linked on this machine re-opens its history even after the dev server (and
// its in-memory PTY map) is gone.
//
// cwd for a NEW chat = the issue's worktree (NOT the repo root); spawned with
// `claude --session-id <uuid> --dangerously-skip-permissions`. cwd for a RESUME
// = the directory the chat's transcript actually recorded (read from the
// transcript), so `claude --resume <uuid>` finds its history even when the chat
// originally ran in a differently-named worktree or another checkout. The
// listing/empty-state likewise reflect the issue's RECORDED state (its
// conversations[] + branches[]), not a path guessed from the issue id.
// Skipping permission prompts is safe here because each chat runs inside an
// isolated worktree, never the live main checkout.
//
// Wire protocol (browser → server), newline-free JSON frames:
//   { type: 'input',  data: '<bytes>' }      keystrokes → pty.write
//   { type: 'resize', cols, rows }           terminal geometry → pty.resize
// Server → browser:
//   { type: 'ready', reattached: bool, cols, rows, sessionId }
//   { type: 'output', data: '<bytes>' }      pty.onData passthrough
//   { type: 'exit',   code }                 pty exited; chat process is gone

import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync, spawn } from 'child_process';
import net from 'net';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pty = require('node-pty');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The MAIN repo root — NOT this worktree. `git worktree` operations are repo-
// global and must run from the main checkout: when this module loads inside a
// worktree's dev server, __dirname resolves to the worktree, so we derive the
// real repo from the shared .git common dir (its parent is the main work tree).
// `git rev-parse --git-common-dir` returns the absolute path to the one .git
// every worktree shares; dirname is the main checkout.
function resolveMainRepo() {
  const worktreeRoot = path.resolve(__dirname, '..', '..');
  const r = spawnSync('git', ['-C', worktreeRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  const common = (r.stdout || '').trim();
  if (common) return path.dirname(common);
  return worktreeRoot; // fallback: not in a worktree (running from main)
}
const MAIN_REPO = resolveMainRepo();

// The universal "main chat" is a single persistent claude thread that runs in
// the LIVE repo root (never a worktree). Its env id is this sentinel — distinct
// from any issue id (those are `i-…`). Unlike an issue chat it has no worktree,
// no Supabase row, and no multi-chat switcher: there is exactly one main PTY,
// keyed by this sentinel, kept alive for the life of the dev server.
export const MAIN_ENV = 'main';

// Resolve the claude binary. Prefer PATH (so a user's own install wins), fall
// back to the cmux-bundled absolute path. LAB_TERMINAL_CMD overrides both —
// used by the test suite to swap in a deterministic stand-in process (so CI
// doesn't depend on claude auth/TTY).
//
// Non-login shell + module-level cache: spawnSync blocks the single Node thread,
// and a login shell (`bash -lc`) sources .zshrc/.zprofile which can take many
// seconds — long enough that the dev server stops answering ANY HTTP while it
// waits. `sh -c` is sub-second and the result doesn't change for the life of the
// process, so we resolve once.
let _cachedClaude = null;
function resolveClaude() {
  if (process.env.LAB_TERMINAL_CMD) return process.env.LAB_TERMINAL_CMD;
  if (_cachedClaude) return _cachedClaude;
  const r = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' });
  const p = (r.stdout || '').trim().split('\n')[0];
  _cachedClaude = p || '/Applications/cmux.app/Contents/Resources/bin/claude';
  return _cachedClaude;
}

// Run git from the MAIN repo. Synchronous: worktree create is a deliberate,
// user-initiated action (one click) — not a hot path — so a brief block is fine
// and far simpler than threading async through the WS attach path.
function git(args) {
  const r = spawnSync('git', ['-C', MAIN_REPO, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function worktreeDir(issueId) {
  return path.join(MAIN_REPO, '.claude', 'worktrees', issueId);
}

// Resolve the issue's REAL worktree, not a name-guessed path. An issue's
// worktree is whichever of these exists, in order:
//   1. `.claude/worktrees/<issueId>` (the day-one convention), OR
//   2. the on-disk worktree of any branch recorded in the issue's `branches[]`.
// Branch→dir is read deterministically from `git worktree list --porcelain`
// (which pairs every checked-out branch with its absolute path) — no string
// surgery on branch names. Returns the absolute dir, or null if the issue has
// no worktree anywhere.
function worktreeMap() {
  // refs/heads/<branch> → absolute worktree dir
  const r = git(['worktree', 'list', '--porcelain']);
  const map = new Map();
  if (!r.ok) return map;
  let curDir = null;
  for (const line of r.out.split('\n')) {
    if (line.startsWith('worktree ')) curDir = line.slice('worktree '.length).trim();
    else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      const name = ref.replace(/^refs\/heads\//, '');
      if (curDir) map.set(name, curDir);
    }
  }
  return map;
}

function resolveWorktreeDir(issueId, branches = []) {
  const byName = worktreeDir(issueId);
  try { if (fs.statSync(byName).isDirectory()) return byName; } catch {}
  const map = worktreeMap();
  for (const b of branches) {
    const dir = map.get(b);
    if (dir) { try { if (fs.statSync(dir).isDirectory()) return dir; } catch {} }
  }
  return null;
}

// Claude stores a session's transcript at
//   ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
// where <encoded-cwd> is the absolute cwd with every '/' and '.' replaced by '-'
// (a LOSSY encode — both chars collapse to '-'), so the dir name can't be
// decoded back to a path. Instead we scan every project dir for the uuid file
// and read the cwd the chat actually ran in straight from the transcript (each
// line records its `cwd`). This is what makes a chat visible regardless of which
// worktree/checkout it ran in.
// ASYNC by design: this scans every project dir and reads a transcript off
// disk. Board-load now resolves many chats at once (one per in-progress issue),
// so a synchronous scan would freeze the single dev-server event loop in a burst
// and starve the chat the human is actually opening. Awaiting fs.promises lets
// those resolves interleave with live requests instead of blocking them.
async function findTranscript(sessionId) {
  const base = path.join(os.homedir(), '.claude', 'projects');
  let dirs;
  try { dirs = await fs.promises.readdir(base); } catch { return null; }
  for (const d of dirs) {
    const p = path.join(base, d, `${sessionId}.jsonl`);
    try { if ((await fs.promises.stat(p)).isFile()) return p; } catch {}
  }
  return null;
}

// The cwd a transcript ran in, read from the first transcript line that records
// one. Returns null if the file has no cwd-bearing line (shouldn't happen for a
// real claude session, but be defensive).
async function transcriptCwd(transcriptPath) {
  let raw;
  try { raw = await fs.promises.readFile(transcriptPath, 'utf8'); } catch { return null; }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { const o = JSON.parse(line); if (o && o.cwd) return o.cwd; } catch {}
  }
  return null;
}

// Resolve a chat session to its on-disk reality:
//   { resumable, cwd } — resumable iff a transcript exists locally AND the cwd
//   it ran in still exists on disk. If the transcript is gone (created on
//   another machine) OR its cwd was removed (worktree merged/rejected) the chat
//   is present-but-unresumable: shown, disabled, never spawned.
async function resolveChat(sessionId) {
  const tp = await findTranscript(sessionId);
  if (!tp) return { resumable: false, cwd: null, reason: 'no-transcript' };
  const cwd = await transcriptCwd(tp);
  if (!cwd) return { resumable: false, cwd: null, reason: 'no-cwd' };
  try { if (!(await fs.promises.stat(cwd)).isDirectory()) return { resumable: false, cwd, reason: 'cwd-gone' }; }
  catch { return { resumable: false, cwd, reason: 'cwd-gone' }; }
  return { resumable: true, cwd, reason: null };
}

// Append a session id to the issue's conversations[] in Supabase. ONE id per
// call (the array-append path de-dupes), avoiding the board.mjs space-join quirk.
async function linkChat(issueId, sessionId) {
  const { appendToArray } = await import('./issues-store.mjs');
  return appendToArray(issueId, 'conversations', [sessionId]);
}

// Reserve a stable dev-server port for the issue (idempotent — re-opening an
// issue that already has one reuses it). Called whenever the worktree is
// ensured, so the port exists by the time the issue-detail link is rendered.
// Best-effort: a Supabase blip shouldn't block making the worktree/chat.
async function reservePort(issueId) {
  try {
    const { allocatePort } = await import('./issues-store.mjs');
    return await allocatePort(issueId);
  } catch (e) { return { error: e.message }; }
}

// The issue's human title, for the new-chat intro message. Best-effort: a
// missing row or Supabase blip yields null and the intro falls back to id-only.
async function issueTitle(issueId) {
  try {
    const { get } = await import('./issues-store.mjs');
    const row = await get(issueId);
    return row?.title || null;
  } catch { return null; }
}

async function issuePort(issueId) {
  try {
    const { get } = await import('./issues-store.mjs');
    const row = await get(issueId);
    return row && row.port != null ? Number(row.port) : null;
  } catch { return null; }
}

// Does this issue exist as a row? Gate worktree creation on it so we never make
// a worktree for a typo'd / nonexistent issue and then orphan it when linking
// fails. Returns true on a Supabase outage too (fail-open) — better to let the
// create proceed than to block real work on a transient network blip; the link
// step will surface any real "no such issue" error.
async function issueExists(issueId) {
  try {
    const { exists } = await import('./issues-store.mjs');
    return await exists(issueId);
  } catch { return true; }
}

// --- worktree lifecycle ---

function hasWorktree(issueId) {
  const dir = worktreeDir(issueId);
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

function branchExists(issueId) {
  return git(['show-ref', '--verify', '--quiet', `refs/heads/${issueId}`]).ok;
}

// Create the issue's worktree if absent, reusing whatever already exists:
//   - dir present                 → reuse (no-op)
//   - branch present, no worktree  → `git worktree add <dir> <issueId>`
//   - neither                      → `git worktree add <dir> -b <issueId>` off main
// After creating a NEW branch we make an initial empty commit so the branch tip
// DIVERGES from main. Without it, a fresh branch's tip == main's tip, which the
// archive-watcher reads as "merged" (tip is an ancestor of main) and would flag
// for deletion the moment the worktree is gone. The empty commit is the day-one
// guard that makes a brand-new issue worktree safe from the janitor.
function ensureWorktree(issueId) {
  const dir = worktreeDir(issueId);
  if (hasWorktree(issueId)) return { ok: true, dir, created: false };

  fs.mkdirSync(path.dirname(dir), { recursive: true });

  let res;
  let madeNewBranch = false;
  if (branchExists(issueId)) {
    res = git(['worktree', 'add', dir, issueId]);
  } else {
    // Branch from local main/master, falling back to the origin refs.
    const base = ['main', 'master', 'origin/main', 'origin/master']
      .find(ref => git(['rev-parse', '--verify', '--quiet', ref]).ok) || 'HEAD';
    res = git(['worktree', 'add', dir, '-b', issueId, base]);
    madeNewBranch = res.ok;
  }

  if (!res.ok) {
    // Don't leave a half-made worktree: prune any registration git may have
    // recorded before failing, and remove a stray dir.
    git(['worktree', 'prune']);
    try { if (hasWorktree(issueId)) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return { ok: false, error: res.err || 'git worktree add failed' };
  }

  if (madeNewBranch) {
    const c = spawnSync('git', ['-C', dir, 'commit', '--allow-empty', '-m', `wip: open issue ${issueId}`], { encoding: 'utf8' });
    if (c.status !== 0) {
      return { ok: false, error: `worktree created but initial commit failed: ${(c.stderr || '').trim()}` };
    }
  }

  return { ok: true, dir, created: true };
}

// --- per-issue dev server (lazy-start) ---
//
// Each issue's worktree has a STABLE dev-server port reserved at worktree-
// create time (persisted on the issue row — see issues-store.allocatePort). We
// do NOT eagerly run a server for every issue: a vite process is only spawned
// when the worktree/terminal is opened or the link is followed, and reused if
// already up. Servers are tracked on globalThis so vite HMR re-evaluating this
// module doesn't orphan a running child (it'd leak / double-spawn).
if (!globalThis.__labDevServers) globalThis.__labDevServers = new Map();
const devServers = globalThis.__labDevServers; // issueId → { proc, port, dir }
export const _devServers = devServers; // test seam: inspect/clear tracked servers

// Is something already listening on this port? A TCP connect probe: if it
// connects, a server (ours from a prior session, or anything) is up. Async so
// it never blocks the Dash server's event loop. Resolves true if reachable.
function portInUse(port) {
  return new Promise((resolve) => {
    // host 'localhost' (not hardcoded IPv4) so the probe matches vite, which
    // under v7 binds IPv6 [::1] only — 127.0.0.1 would never connect.
    const sock = net.connect({ port, host: 'localhost' });
    const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
    sock.setTimeout(500);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

// Spawn the detached, long-lived dev-server child bound to the worktree. Real
// runs get `npx vite --port <port> --strictPort`; the test suite swaps in a
// deterministic stand-in via LAB_DEV_SERVER_CMD (the same trick LAB_TERMINAL_CMD
// plays for the claude PTY) — run through `sh -c` with PORT in the env so the
// stand-in needs no vite-specific argv. Detached + unref so it survives this
// request and never blocks the event loop.
function spawnDevServer(dir, port) {
  const cmd = process.env.LAB_DEV_SERVER_CMD;
  return cmd
    ? spawn('sh', ['-c', cmd], { cwd: dir, detached: true, stdio: 'ignore', env: { ...process.env, PORT: String(port) } })
    : spawn('npx', ['vite', '--port', String(port), '--strictPort'], { cwd: dir, detached: true, stdio: 'ignore', env: { ...process.env } });
}

// Ensure a vite dev server is running on `port` with cwd = the issue's worktree.
// Reuses one we already spawned (live child) or any server already answering on
// the port (e.g. survived a Dash-server restart). Otherwise spawns a detached,
// long-lived child bound to the worktree. The archive-watcher SIGTERMs it when
// the worktree dir is removed (merge/reject).
export async function ensureDevServer(issueId, port) {
  const dir = worktreeDir(issueId);
  const tracked = devServers.get(issueId);
  if (tracked && tracked.proc && tracked.proc.exitCode == null && tracked.port === port) {
    return { ok: true, port, started: false };
  }
  // Something already listening (a server from a previous Dash-server lifetime,
  // or a manual one): reuse it rather than fighting --strictPort.
  if (await portInUse(port)) return { ok: true, port, started: false };
  if (!hasWorktree(issueId)) return { ok: false, error: 'no worktree for issue' };

  let proc;
  try {
    proc = spawnDevServer(dir, port);
  } catch (e) {
    return { ok: false, error: `spawn dev server failed: ${e.message}` };
  }
  proc.unref();
  proc.on('exit', () => {
    const cur = devServers.get(issueId);
    if (cur && cur.proc === proc) devServers.delete(issueId);
  });
  devServers.set(issueId, { proc, port, dir });
  return { ok: true, port, started: true };
}

// The PID(s) listening on a TCP port. Deterministic (`lsof` by exact port +
// LISTEN state) — the same lsof tool the archive-watcher uses. Lets us restart a
// dev server we don't track (one adopted via portInUse from a prior Dash-server
// lifetime, so devServers has no entry for it).
export function devServerListenerPids(port) {
  const r = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  return (r.stdout || '').split('\n').map(s => parseInt(s.trim(), 10)).filter(Boolean);
}

// Poll until NOTHING is listening on the port (or timeout). vite runs with
// --strictPort, so an immediate respawn races the dying process and fails to
// bind — we wait for the OS to actually release the port before relaunching.
async function waitForPortFree(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portInUse(port))) return true;
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

// Restart the issue's dev server: kill whatever holds the port — the child we
// spawned AND/OR any adopted listener (no tracked proc) — wait for the port to
// free (--strictPort needs it released first), then relaunch via ensureDevServer
// and wait for the fresh server to answer. Returns once the new server is live,
// so the ↻ caller only opens the app tab on a server that's actually up.
export async function restartDevServer(issueId, port) {
  if (!hasWorktree(issueId)) return { ok: false, error: 'no worktree for issue' };

  const tracked = devServers.get(issueId);
  if (tracked && tracked.proc && tracked.proc.exitCode == null) {
    try { tracked.proc.kill('SIGTERM'); } catch {}
  }
  devServers.delete(issueId);
  // Also kill any listener on the port directly — covers an adopted server with
  // no tracked proc, and any stray that outlived its child wrapper.
  for (const pid of devServerListenerPids(port)) {
    if (pid === process.pid) continue;
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }

  await waitForPortFree(port);
  // If SIGTERM didn't free it in time, escalate so the strictPort respawn can
  // bind instead of silently reusing the old server.
  if (await portInUse(port)) {
    for (const pid of devServerListenerPids(port)) {
      if (pid === process.pid) continue;
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    await waitForPortFree(port);
  }

  const r = await ensureDevServer(issueId, port);
  if (!r.ok) return r;
  const live = await waitForPort(port);
  return live
    ? { ok: true, port, restarted: true }
    : { ok: false, port, error: 'dev server did not answer after restart' };
}

// Poll until the dev server answers (or timeout). vite takes ~1-2s to bind on a
// cold start; the open endpoint waits briefly so the redirect lands on a live
// server instead of a connection-refused.
async function waitForPort(port, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portInUse(port)) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

// Report an issue's worktree + chats for the client, reflecting the issue's REAL
// recorded state rather than a name-guessed path. The worktree is resolved from
// the `<issueId>` dir OR any recorded branch's worktree; each chat is resolved
// by finding its transcript anywhere under ~/.claude/projects and reading the
// cwd it actually ran in. A chat is resumable iff EITHER a live PTY for it is
// already running in this process OR its transcript exists and the cwd it ran in
// still exists on disk — independent of which worktree the issue "should" have.
// The live-PTY case matters for a freshly-spawned autonomous chat: its session
// is linked and its PTY is running before claude writes the first transcript
// line, so a transcript-only check would (briefly) call it unresumable and the
// board's auto-attach would skip it and never retry. attachChat reattaches to a
// live PTY without touching the transcript, so reporting it resumable is honest.
export async function issueChats(issueId) {
  let row = null;
  try {
    const { get } = await import('./issues-store.mjs');
    row = await get(issueId);
  } catch {}
  const conversations = Array.isArray(row?.conversations) ? row.conversations : [];
  const branches = Array.isArray(row?.branches) ? row.branches : [];
  const dir = resolveWorktreeDir(issueId, branches);
  // Resolve conversations SEQUENTIALLY, not via Promise.all: board-load already
  // mounts in-progress issues a couple at a time, and each unresolved transcript
  // is a full ~/.claude/projects scan. Resolving an issue's convos one-by-one
  // keeps the in-flight scan count bounded by the issue throttle (≈2) rather than
  // 2 × convos-per-issue. A live PTY short-circuits the scan entirely.
  const live = globalThis.__labChats;
  const chats = [];
  for (const sessionId of conversations) {
    const session = live?.get(sessionId);
    if (session && !session.exited) { chats.push({ sessionId, resumable: true, live: true, cwd: null }); continue; }
    const { resumable, cwd } = await resolveChat(sessionId);
    chats.push({ sessionId, resumable, live: false, cwd });
  }
  return { worktree: !!dir, dir, chats };
}

// The set of issue ids that currently have a LIVE (non-exited) PTY in this
// process — read straight from the in-memory chats map, no fs, no spawn. This is
// what board-load auto-attach seeds from: "chats that exist server-side but were
// never opened this session" reattach cheaply, whereas cold-resuming a dormant
// chat just to compute a dot would both stampede the server and silently
// resurrect a finished conversation. The main chat is excluded (it's not a card).
function liveIssueChats() {
  const live = globalThis.__labChats;
  const issues = new Set();
  if (live) for (const s of live.values()) {
    if (!s.exited && s.issueId && s.issueId !== MAIN_ENV) issues.add(s.issueId);
  }
  return [...issues];
}

// --- live PTYs, keyed by SESSION ID ---

// Each session: { pty, issueId, buffer:[], cols, rows, attached:ws|null, exited }.
// Lives on globalThis so Vite HMR re-evaluating this module doesn't orphan
// running PTYs (they'd leak / double-spawn).
if (!globalThis.__labChats) globalThis.__labChats = new Map();
const chats = globalThis.__labChats;

const MAX_BUFFER_BYTES = 256 * 1024; // replayed to reattaching clients

function bufferPush(session, data) {
  session.buffer.push(data);
  let total = session.buffer.reduce((n, s) => n + s.length, 0);
  while (total > MAX_BUFFER_BYTES && session.buffer.length > 1) {
    total -= session.buffer.shift().length;
  }
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// Spawn a `claude` PTY for a chat. `mode` is 'new' (fresh --session-id) or
// 'resume' (--resume an existing uuid). cwd for a NEW chat is the issue's
// worktree; a RESUME runs in the directory the transcript actually recorded, so
// `claude --resume` finds its history (the project dir is keyed off cwd).
// The first message auto-sent into a brand-new chat. It orients claude to the
// issue AND — by being a real turn — forces claude to write a transcript, which
// is what makes the chat resumable later (an empty, never-messaged session
// leaves no .jsonl on disk, so it can never be reopened). Title is best-effort.
export function issueChatIntro(issueId, title) {
  const named = title ? `\`${issueId}\` — "${title}"` : `\`${issueId}\``;
  return `This chat is scoped to issue ${named}. Run \`node scripts/board.mjs get ${issueId}\` to load the full issue, then give me a one-line summary of what it's about and wait for direction.`;
}

// Intro for an AUTONOMOUSLY-launched chat: same issue-scoping as the human
// intro, but instead of "summarize and wait for direction" it tells claude to
// run the change pipeline end-to-end on its own. `flow` picks the protocol —
// 'bug' for a reported regression (reproduce → fix), else the plain /change
// spine. The human opens the card later to monitor/unblock, not to kick it off.
export function autonomousChatIntro(issueId, title, flow = 'change') {
  const named = title ? `\`${issueId}\` — "${title}"` : `\`${issueId}\``;
  const skill = flow === 'bug' ? '/bug' : '/change';
  return `This chat is scoped to issue ${named}, and you were launched autonomously to implement it end-to-end. Run \`node scripts/board.mjs get ${issueId}\` to load the full issue, then invoke the \`${skill}\` skill and carry it through to completion — confirm the scope to yourself and proceed without waiting for further direction. A human will open this chat to monitor and unblock you, not to start you. When the work is candidate-complete, present receipts and the live preview link per the protocol.`;
}

// Build claude's argv for a chat spawn. RESUME reopens an existing uuid; NEW
// mints one and (when given) carries an initial prompt as a positional arg —
// `claude … "<prompt>"` stays interactive AND submits that first turn.
export function buildChatArgs({ mode, sessionId, initialPrompt }) {
  // Main chat. A cold start resumes the LATEST root session via claude's own
  // --continue, so a `/clear` that forked the on-disk session id is still picked
  // up ("open whatever was last there"). Only the very first open ever mints a
  // fresh session and sends /main.
  if (mode === 'main') return ['--continue', '--dangerously-skip-permissions'];
  if (mode === 'main-init') {
    const args = ['--session-id', sessionId, '--dangerously-skip-permissions'];
    if (initialPrompt) args.push(initialPrompt);
    return args;
  }
  const args = mode === 'resume'
    ? ['--resume', sessionId, '--dangerously-skip-permissions']
    : ['--session-id', sessionId, '--dangerously-skip-permissions'];
  if (mode !== 'resume' && initialPrompt) args.push(initialPrompt);
  return args;
}

function spawnChat({ issueId, sessionId, mode, cwd, cols, rows, initialPrompt, key }) {
  // PTYs are keyed by session id for issue chats, but by the MAIN_ENV sentinel
  // for the main chat (which has no stable client-side id — it rides --continue).
  const mapKey = key || sessionId;
  const claude = resolveClaude();
  // Test stand-in (LAB_TERMINAL_CMD, e.g. /bin/cat) takes no claude flags — it
  // must just echo. Real claude gets the session flags + skip-permissions.
  const args = process.env.LAB_TERMINAL_CMD
    ? []
    : buildChatArgs({ mode, sessionId, initialPrompt });

  const term = pty.spawn(claude, args, {
    name: 'xterm-256color',
    cols: cols || 100,
    rows: rows || 30,
    cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  const session = {
    pty: term, issueId, sessionId,
    buffer: [], cols: cols || 100, rows: rows || 30,
    attached: null, exited: false,
  };
  chats.set(mapKey, session);

  term.onData((data) => {
    bufferPush(session, data);
    if (session.attached) send(session.attached, { type: 'output', data });
  });
  term.onExit(({ exitCode }) => {
    session.exited = true;
    if (session.attached) send(session.attached, { type: 'exit', code: exitCode });
    chats.delete(mapKey);
  });

  return session;
}

// Attach a websocket to a chat's PTY. If the PTY is already live (e.g. after a
// browser refresh) reattach and replay the recent buffer; otherwise spawn it.
// `mode` tells a cold spawn whether this is a brand-new chat or a resume of a
// linked-but-not-running session.
export async function attachChat(ws, { issueId, sessionId, mode }) {
  const isMain = issueId === MAIN_ENV;
  // The main chat is ONE persistent PTY keyed by the sentinel; issue chats are
  // keyed by session id. Reattaching to a live PTY makes a browser reload (and a
  // mid-session /clear) invisible — you stay on the same terminal.
  const key = isMain ? MAIN_ENV : sessionId;
  let session = chats.get(key);
  const reattached = !!session && !session.exited;

  if (!reattached) {
    let cwd, spawnMode, spawnSessionId, initialPrompt;
    if (isMain) {
      // The main chat always runs in the live repo root, never a worktree.
      // First-ever open (client mode 'main-init') mints a session and sends
      // /main; every later cold start resumes the latest root session.
      cwd = MAIN_REPO;
      if (mode === 'main-init') {
        spawnMode = 'main-init';
        spawnSessionId = crypto.randomUUID();
        initialPrompt = '/main';
      } else {
        spawnMode = 'main';
        spawnSessionId = MAIN_ENV; // unused by --continue; just the session record
      }
    } else {
      // Resolve where an issue chat must run: a RESUME runs in the directory its
      // transcript recorded (so --resume finds its history, even if that's a
      // differently-named worktree or another checkout); a NEW chat runs in the
      // issue's own worktree. Bail if there's no live directory to run in.
      if (mode === 'new') {
        cwd = hasWorktree(issueId) ? worktreeDir(issueId) : null;
      } else {
        const r = await resolveChat(sessionId);
        cwd = r.resumable ? r.cwd : null;
      }
      if (!cwd) {
        const err = mode === 'new' ? 'no worktree for issue' : 'chat not resumable on this machine';
        send(ws, { type: 'exit', code: null, error: err });
        try { ws.close(1011, err); } catch {}
        return;
      }
      // A fresh chat opens with an auto-sent issue-reference message — this both
      // orients claude and guarantees a transcript gets written (the resumability
      // contract). Title is best-effort; a Supabase blip just drops the title.
      spawnMode = mode || 'resume';
      spawnSessionId = sessionId;
      initialPrompt = mode === 'new' ? issueChatIntro(issueId, await issueTitle(issueId)) : undefined;
    }
    session = spawnChat({ issueId, sessionId: spawnSessionId, mode: spawnMode, cwd, cols: 100, rows: 30, initialPrompt, key });
  }

  if (session.attached && session.attached !== ws) {
    try { session.attached.close(1000, 'superseded'); } catch {}
  }
  session.attached = ws;

  send(ws, { type: 'ready', reattached, cols: session.cols, rows: session.rows, sessionId: session.sessionId });

  if (reattached && session.buffer.length) {
    send(ws, { type: 'output', data: session.buffer.join('') });
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
    if (session.exited) return;
    if (msg.type === 'input' && typeof msg.data === 'string') {
      session.pty.write(msg.data);
    } else if (msg.type === 'resize') {
      const cols = Math.max(2, Math.min(500, msg.cols | 0));
      const rows = Math.max(1, Math.min(300, msg.rows | 0));
      if (cols && rows) {
        session.cols = cols;
        session.rows = rows;
        try { session.pty.resize(cols, rows); } catch {}
      }
    }
  });

  // Socket close detaches but DOES NOT kill the PTY — persistence is the point.
  ws.on('close', () => {
    if (session.attached === ws) session.attached = null;
  });
}

// --- HTTP endpoints (mounted in vite.config.js) ---
//
// GET  /api/dash/terminal/chats?issue=<id>   → { worktree, dir, port, chats:[{sessionId,resumable}] }
// POST /api/dash/terminal/worktree { issue }  → creates worktree (idempotent) + reserves port → { ok, dir, created, port }
// POST /api/dash/terminal/chat     { issue }  → ensures worktree + reserves port + mints a new chat
//                                              (uuid), links it → { ok, sessionId, mode:'new', port }
// GET  /api/dash/terminal/<id>/open           → lazy-start the issue's dev server, 302→ http://localhost:<port>/
// POST /api/dash/terminal/<id>/restart        → kill + relaunch the issue's dev server on its port → { ok, restarted }
export async function handleTerminalHttp(req, res, segs) {
  const json = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  const readBody = () => new Promise((resolve) => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });

  // /api/dash/terminal/chats
  if (req.method === 'GET' && segs[0] === 'chats') {
    const issueId = new URL(req.url, 'http://x').searchParams.get('issue');
    if (!issueId) return json({ error: 'issue required' }, 400);
    const data = await issueChats(issueId);
    data.port = await issuePort(issueId);
    return json(data);
  }

  // /api/dash/terminal/live — issue ids with a live server-side PTY right now.
  // Cheap (in-memory map, no fs/spawn); board-load auto-attach seeds from this so
  // it only ever REATTACHES existing live chats, never cold-spawns dormant ones.
  if (req.method === 'GET' && segs[0] === 'live') {
    return json({ issues: liveIssueChats() });
  }

  // /api/dash/terminal/<id>/open — ensure the dev server is up, then redirect.
  // The clickable link on the issue points here: one hop that lazy-starts vite
  // bound to the worktree (reusing a live one) and 302s to the running app.
  if (req.method === 'GET' && segs.length === 2 && segs[1] === 'open') {
    const issueId = decodeURIComponent(segs[0]);
    if (!hasWorktree(issueId)) return json({ error: 'no worktree for issue' }, 404);
    const port = await issuePort(issueId);
    if (port == null) return json({ error: 'no port reserved for issue' }, 409);
    const r = await ensureDevServer(issueId, port);
    if (!r.ok) return json(r, 500);
    await waitForPort(port);
    res.writeHead(302, { Location: `http://localhost:${port}/`, 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  // /api/dash/terminal/<id>/restart — kill the issue's dev server and relaunch
  // it fresh on the same reserved port. The ↻ button hits this; it returns only
  // once the new server answers, so the client opens the app tab on a live one.
  if (req.method === 'POST' && segs.length === 2 && segs[1] === 'restart') {
    const issueId = decodeURIComponent(segs[0]);
    if (!hasWorktree(issueId)) return json({ error: 'no worktree for issue' }, 404);
    const port = await issuePort(issueId);
    if (port == null) return json({ error: 'no port reserved for issue' }, 409);
    const r = await restartDevServer(issueId, port);
    return json(r, r.ok ? 200 : 500);
  }

  // /api/dash/terminal/worktree
  if (req.method === 'POST' && segs[0] === 'worktree') {
    const { issue } = await readBody();
    if (!issue) return json({ error: 'issue required' }, 400);
    if (!(await issueExists(issue))) return json({ error: `no such issue "${issue}"` }, 404);
    const r = ensureWorktree(issue);
    if (!r.ok) return json(r, 500);
    const alloc = await reservePort(issue);
    return json({ ...r, port: alloc.port ?? null });
  }

  // /api/dash/terminal/chat — new chat in the issue's worktree, linked.
  //   { issue }                              → mint + link a chat; PTY spawns lazily
  //                                            when the browser attaches (human-launched).
  //   { issue, autonomous:true, flow?, prompt? }
  //                                          → ALSO spawn the PTY server-side now, into
  //                                            the chats map (attached:null), running the
  //                                            given flow (/change or /bug) end-to-end.
  //                                            Opening the card later reattaches to it.
  if (req.method === 'POST' && segs[0] === 'chat') {
    const { issue, autonomous, flow, prompt } = await readBody();
    if (!issue) return json({ error: 'issue required' }, 400);
    // Gate on issue existence BEFORE touching git, so a bad id never leaves an
    // orphaned worktree behind a failed link.
    if (!(await issueExists(issue))) return json({ error: `no such issue "${issue}"` }, 404);
    const wt = ensureWorktree(issue);
    if (!wt.ok) return json(wt, 500);
    // Reserve the stable dev-server port at worktree-create time (idempotent).
    const alloc = await reservePort(issue);
    const sessionId = crypto.randomUUID();
    const link = await linkChat(issue, sessionId);
    if (link?.error) return json({ error: `link failed: ${link.error}` }, 500);
    if (autonomous) {
      // Spawn the real claude PTY immediately, keyed by sessionId (same key
      // attachChat uses for a 'new' chat) so a later browser open REATTACHES
      // to this running process rather than spawning a second one. The intro
      // tells it to run the flow to completion instead of waiting for direction.
      const intro = prompt || autonomousChatIntro(issue, await issueTitle(issue), flow);
      spawnChat({ issueId: issue, sessionId, mode: 'new', cwd: wt.dir, cols: 100, rows: 30, initialPrompt: intro, key: sessionId });
      return json({ ok: true, sessionId, mode: 'new', autonomous: true, flow: flow === 'bug' ? 'bug' : 'change', dir: wt.dir, port: alloc.port ?? null });
    }
    return json({ ok: true, sessionId, mode: 'new', dir: wt.dir, port: alloc.port ?? null });
  }

  // DELETE /api/dash/terminal/chat { issue, session } — unlink a chat from the
  // issue's conversations[]. The transcript on disk is untouched; this only drops
  // the association. A live PTY (if any) is left running and will be reaped on
  // exit — unlinking is a bookkeeping action, not a kill.
  if (req.method === 'DELETE' && segs[0] === 'chat') {
    const { issue, session } = await readBody();
    if (!issue || !session) return json({ error: 'issue and session required' }, 400);
    const { removeFromArray } = await import('./issues-store.mjs');
    const r = await removeFromArray(issue, 'conversations', [session]);
    if (r?.error) return json({ error: `unlink failed: ${r.error}` }, 500);
    return json({ ok: true });
  }

  return json({ error: 'unknown terminal endpoint' }, 404);
}
