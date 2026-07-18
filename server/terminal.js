// Dash terminal sidecar — per-issue dev environments built on real agent CLI
// sessions (Claude Code or Codex), streamed to the browser over WebSockets.
//
// MODEL
//   issue  ──1:1──▶  git worktree  (.claude/worktrees/<issueId>, branch <issueId>)
//   worktree ──1:N──▶  chats
//   chat   = one real agent session, durable identity = its session-id (uuid),
//            persisted in the issue's Supabase `conversations[]`. The agent type
//            rides IN that entry (bare uuid = claude, `codex:<uuid>` = codex —
//            see agents.mjs parseHandle/formatHandle); everything CLI-specific
//            (binary, argv, transcript store, liveness) lives behind an agent
//            adapter, so this file's PTY/registry machinery stays agent-agnostic.
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
//   { type: 'output', data: '<bytes>' }      pty.onData passthrough (broadcast
//                                            to every attached socket)
//   { type: 'grid', cols, rows }             another pane took the PTY grid —
//                                            mirror it (sent to non-owners)
//   { type: 'owner' }                        the grid owner detached — assert
//                                            your fit if you can (hidden
//                                            panes stay mirrors)
//   { type: 'exit',   code }                 pty exited; chat process is gone
//   { type: 'redirect', port }               chat is live in ANOTHER dash server
//                                            on this machine — reconnect there

import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync, spawn } from 'child_process';
import net from 'net';
import { run } from './proc.mjs';
import {
  agentById, agentChoices, parseHandle, formatHandle,
  findTranscriptAny, liveArgvPatternAny, DEFAULT_AGENT,
} from './agents.mjs';
import { createRequire } from 'module';
import {
  MAIN_ENV, MAIN_REPO, resolveWorktreeDir, worktreeDir,
} from './workspace-env.mjs';
import {
  mainChatsList, linkMainChat, unlinkMainChat,
} from './main-chats-store.mjs';
import { normalizeAppPath } from '../src/app-env.mjs';

const require = createRequire(import.meta.url);
const pty = require('node-pty');

// The MAIN chat is a dev environment exactly like an issue — a switcher over
// multiple chats — differing only in WHERE it runs and WHERE its list lives: its
// chats run in the LIVE repo root (never a worktree) and are tracked in a
// machine-local store (main-chats-store.mjs) instead of a shared Supabase row,
// because main-root sessions are per-machine. `MAIN_ENV` is its env id (the
// value passed as `issue=main`), distinct from any issue id (`i-…`); a main
// chat's PTY is keyed by its session uuid like any other, so main carries no
// special singleton path.
export { MAIN_ENV };

// Run git from the MAIN repo. ASYNC: even "deliberate one-click" actions like
// worktree create run on the same event loop that relays terminal keystrokes —
// a synchronous `git worktree add` measured ~5s of loop block, freezing every
// attached terminal for its duration. Awaiting keeps typing responsive while
// git churns.
async function git(args) {
  const r = await run('git', ['-C', MAIN_REPO, ...args]);
  return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr.trim() };
}

// Locating a chat's transcript and reading the cwd it ran in is now agent-
// specific (claude scans ~/.claude/projects, codex scans ~/.codex/sessions) —
// see findTranscriptAny + each adapter in agents.mjs. Both are ASYNC by design:
// resolving a chat reads transcripts off disk, and board-load resolves many at
// once, so awaiting fs.promises lets those interleave with live requests instead
// of freezing the single dev-server event loop.

// The cwd a transcript ran in, read from the first transcript line that records
// Resolve a chat session to its on-disk reality:
//   { resumable, cwd, agent } — resumable iff a transcript exists locally AND
//   the cwd it ran in still exists on disk. `agent` is whichever adapter's store
//   the transcript was found in (a uuid lives in exactly one). If the transcript
//   is gone (created on another machine) OR its cwd was removed (worktree
//   merged/rejected) the chat is present-but-unresumable: shown, disabled,
//   never spawned.
async function resolveChat(sessionId) {
  const found = await findTranscriptAny(sessionId);
  if (!found) return { resumable: false, cwd: null, agent: DEFAULT_AGENT, reason: 'no-transcript' };
  const { agent, transcriptPath } = found;
  const cwd = await agentById(agent).transcriptCwd(transcriptPath);
  if (!cwd) return { resumable: false, cwd: null, agent, reason: 'no-cwd' };
  try { if (!(await fs.promises.stat(cwd)).isDirectory()) return { resumable: false, cwd, agent, reason: 'cwd-gone' }; }
  catch { return { resumable: false, cwd, agent, reason: 'cwd-gone' }; }
  return { resumable: true, cwd, agent, reason: null };
}

// Parse a claude transcript's jsonl into spoken turns. Re-exported from the
// claude adapter so the standalone arg/parse tests keep a stable import; the
// live read path (readTranscript) parses with whichever agent actually owns the
// transcript.
export function parseTranscriptMessages(raw, after = 0) {
  return agentById('claude').parseTranscript(raw, after);
}

// Read a session's transcript as parsed spoken turns. `after` is the previous
// read's cursor (0 = from the start). Works for ANY session ANY agent ran on
// this machine — the transcript is found across every adapter's store and
// parsed with that agent's schema. Reading is deliberately unrestricted
// (transcripts are world-visible context for agents); only WRITING is gated on
// the issue link.
export async function readTranscript(sessionId, after = 0) {
  const found = await findTranscriptAny(sessionId);
  if (!found) return null;
  let raw;
  try { raw = await fs.promises.readFile(found.transcriptPath, 'utf8'); } catch { return null; }
  const live = globalThis.__labChats.get(sessionId);
  const parsed = agentById(found.agent).parseTranscript(raw, after);
  return { sessionId, agent: found.agent, live: !!live && !live.exited, ...parsed };
}

// Deliver a message INTO a chat — the write half of agent-to-agent dialog.
// Gated on the session being linked to the issue's conversations[] so only
// real issue chats are addressable (an arbitrary uuid — e.g. the main chat's
// rolling session — can't be woken as a second process on a live transcript).
// Two delivery routes, mirroring how a human would do it:
//   live PTY  → bracketed-paste the text + Enter, exactly like typing into the
//               attached terminal. A mid-turn chat queues it (claude queues
//               user input during a turn) — same single code path either way.
//   dead chat → resume-spawn the session with the message as its first turn
//               (buildChatArgs resume+prompt), into the chats map so the dash
//               reattaches/watches it like any live chat.
// A settle beat between paste and Enter: bracketed paste has NO acknowledgement
// signal, so there is no deterministic "paste accepted" to wait on — this delay
// only gives claude's input loop time to render the paste before the submit
// keystroke. Correctness (no interleaving, no double-spawn) comes from the
// per-session delivery chain below, not from this number.
const PASTE_SETTLE_MS = 300;

// In-flight delivery chains, per session. Delivery serializes ROUTE SELECTION
// and the write together: without this, two concurrent sends to a dead chat
// both miss the live map, both resolveChat, and both resume-spawn — two claude
// processes on one transcript (the cross-server collision, reproduced inside
// one process). Inside the chain the live check re-runs, so the second send
// lands as typed input in whatever PTY the first one spawned.
const deliveries = new Map(); // sessionId → tail promise of the chain

export async function deliverMessage({ issueId, sessionId, text }) {
  // Control characters (beyond \n and \t) are rejected outright: an embedded
  // ESC could terminate the bracketed paste early and turn message content
  // into keystrokes — framing must be unforgeable, not escaped-on-best-effort.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
    return { ok: false, status: 400, error: 'control characters not allowed in message text' };
  }
  let row = null;
  try {
    const { get } = await import('./issues-store.mjs');
    row = await get(issueId);
  } catch (e) { return { ok: false, status: 500, error: `issue lookup failed: ${e.message}` }; }
  if (!row) return { ok: false, status: 404, error: `no such issue "${issueId}"` };
  // conversations[] entries carry an agent prefix (formatHandle) — match on the
  // parsed session id, not the raw entry, so a codex chat (`codex:<uuid>`) is
  // addressable by its bare uuid exactly like a claude one.
  const linked = Array.isArray(row.conversations)
    && row.conversations.some(h => parseHandle(h).sessionId === sessionId);
  if (!linked) return { ok: false, status: 404, error: `session not linked to issue "${issueId}"` };

  const tail = deliveries.get(sessionId) || Promise.resolve();
  const run = tail.then(() => routeAndDeliver({ issueId, sessionId, text }));
  const settled = run.then(() => {}, () => {});
  deliveries.set(sessionId, settled);
  try {
    return await run;
  } finally {
    if (deliveries.get(sessionId) === settled) deliveries.delete(sessionId);
  }
}

async function routeAndDeliver({ issueId, sessionId, text }) {
  const session = chats.get(sessionId);
  if (liveSession(session)) {
    // Paste-then-Enter, exactly like typing into the attached terminal.
    session.pty.write(`\x1b[200~${text}\x1b[201~`);
    await new Promise(r => setTimeout(r, PASTE_SETTLE_MS));
    if (!session.exited) session.pty.write('\r');
    // The cursor at delivery: `read --after <cursor> --wait` from here skips
    // all history INCLUDING the just-injected turn and wakes on what follows
    // (the reply). Delivery means "queued into the chat like typed input" —
    // a busy agent picks it up when its current turn ends.
    const cursor = (await readTranscript(sessionId))?.cursor ?? 0;
    return { ok: true, delivered: 'pty', sessionId, cursor };
  }

  const r = await resolveChat(sessionId);
  if (!r.resumable) return { ok: false, status: 409, error: `chat not deliverable (${r.reason})` };
  // An agent already running on this session ANYWHERE on this machine — most
  // often inside ANOTHER dev server's PTY map, invisible to ours — makes a
  // resume-spawn a FORK: two processes appending to one transcript. Refuse and
  // name the condition; the sender must route through the owning server. (The
  // single-broker redesign that removes this class entirely is i-chat-collision.)
  if (await sessionProcessAlive(sessionId)) {
    return { ok: false, status: 409, error: 'session is live in another server process — send via the server that owns it' };
  }
  const cursor = (await readTranscript(sessionId))?.cursor ?? 0;
  // Resume under the agent whose store the transcript was found in — a claude
  // uuid resumes with claude, a codex uuid with `codex resume`.
  spawnChat({ issueId, sessionId, mode: 'resume', cwd: r.cwd, cols: 100, rows: 30, initialPrompt: text, key: sessionId, agent: r.agent });
  return { ok: true, delivered: 'resume', sessionId, cursor };
}

// --- Git sync (the board's GitHub-Desktop-style sync button) ---
// All sync git runs against the MAIN checkout (never a worktree) — the board
// represents main, and the primary checkout always sits on it. LAB_MAIN_REPO
// (set by tests) already redirects MAIN_REPO at module load, so these hit the
// hermetic scratch repo under test.
function gitMain(args) {
  return run('git', ['-C', MAIN_REPO, ...args]);
}

// The most-recently-spawned live main-chat PTY, or null. Main chats are uuid-
// keyed like any other now (no single MAIN_ENV key), so find the newest live
// session whose env is main — that's the one the human is most likely looking at.
function liveMainSession() {
  let found = null;
  for (const s of chats.values()) {
    if (liveSession(s) && s.issueId === MAIN_ENV) found = s; // last wins = newest
  }
  return found;
}

// Paste a message into the live main chat PTY, exactly like typed input (the
// same bracketed-paste + Enter deliverMessage uses). No-op if no main chat has a
// live process — the board still surfaces the conflict, so a dormant main chat
// never blocks a sync. Returns whether it landed.
async function deliverToMainChat(text) {
  const session = liveMainSession();
  if (!session) return false;
  session.pty.write(`\x1b[200~${text}\x1b[201~`);
  await new Promise(r => setTimeout(r, PASTE_SETTLE_MS));
  if (!session.exited) session.pty.write('\r');
  return true;
}

// main vs origin/main after a fetch: how many commits each is ahead of the
// other, plus whether the tree is dirty. `rev-list --left-right --count
// origin/main...HEAD` → [behind, ahead] (left = origin-only, right = HEAD-only).
export async function gitSyncStatus({ fetch = true } = {}) {
  if (fetch) await gitMain(['fetch', 'origin', '--quiet']);
  const branch = (await gitMain(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const hasRemote = (await gitMain(['rev-parse', '--verify', '--quiet', 'origin/main'])).status === 0;
  let ahead = 0, behind = 0;
  if (hasRemote) {
    const counts = (await gitMain(['rev-list', '--left-right', '--count', 'origin/main...HEAD'])).stdout.trim();
    const m = counts.split(/\s+/).map(n => parseInt(n, 10) || 0);
    behind = m[0] || 0; ahead = m[1] || 0;
  }
  const dirty = (await gitMain(['status', '--porcelain'])).stdout.trim().length > 0;
  return { ok: true, branch, ahead, behind, dirty, hasRemote };
}

// One-click sync: fast-forward main to origin/main if behind, then push if
// ahead. A divergence that can't fast-forward (or a push rejected because the
// remote moved mid-sync) is NOT auto-resolved — it drops a note into the main
// chat and reports { conflict:true } so the board flags it and the human (or the
// main-chat agent) resolves it. Never touches a worktree; refuses if the primary
// isn't on main.
export async function gitSync() {
  const st = await gitSyncStatus();
  if (st.branch !== 'main') {
    return { ...st, ok: false, conflict: false, error: `primary checkout is on '${st.branch}', not main` };
  }
  if (!st.hasRemote) return { ...st, ok: false, conflict: false, error: 'no origin/main to sync against' };

  let pulled = 0, pushed = 0;
  if (st.behind > 0) {
    const pull = await gitMain(['merge', '--ff-only', 'origin/main']);
    if (pull.status !== 0) {
      const msg = `⚠️ Git sync couldn't fast-forward: main and origin/main have diverged (${st.ahead} ahead, ${st.behind} behind). Pull origin/main, resolve the conflicts, and push — then the board's sync will be clean again.`;
      const delivered = await deliverToMainChat(msg);
      return { ...st, ok: false, conflict: true, delivered, pulled, pushed };
    }
    pulled = st.behind;
  }

  const mid = await gitSyncStatus({ fetch: false });
  if (mid.ahead > 0) {
    const push = await gitMain(['push', 'origin', 'main']);
    if (push.status !== 0) {
      // A push rejected here means origin moved between our fetch and push — a
      // race, not a merge conflict. Surface it the same way: note + report.
      const msg = `⚠️ Git sync push was rejected — origin/main moved. Pull, resolve if needed, and push again.`;
      const delivered = await deliverToMainChat(msg);
      return { ...mid, ok: false, conflict: true, delivered, pulled, pushed, error: push.stderr.trim() };
    }
    pushed = mid.ahead;
  }

  const final = await gitSyncStatus({ fetch: false });
  return { ...final, ok: true, pulled, pushed };
}

// Is an agent process for this session running anywhere on this machine? The
// session uuid appears in the CLI's argv (claude: `--session-id <uuid>` /
// `--resume <uuid>`; codex: `resume <uuid>`), so a process-table match on those
// exact patterns is a deterministic identity check — not a name heuristic.
// Excludes bystanders whose argv merely mentions the uuid (activity-monitor
// hooks, greps). The pattern is the UNION across agents (liveArgvPatternAny) so
// one check covers whichever CLI owns the session.
export async function sessionProcessAlive(sessionId) {
  // '--' ends pgrep's own option parsing — the pattern starts with a dash.
  const r = await run('pgrep', ['-f', '--', liveArgvPatternAny(sessionId)]);
  // FAIL CLOSED: pgrep exits 0 on match, 1 on no-match; anything else (or a
  // spawn error) means we could not verify — treat as alive and refuse the
  // resume rather than risk forking a session we couldn't see.
  if (r.error || (r.status !== 0 && r.status !== 1)) return true;
  return r.status === 0;
}

// The tracked chat handles for an environment. An issue reads its shared
// Supabase conversations[]; MAIN reads the machine-local main-chats store. Both
// return the same agent-prefixed handle format (formatHandle), so every caller
// downstream treats an issue and main identically.
async function chatHandlesFor(env) {
  if (env === MAIN_ENV) return mainChatsList();
  const { get } = await import('./issues-store.mjs');
  const row = await get(env).catch(() => null);
  return Array.isArray(row?.conversations) ? row.conversations : [];
}

// Link a chat to an environment, encoding its agent in the handle (bare uuid =
// claude, `codex:<uuid>` = codex — see formatHandle). Issue chats append to the
// shared Supabase conversations[]; MAIN appends to the machine-local store. ONE
// entry per call (both append paths de-dupe).
async function linkChat(env, sessionId, agent = DEFAULT_AGENT) {
  const handle = formatHandle(agent, sessionId);
  if (env === MAIN_ENV) return linkMainChat(handle);
  const { appendToArray } = await import('./issues-store.mjs');
  return appendToArray(env, 'conversations', [handle]);
}

// Reserve a stable dev-server port for the issue (idempotent — re-opening an
// issue that already has one reuses it). Called whenever the worktree is
// ensured, so the port exists by the time the issue-detail link is rendered.
// Best-effort: a Supabase blip shouldn't block making the worktree/chat.
async function reservePort(issueId) {
  try {
    const { allocatePort } = await import('./ports.mjs');
    return await allocatePort(issueId);
  } catch (e) { return { error: e.message }; }
}

// The issue's title + board status, for the new-chat intro message. Best-effort:
// a missing row or Supabase blip yields nulls and the intro falls back to
// id-only. Status matters so a new chat doesn't re-implement an already-done
// issue (a chat opened on a `done`/`rejected` card should treat it as closed).
async function issueMeta(issueId) {
  try {
    const { get } = await import('./issues-store.mjs');
    const row = await get(issueId);
    return { title: row?.title || null, status: row?.status || null };
  } catch { return { title: null, status: null }; }
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

async function branchExists(issueId) {
  return (await git(['show-ref', '--verify', '--quiet', `refs/heads/${issueId}`])).ok;
}

// Create the issue's worktree if absent, reusing whatever already exists:
//   - dir present                 → reuse (no-op)
//   - branch present, no worktree  → `git worktree add <dir> <issueId>`
//   - neither                      → `git worktree add <dir> -b <issueId>` off main
// After creating a NEW branch we make an initial empty commit so the branch tip
// DIVERGES from main. Without it, a fresh branch's tip == main's tip, which reads
// as "already merged" — so /merge's `git branch -d` would happily delete a branch
// that never landed any work. The empty commit is the day-one guard that keeps a
// brand-new issue worktree distinct from main.
export async function ensureWorktree(issueId) {
  const dir = worktreeDir(issueId);
  if (hasWorktree(issueId)) return { ok: true, dir, created: false };

  await fs.promises.mkdir(path.dirname(dir), { recursive: true });

  let res;
  let madeNewBranch = false;
  if (await branchExists(issueId)) {
    res = await git(['worktree', 'add', dir, issueId]);
  } else {
    // Branch from local main/master, falling back to the origin refs.
    let base = 'HEAD';
    for (const ref of ['main', 'master', 'origin/main', 'origin/master']) {
      if ((await git(['rev-parse', '--verify', '--quiet', ref])).ok) { base = ref; break; }
    }
    res = await git(['worktree', 'add', dir, '-b', issueId, base]);
    madeNewBranch = res.ok;
  }

  if (!res.ok) {
    // Don't leave a half-made worktree: prune any registration git may have
    // recorded before failing, and remove a stray dir.
    await git(['worktree', 'prune']);
    try { if (hasWorktree(issueId)) await fs.promises.rm(dir, { recursive: true, force: true }); } catch {}
    return { ok: false, error: res.err || 'git worktree add failed' };
  }

  if (madeNewBranch) {
    const c = await run('git', ['-C', dir, 'commit', '--allow-empty', '-m', `wip: open issue ${issueId}`]);
    if (c.status !== 0) {
      return { ok: false, error: `worktree created but initial commit failed: ${c.stderr.trim()}` };
    }
  }

  return { ok: true, dir, created: true };
}

// --- per-issue dev server (lazy-start) ---
//
// Each issue's worktree has a STABLE dev-server port reserved at worktree-
// create time (persisted on the issue row — see ports.allocatePort). We
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
// long-lived child bound to the worktree. /merge (and /reject) SIGTERM it when
// they tear the worktree down.
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
// LISTEN state). Lets us restart a dev server we don't track (one adopted via
// portInUse from a prior Dash-server lifetime, so devServers has no entry for it).
export async function devServerListenerPids(port) {
  const r = await run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']);
  return r.stdout.split('\n').map(s => parseInt(s.trim(), 10)).filter(Boolean);
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
  for (const pid of await devServerListenerPids(port)) {
    if (pid === process.pid) continue;
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }

  await waitForPortFree(port);
  // If SIGTERM didn't free it in time, escalate so the strictPort respawn can
  // bind instead of silently reusing the old server.
  if (await portInUse(port)) {
    for (const pid of await devServerListenerPids(port)) {
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

// Report an environment's workspace + chats for the client, reflecting its REAL
// recorded state rather than a name-guessed path. For an issue the workspace is
// its worktree (the `<issueId>` dir or a recorded branch's worktree); for MAIN it
// is the repo root, always present. Each chat is resolved by finding its
// transcript anywhere under ~/.claude/projects and reading the cwd it actually
// ran in. A chat is resumable iff EITHER a live PTY for it is
// already running in this process OR its transcript exists and the cwd it ran in
// still exists on disk — independent of which worktree the issue "should" have.
// The live-PTY case matters for a freshly-spawned autonomous chat: its session
// is linked and its PTY is running before claude writes the first transcript
// line, so a transcript-only check would (briefly) call it unresumable and the
// board's auto-attach would skip it and never retry. attachChat reattaches to a
// live PTY without touching the transcript, so reporting it resumable is honest.
export async function issueChats(env) {
  // Each handle carries its agent as a prefix (formatHandle); the bare session
  // uuid is what the PTY map, registry and transcript stores key on, and `agent`
  // rides through to the client for the per-chat type badge. Handles come from
  // the shared issue row for an issue, or the machine-local store for MAIN.
  const conversations = (await chatHandlesFor(env)).map(parseHandle);
  // MAIN's workspace is the repo root — always present; an issue's is its
  // worktree dir (null until created).
  const isMain = env === MAIN_ENV;
  const dir = isMain ? MAIN_REPO : resolveWorktreeDir(env);
  // Resolve conversations SEQUENTIALLY, not via Promise.all: board-load already
  // mounts in-progress issues a couple at a time, and each unresolved transcript
  // is a full transcript-store scan. Resolving an issue's convos one-by-one
  // keeps the in-flight scan count bounded by the issue throttle (≈2) rather than
  // 2 × convos-per-issue. A live PTY short-circuits the scan entirely.
  const live = globalThis.__labChats;
  const chats = [];
  for (const { sessionId, agent } of conversations) {
    const session = live?.get(sessionId);
    if (liveSession(session)) { chats.push({ sessionId, agent, resumable: true, live: true, cwd: null }); continue; }
    // Live in ANOTHER dash server on this machine counts as live too — the
    // attach path redirects there, so reporting it resumable+live is honest,
    // and reporting it dormant would invite the duplicate cold resume.
    const owner = await liveChatOwner(sessionId);
    if (owner && owner.pid !== process.pid) { chats.push({ sessionId, agent, resumable: true, live: true, cwd: null }); continue; }
    const { resumable, cwd } = await resolveChat(sessionId);
    chats.push({ sessionId, agent, resumable, live: false, cwd });
  }
  return { worktree: !!dir, dir, chats };
}

// The LIVE (non-exited) PTYs in this process as { issue, session } pairs — read
// straight from the in-memory chats map, no fs, no spawn. This is what
// board-load auto-attach seeds from: "chats that exist server-side but were
// never opened this session" reattach cheaply, whereas cold-resuming a dormant
// chat just to compute a dot would both stampede the server and silently
// resurrect a finished conversation. The SESSION is the unit (issue↔chat links
// are many-to-many); `issue` is only the issue the PTY was spawned under — the
// client re-resolves it against the issues that currently link the session, so
// an unlinked origin doesn't strand a live chat. Main chat excluded (not a card).
async function liveSessionChats() {
  const live = globalThis.__labChats;
  const out = [];
  if (live) for (const s of live.values()) {
    if (liveSession(s) && s.issueId && s.issueId !== MAIN_ENV) out.push({ issue: s.issueId, session: s.sessionId });
  }
  // Merge chats hosted by OTHER live dash servers on this machine (the
  // registry), as the same { issue, session } pairs — the board must see
  // machine-wide liveness, or its auto-attach skips a chat that is very much
  // running (on another dev server) and later cold-resumes a duplicate. The
  // client re-resolves each pair's issue against the rows that link the session,
  // exactly as it does for local pairs, so a foreign entry needs no special
  // handling downstream. Dedupe by session so a chat that is somehow both local
  // and registry-listed isn't emitted twice.
  const seen = new Set(out.map((p) => p.session));
  let files = [];
  try { files = await fs.promises.readdir(registryDir()); } catch {}
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const owner = await liveChatOwner(f.slice(0, -5));
    if (owner && owner.pid !== process.pid && owner.issueId && owner.issueId !== MAIN_ENV
        && owner.sessionId && !seen.has(owner.sessionId)) {
      seen.add(owner.sessionId);
      out.push({ issue: owner.issueId, session: owner.sessionId });
    }
  }
  return out;
}

// --- live PTYs, keyed by SESSION ID ---

// Each session: { pty, issueId, buffer:[], cols, rows, attached:Set<ws>,
// geomOwner:ws|null, exited, shape }. Any number of sockets may attach (output
// is broadcast); the PTY grid belongs to the socket that last asserted one
// (sent a resize) — never to a socket merely for attaching.
// Lives on globalThis so Vite HMR re-evaluating this module doesn't orphan
// running PTYs (they'd leak / double-spawn).
if (!globalThis.__labChats) globalThis.__labChats = new Map();
const chats = globalThis.__labChats;

// Because the map survives module re-evaluation, its entries may have been
// created by a PREVIOUS VERSION of this module — session objects shaped for
// contracts this version no longer honors. That is how the dash died twice on
// 2026-07-09 (issue i-chat-attach-crash): post-multi-attach code called .add
// on a pre-multi-attach survivor's `attached: null`. Every session therefore
// carries this shape stamp — bump it whenever the session object's contract OR
// its KEYING changes — and module evaluation retires survivors whose stamp
// differs (see the retirement sweep by the shutdown path below). Exported for
// tests. Bumped to 3 for the main-chat unification: main used to be keyed by the
// MAIN_ENV sentinel and this version keys it by session uuid, so a live pre-
// unification main singleton (a shape-2 survivor the new code can no longer
// address) must be RETIRED on the HMR eval — leaving it would strand a --continue
// process the uuid path can't see, double-resuming main.
export const CHAT_SHAPE = 3; // 1: single-socket (unstamped); 2: multi-attach Set + geomOwner; 3: main uuid-keyed (retires the MAIN_ENV singleton)

// A map entry this module version may reuse: live AND stamped by this version.
// A foreign-shape survivor is never touched by live paths — it gets retired
// and the chat cold-resumes from its transcript. Both predicates contain
// their property reads: a foreign object's contract is unknown, so even a
// throwing getter must classify it (as not-reusable / foreign) rather than
// let the exception reach a caller with no frame — the module-eval sweep in
// particular would abort the whole config load.
const liveSession = (s) => {
  try { return !!s && !s.exited && s.shape === CHAT_SHAPE; } catch { return false; }
};
const foreignSession = (s) => {
  try { return !!s && s.shape !== CHAT_SHAPE; } catch { return true; }
};

// --- machine-local live-chat registry ---
//
// PTY liveness must be MACHINE-scoped, not process-scoped: transcripts live on
// shared disk, so ANY dash dev server can `--resume` any session — without a
// shared source of truth, two servers happily run the same chat twice and the
// copies race each other (issue i-chat-collision). Each live PTY is recorded
// as <registry>/<key>.json = { pid, port, issueId, sessionId, startedAt } —
// key = the PTY map key (session uuid, or the `main` sentinel). Written as an
// O_EXCL claim before the PTY spawns (claimChat), removed on PTY exit. An entry
// is live iff its pid is alive (kill(pid, 0)); a dead pid is a crashed server's
// leftover, which claimChat deliberately does NOT auto-reclaim (see its comment
// for why that can't be race-free) — recovery is out-of-band, and the attach
// path surfaces an honest stale-record error. The in-flight agent-chat write path
// (deliverMessage) should consult liveChatOwner before its own resume-spawn when
// it lands. LAB_CHAT_REGISTRY_DIR overrides the location so tests never touch the
// real registry. Read lazily (not a module const) so test files with static
// imports can still set the env first.
function registryDir() {
  return process.env.LAB_CHAT_REGISTRY_DIR || path.join(os.homedir(), '.claude', 'dash-live-chats');
}

// The registry FILENAME for a chat map-key. A chat map-key is untrusted — the
// session id rides in on a WebSocket query param — so it MUST be validated
// before it can name a file, or `session=../foo` escapes the registry dir and
// unlinks arbitrary `.json` files (path traversal). The only legal shape is a
// uuid: every chat — issue AND main — is keyed by its session uuid, so there is
// no sentinel key anymore. Any other shape returns null → every fs helper below
// no-ops for it.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function regPath(key) {
  if (typeof key === 'string' && UUID_RE.test(key)) return path.join(registryDir(), `${key}.json`);
  return null; // unsafe / unknown key — never touch the filesystem
}

// Atomic overwrite: write a temp file and rename it into place (rename is
// atomic on a single filesystem). A concurrent reader therefore never observes
// a half-written record it could mistake for corruption. The temp name carries
// our pid so two processes writing the same key don't collide on the temp.
function atomicWrite(p, data) {
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  try { fs.renameSync(tmp, p); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}

function pidAlive(pid) {
  // EPERM means the process EXISTS but isn't ours to signal — alive. Only
  // ESRCH (and bad input) mean gone.
  try { process.kill(pid, 0); } catch (e) { return e.code === 'EPERM'; }
  // The pid exists — but a DEFUNCT (zombie) process is a dead process awaiting
  // reaping by its parent: it holds no port and owns no chat. process.kill(0)
  // can't see the difference (the pid lingers in the table), and `ps -o lstart`
  // still reports its start time, so the recycled-pid guard passes too — which
  // is exactly how a CRASHED dash server that was never reaped gets mistaken
  // for a live owner, redirecting every chat it held to its since-rebound port
  // forever. A zombie reads as GONE (deterministic OS signal: ps state 'Z').
  return !pidIsZombie(pid);
}

// Is `pid` a DEFUNCT (zombie) process? Only meaningful for a pid that already
// exists (callers gate on process.kill first). Fail-safe: a ps hiccup can't
// disprove liveness, so an unreadable/failed probe is treated as NOT-zombie —
// mis-reading a live owner as gone would authorize a duplicate agent.
function pidIsZombie(pid) {
  try {
    const r = spawnSync('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8' });
    if (r.status !== 0) return false;
    return (r.stdout || '').trim().toUpperCase().startsWith('Z');
  } catch { return false; }
}

// A process's OS start time (`ps -o lstart`), the deterministic half of process
// identity that survives pid reuse: a recycled pid names a DIFFERENT process
// with a later start time. Comparing it defeats the "dead owner's pid got
// reused by an unrelated live process" false-positive that pid-liveness alone
// can't see. Async (per-action verify paths await it); null if ps fails.
async function pidStartTime(pid) {
  const r = await run('ps', ['-o', 'lstart=', '-p', String(pid)]);
  return r.status === 0 ? r.stdout.trim() || null : null;
}
// Synchronous variant for the CLAIM path only: claimChat (and the staleness
// checks it runs) must stay claim+spawn-in-a-single-tick — an await inside
// would open the in-process double-claim window. Claims/reclaims are rare,
// user-action-paced events; the board-poll paths use the async one above.
function pidStartTimeSync(pid) {
  try {
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
    return r.status === 0 ? (r.stdout || '').trim() || null : null;
  } catch { return null; }
}
// OUR OWN start time stays a cached synchronous one-shot: claimChat must run
// claim+spawn in a single tick (an await inside it would open an in-process
// double-claim window), and one ~20ms spawnSync once per process lifetime is
// the deliberate cost of that atomicity.
let _selfStart = undefined;
function selfStartTime() {
  if (_selfStart === undefined) _selfStart = pidStartTimeSync(process.pid);
  return _selfStart;
}

// Is this registry record OUR OWN — by full identity, pid AND recorded start
// time? Bare pid equality is not ownership: a dead server's pid can be
// recycled into THIS very process, and treating its leftover as ours would
// re-stamp/unlink a record whose stamped claude child may still be alive —
// the exact double-resume the identity contract exists to prevent. Fail-safe
// like processMatches: a record with NO startTime is accepted on pid alone.
// That exception is deliberate, not an oversight — our own records carry
// startTime: null whenever ps fails at stamp time, and refusing them would
// strand our own claims (we could never re-stamp or release them). The cost:
// a legacy no-startTime record whose dead owner's pid was recycled into this
// process reads as ours — a triple coincidence (legacy record × pid recycled
// × onto this exact process) accepted over stranding real claims on a ps
// hiccup.
function isOwnClaim(entry) {
  return !!entry && entry.pid === process.pid
    && (!entry.startTime || entry.startTime === selfStartTime());
}

// The HTTP port THIS server answers on — wired from vite once the http server
// binds (setDashPort below). Registry entries carry it so another server can
// redirect an attach to the owner. null until known.
let dashPort = null;
export function setDashPort(port) {
  dashPort = port;
  // A server coming up is the natural moment to sweep the whole registry for
  // records stranded by stopped/crashed servers, so every card on the board is
  // attachable again without waiting for its individual open.
  sweepStaleClaims();
  // Re-stamp entries claimed before the port was known (a spawn can precede
  // the bind), so their redirect target isn't permanently null.
  for (const [key, s] of chats) {
    if (liveSession(s)) claimChat(key, s.issueId, s.sessionId);
  }
}

// The live owner of a chat key anywhere on this machine, or null. PURE — it
// never deletes anything, so it can't race a concurrent claim by unlinking a
// live entry it read as stale. `verify` enforces full process identity (pid
// alive AND start time matches) to defeat pid reuse; it's set on the
// redirect/claim decision paths and left off on the cheap board-poll reporting
// paths, where a brief false-positive only shows a stale dot and never spawns.
// An unsafe key → no path → nobody's.
export async function liveChatOwner(key, { verify = false } = {}) {
  const p = regPath(key);
  if (!p) return null;
  let entry = null;
  try { entry = JSON.parse(await fs.promises.readFile(p, 'utf8')); } catch {}
  // A `released` record is a graceful stop's parting note (owner relinquished,
  // claude child possibly still dying) — nobody to redirect to.
  if (!entry || entry.released === true || !Number.isInteger(entry.pid) || !pidAlive(entry.pid)) return null;
  if (isOwnClaim(entry)) return entry; // ourselves (full identity) — no ps needed
  if (verify && entry.startTime) {
    // Defeat pid reuse — but FAIL SAFE: only a DEFINITIVE start-time mismatch
    // (ps succeeded and disagrees) disowns the entry. A null (ps failed, e.g.
    // transient under concurrent load) can't disprove ownership, so we keep the
    // owner — mis-reading a live owner as gone would authorize a duplicate.
    const st = await pidStartTime(entry.pid);
    if (st !== null && st !== entry.startTime) return null; // recycled pid — different process
  }
  return entry;
}

// Does this pid name the SAME process the record described? Deterministic
// process identity: alive, and (when the record carries one) the OS start time
// agrees — a recycled pid names a different process with a later start time.
// FAIL SAFE like liveChatOwner: a null start time (ps failed) can't disprove
// identity, so the process is treated as matching.
function processMatches(pid, startTime) {
  if (!Number.isInteger(pid) || !pidAlive(pid)) return false;
  if (startTime) {
    // Self-pid compares against our cached start time — a recycled pid can
    // land on THIS process too, and bare pid equality must never vouch for a
    // record another process wrote.
    const st = pid === process.pid ? selfStartTime() : pidStartTimeSync(pid); // claim-path check — must stay single-tick
    if (st !== null && st !== startTime) return false;
  }
  return true;
}

// Is a well-formed registry entry a stranded leftover that can be reclaimed?
// TWO processes must be provably gone, and both are checked by exact identity
// (pid + start time):
//   • the dash OWNER — dead/recycled pid, or it marked the record `released`
//     on its way down (a graceful stop whose claude hadn't finished dying);
//   • the claude CHILD the record stamped (ptyPid) — the process that actually
//     holds the session. This is what keeps a dead dash's still-running claude
//     from being double-resumed.
// A record with a gone owner but a LIVE child is an orphan: not stale, never
// reclaimed — the attach surfaces the child pid instead.
//
// A record with NO child stamped (owner died in the microseconds between the
// pre-spawn claim and the post-spawn re-stamp) is reclaimable for an ISSUE
// session — its cold RESUME is additionally pgrep-gated (sessionProcessAlive),
// which catches any surviving child. Main records FAIL CLOSED (not reclaimed):
// a main chat's identity is still the raw session uuid, which `/clear` can
// mutate, and the `new`-spawn path is not pgrep-gated — so we keep the pre-
// existing conservative margin (a rare manual-recovery sliver) rather than risk
// reclaiming a still-live main thread. The durable fix is a stable chat id
// decoupled from the mutable session uuid (a follow-up redesign).
function claimIsStale(entry) {
  const ownerGone = entry.released === true || !processMatches(entry.pid, entry.startTime);
  if (!ownerGone) return false;
  if (Number.isInteger(entry.ptyPid)) return !processMatches(entry.ptyPid, entry.ptyStartTime);
  return entry.issueId !== MAIN_ENV;
}

// The live claude child of a key whose dash owner is gone, or null. Read-only;
// feeds the attach path's honest "still running" message for orphaned chats.
function claimOrphanPid(key) {
  const p = regPath(key);
  if (!p) return null;
  let e = null;
  try { e = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  if (!e || !Number.isInteger(e.pid)) return null;
  const ownerGone = e.released === true || !processMatches(e.pid, e.startTime);
  if (ownerGone && Number.isInteger(e.ptyPid) && processMatches(e.ptyPid, e.ptyStartTime)) return e.ptyPid;
  return null;
}

// Does this tomb hold a claim that is still LIVE (its processes not provably
// gone)? Tomb semantics hang on the CONTENT, not the reclaimer: a live
// displaced claim owns its key and must be preserved/restored; a stale (or
// unreadable) one never needs restoring and is discardable by ANY process —
// the owning reclaimer's reads and unlinks all tolerate ENOENT. Content-based
// settling is what makes yielding livelock-free: claimants only ever stand
// down while the displaced owner is genuinely alive, and the moment it exits
// the tomb becomes garbage anyone clears.
function tombHoldsLiveClaim(tombPath) {
  let entry = null;
  try { entry = JSON.parse(fs.readFileSync(tombPath, 'utf8')); } catch {}
  return !!entry && Number.isInteger(entry.pid) && !claimIsStale(entry);
}

// Restore a displaced LIVE claim from its tomb into the base path. Retries on
// EEXIST: a cooperative claimant that slipped into the path yields on its own
// stand-down check within a beat, and a claim STRANDED there (its claimant
// killed between wx-win and stand-down) is stale and safe to clear — while a
// tomb exists, any new claim is contract-bound to yield, so this unlink can
// only ever hit a stale or already-yielding claim. If the path stays occupied
// by a live claim anyway (a pathological double-owner), the tomb is left for
// a later settle rather than ever clobbering a live claim.
function restoreFromTomb(tombPath, basePath) {
  for (let i = 0; i < 20; i++) {
    try { fs.linkSync(tombPath, basePath); fs.unlinkSync(tombPath); return; }
    catch (e) {
      if (e.code !== 'EEXIST') return; // tomb vanished (another settler finished) or real fs error — stop
      let base = null;
      try { base = JSON.parse(fs.readFileSync(basePath, 'utf8')); } catch {}
      if (base && Number.isInteger(base.pid) && claimIsStale(base)) { try { fs.unlinkSync(basePath); } catch {} }
      else spawnSync('sleep', ['0.05']);
    }
  }
}

// Settle a tomb encountered outside its owning reclaimer (sweep, stand-down).
// Stale content → discard. Live content → restore if the reclaimer died
// mid-operation; a live reclaimer is left to finish its own job. Returns true
// iff a live displaced claim remains outstanding (the key belongs to it).
function settleTomb(tombPath, basePath, reclaimerPid) {
  if (!tombHoldsLiveClaim(tombPath)) {
    try { fs.unlinkSync(tombPath); } catch {}
    return false;
  }
  if (!pidAlive(reclaimerPid)) restoreFromTomb(tombPath, basePath);
  return tombHoldsLiveClaim(tombPath) || fs.existsSync(basePath);
}

// Complete OUR reclaim whose claim file has already been renamed to `tomb`:
// re-verify the displaced entry really is stale and discard it. If it turns
// out LIVE — re-created by its owner between the staleness read and the
// rename, the race that makes a plain unlink unsafe — restore it. Returns
// true iff `basePath` was left free for a fresh wx-create.
function finishReclaim(tomb, basePath) {
  if (tombHoldsLiveClaim(tomb)) { restoreFromTomb(tomb, basePath); return false; }
  try { fs.unlinkSync(tomb); } catch {}
  return true;
}

// After WINNING the wx-create, stand down if a LIVE displaced claim sits in
// any reclaim tomb for this key: its reclaimer's restore must find the base
// path free, or — reclaimer dead — we restore it ourselves. This is the other
// half of what makes lock-free reclaim safe: the delayed-reclaimer race
// (stale read → rename lands on a live replacement) is survivable only
// because no claimant keeps the base path occupied while a live tomb is
// outstanding. Stale-content tombs are just discarded; they never block.
// Returns true iff we kept the claim.
function standDownForTombs(p) {
  const dir = path.dirname(p);
  const base = path.basename(p);
  let files = [];
  try { files = fs.readdirSync(dir); } catch { files = []; }
  const tombs = [];
  for (const f of files) {
    if (!f.startsWith(`${base}.reclaim.`)) continue;
    const m = f.match(/\.reclaim\.(\d+)$/);
    if (m) tombs.push({ path: path.join(dir, f), reclaimerPid: Number(m[1]) });
  }
  if (!tombs.length) return true;
  // Yield BEFORE settling when any live displaced claim exists, so a restore
  // (ours or the reclaimer's) finds the path free.
  const blocking = tombs.some((t) => tombHoldsLiveClaim(t.path));
  if (blocking) { try { fs.unlinkSync(p); } catch {} }
  for (const t of tombs) settleTomb(t.path, p, t.reclaimerPid);
  return !blocking;
}

// Reclaim a stale claim file race-free WITHOUT a lock: atomically rename it to
// a private tomb (exactly one renamer can win; a concurrent reclaimer gets
// ENOENT and loses cleanly), then verify-and-discard in the tomb. After a true
// reclaim the base path is absent, so ownership still flows through the
// wx-create — reclaim never grants the key, it only clears a dead owner's
// wreckage out of the way.
function reclaimStaleClaim(p) {
  const tomb = `${p}.reclaim.${process.pid}`;
  try { fs.renameSync(p, tomb); } catch { return false; } // lost the reclaim race — not ours to clear
  return finishReclaim(tomb, p);
}

// Sweep the whole registry for stranded records (dead or provably-recycled
// pids) and leftover tombs from reclaimers that died mid-reclaim. Run at
// server startup: after a dash stop/crash every chat it hosted is stranded at
// once, and the sweep makes them all attachable again in one pass instead of
// one error per card open. Live foreign records, our own records, and files
// that aren't records are untouched.
function sweepStaleClaims() {
  const dir = registryDir();
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return; }
  for (const f of files) {
    const full = path.join(dir, f);
    const tomb = f.match(/^(.+)\.reclaim\.(\d+)$/);
    if (tomb) {
      // Settle leftover tombs: discard stale contents, restore a displaced
      // live claim whose reclaimer died mid-operation.
      settleTomb(full, path.join(dir, tomb[1]), Number(tomb[2]));
      continue;
    }
    if (!f.endsWith('.json')) continue;
    let entry = null;
    try { entry = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
    if (!entry || !Number.isInteger(entry.pid) || isOwnClaim(entry)) continue;
    if (claimIsStale(entry)) reclaimStaleClaim(full);
  }
}

// Claim machine-wide ownership of a chat key before spawning its PTY. Returns
// true only if THIS process now holds the key; false means someone else owns it
// (caller must not spawn) OR the claim could not be made durable — it FAILS
// CLOSED, because a registry we can't write can't stop a duplicate.
//
// The rule that makes a duplicate IMPOSSIBLE: ownership is only ever granted by
// `wx`-creating an ABSENT claim (O_EXCL — exactly one winner) or re-stamping
// our OWN. A foreign LIVE claim makes us fail closed (the caller redirects). A
// foreign STALE claim — its owner pid dead, or provably a different process
// (issue i-stale-chat-records: every dash stop used to strand its chats' records)
// — is cleared via reclaimStaleClaim's atomic rename-to-tomb, then the claim
// retries through the same wx gate as everyone else. Two servers cold-resuming
// the same DORMANT session still resolve to one winner; a NEW chat's uuid is
// minted by one server (uncontended).
function claimChat(key, issueId, sessionId) {
  const p = regPath(key);
  if (!p) return false; // unsafe key: refuse rather than write outside the dir
  // Stamp the claude child's identity when the PTY already exists (a post-spawn
  // re-stamp, or setDashPort's port re-stamp): ptyPid + its start time are what
  // let a LATER server verify the session's actual process is gone before it
  // reclaims — a belt-and-suspenders check alongside the pgrep-by-argv gate.
  const live = chats.get(key);
  const ptyPid = liveSession(live) && Number.isInteger(live.pty?.pid) ? live.pty.pid : null;
  const data = JSON.stringify({
    pid: process.pid, port: dashPort, issueId, sessionId,
    startTime: selfStartTime(), startedAt: new Date().toISOString(),
    ptyPid, ptyStartTime: ptyPid ? pidStartTimeSync(ptyPid) : null,
  });
  try { fs.mkdirSync(registryDir(), { recursive: true }); } catch { return false; }

  try { fs.writeFileSync(p, data, { flag: 'wx' }); } // uncontended create — sole winner…
  catch (e) {
    if (e.code !== 'EEXIST') return false; // real fs error — fail closed

    let entry;
    try { entry = JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (re) { return re.code === 'ENOENT' ? claimChat(key, issueId, sessionId) : false; } // vanished → retry; unreadable → fail closed

    if (isOwnClaim(entry)) { try { atomicWrite(p, data); return true; } catch { return false; } } // our own (full identity) — re-stamp
    if (entry && Number.isInteger(entry.pid) && claimIsStale(entry) && reclaimStaleClaim(p)) {
      return claimChat(key, issueId, sessionId); // stranded record cleared — recontend through wx
    }
    return false; // live foreign claim, or an orphan's — never spawn (caller redirects / names the orphan)
  }
  return standDownForTombs(p); // …unless a reclaim is outstanding on this key
}

// Test seam: exercise the claim without spawning a PTY, so the exclusivity
// contract can be pinned deterministically.
export function __claimForTest(key, issueId, sessionId) { return claimChat(key, issueId, sessionId); }

// Remove OUR registry entry for a key (its PTY exited). Only ever unlinks a file
// whose pid is our own, and only our process writes our pid — and Node is
// single-threaded — so no lock is needed and it can never delete another live
// process's claim.
function releaseChat(key) {
  const p = regPath(key);
  if (!p) return;
  try {
    const entry = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (isOwnClaim(entry)) fs.unlinkSync(p);
  } catch {}
}

// Rewrite OUR record for a key as `released`: the graceful-stop parting note
// for a claude child that hadn't finished dying inside the shutdown wait. The
// record keeps the child's identity (ptyPid + start time), so the next server
// reclaims it the moment the child is provably gone — and refuses while it
// lives. Pid-guarded like releaseChat: only our own record is ever rewritten.
function markReleased(key) {
  const p = regPath(key);
  if (!p) return;
  try {
    const entry = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (isOwnClaim(entry)) atomicWrite(p, JSON.stringify({ ...entry, released: true }));
  } catch {}
}

// On the way down, KILL our PTYs and settle their claims synchronously — the
// process exits before any onExit callback would fire, so waiting for the
// PTY-exit release path would strand every record with our soon-dead pid (the
// i-stale-chat-records failure: each dash stop left one stale record per live
// chat). A record is only DELETED once its claude child is verifiably dead
// (bounded sync wait — children die in ms on SIGHUP); a straggler's record is
// rewritten as `released` instead, handing the child's identity to the next
// server so it can wait for the real death rather than double-resume a dying
// session (this is what protects the main chat, which pgrep can't identify).
// A crash that skips this handler entirely leaves a plain dead-pid record for
// the next server's reclaim.
// The claude child OUR OWN registry record stamped for a key, or null. The
// fallback identity when retiring a FOREIGN-shape session: its object fields
// can't be trusted to exist, but the record is ours and can.
function ownClaimPtyPid(key) {
  const p = regPath(key);
  if (!p) return null;
  let e = null;
  try { e = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  return isOwnClaim(e) && Number.isInteger(e.ptyPid) ? e.ptyPid : null;
}

// Kill a set of session entries and settle their claims synchronously — the
// shared mechanics of shutdown and retirement. A record is only DELETED once
// its claude child is verifiably dead (bounded sync wait — children die in ms
// on SIGHUP); a straggler's record is rewritten `released` instead, handing
// the child's identity to the next claimant rather than stranding it.
// Callers own map membership; entries here are just killed and settled.
//
// `trusted: false` marks entries whose object contract is UNKNOWN (foreign-
// shape survivors): every property touch is contained per entry (a hostile
// getter must not abort the sweep — at module eval that would break the whole
// config load), the child pid falls back to our own registry record's stamped
// ptyPid when the object doesn't expose one, and an unidentifiable child is
// marked `released` rather than deleted — the fail-safe hands reclaim to the
// stamped-identity gate instead of asserting a death we couldn't verify.
function killAndSettleClaims(entries, { trusted = true } = {}) {
  const dying = [];
  for (const [key, s] of entries) {
    let child = null;
    try {
      s.exited = true;
      try { s.pty?.kill(); } catch {}
      if (Number.isInteger(s.pty?.pid)) child = s.pty.pid;
    } catch {}
    if (child === null && !trusted) {
      child = ownClaimPtyPid(key);
      // pty.kill had nothing to signal — reach the child via the record.
      if (child !== null) { try { process.kill(child, 'SIGTERM'); } catch {} }
    }
    if (child !== null) dying.push([key, child]);
    else if (trusted) releaseChat(key);
    else markReleased(key);
  }
  const deadline = Date.now() + 1000;
  while (dying.some(([, pid]) => pidAlive(pid)) && Date.now() < deadline) {
    spawnSync('sleep', ['0.05']);
  }
  for (const [key, pid] of dying) {
    if (pidAlive(pid)) markReleased(key);
    else releaseChat(key);
  }
}

let _shuttingDown = false;
function shutdownChats() {
  if (_shuttingDown) return;
  _shuttingDown = true;
  const entries = [...chats];
  chats.clear();
  killAndSettleClaims(entries);
}

// RETIREMENT SWEEP — runs once per module evaluation, i.e. at every vite
// config restart. Survivors in the inherited chats map whose shape stamp
// differs from CHAT_SHAPE were created by another module version: no live
// path may touch them (their object contract is unknown here — the
// i-chat-attach-crash TypeError), so they are killed and their claims settled
// exactly like a graceful shutdown. Retirement is lossless: the transcript is
// on disk, so the next attach cold-resumes the chat right where it was.
// Same-stamp survivors are adopted untouched — their handler closures and
// this module share one object contract.
(function retireForeignShapeSessions() {
  const foreign = [...chats].filter(([, s]) => foreignSession(s));
  if (!foreign.length) return;
  for (const [key] of foreign) chats.delete(key);
  killAndSettleClaims(foreign, { trusted: false });
})();

// SIGTERM/SIGINT (how /merge and /reject kill a dev server) do NOT fire `exit`,
// so they get their own handlers. We do NOT removeAllListeners (that would nuke
// vite's own shutdown handler) — we self-terminate only when we're the sole
// listener (e.g. the test host with no vite). A SIGKILL/crash leaves the claim
// for the next claimant's dead-pid reclaim. Guarded so HMR re-evaluation doesn't
// stack handlers.
if (!globalThis.__labChatsExitHook) {
  globalThis.__labChatsExitHook = true;
  process.on('exit', shutdownChats);
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      shutdownChats();
      if (process.listenerCount(sig) <= 1) process.exit(0); // no vite handler to terminate us
    });
  }
}

// Point a client at whichever server owns the chat. Falls back to an exit
// frame when the owner's port is unknown (it spawned before its port was
// wired) — either way, this server never forks a duplicate.
function redirectToOwner(ws, owner) {
  if (owner?.port) send(ws, { type: 'redirect', port: owner.port });
  else send(ws, { type: 'exit', code: null, error: 'chat is live in another dash server' });
  try { ws.close(1000, 'chat live in another server'); } catch {}
}

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

// Send to every socket attached to the chat (optionally excluding one — the
// pane whose own resize produced a grid frame doesn't need it echoed back).
function broadcast(session, msg, except = null) {
  const data = JSON.stringify(msg);
  for (const ws of session.attached) {
    if (ws !== except && ws.readyState === 1) ws.send(data);
  }
}

// Spawn a `claude` PTY for a chat. `mode` is 'new' (fresh --session-id) or
// 'resume' (--resume an existing uuid). cwd for a NEW chat is the issue's
// worktree; a RESUME runs in the directory the transcript actually recorded, so
// `claude --resume` finds its history (the project dir is keyed off cwd).
// The first message auto-sent into a brand-new chat. It orients claude to the
// issue AND — by being a real turn — forces claude to write a transcript, which
// is what makes the chat resumable later (an empty, never-messaged session
// leaves no .jsonl on disk, so it can never be reopened). Title is best-effort.
// `status` is the issue's current board column (next / in-progress / done /
// rejected / …). Surface it up front so the agent knows the state before acting —
// and, when the card is already settled, that it should not silently re-implement.
export function issueChatIntro(issueId, title, status) {
  const named = title ? `\`${issueId}\` — "${title}"` : `\`${issueId}\``;
  return `This chat is scoped to issue ${named}${statusClause(status)}. Run \`node scripts/board.mjs get ${issueId}\` to load the full issue, then give me a one-line summary of what it's about and wait for direction.`;
}

// A short clause naming the current status, with a caution when the card is
// already closed so a fresh chat doesn't redo finished work.
function statusClause(status) {
  if (!status) return '';
  if (status === 'done' || status === 'rejected') {
    return ` — currently **${status}**, so treat it as closed: don't re-implement it unless I explicitly ask you to reopen or extend it`;
  }
  return ` (status: ${status})`;
}

// Intro for an AUTONOMOUSLY-launched chat: same issue-scoping as the human
// intro, but instead of "summarize and wait for direction" it tells the agent to
// run the work end-to-end on its own. For claude, `flow` picks the protocol
// skill — 'bug' (reproduce → fix) or the plain /change spine. Codex has no
// Claude-Code skills, so it gets a plain-language end-to-end instruction. The
// human opens the card later to monitor/unblock, not to kick it off.
export function autonomousChatIntro(issueId, title, flow = 'change', agent = DEFAULT_AGENT, status = null) {
  const named = title ? `\`${issueId}\` — "${title}"` : `\`${issueId}\``;
  const tail = `confirm the scope to yourself and proceed without waiting for further direction. A human will open this chat to monitor and unblock you, not to start you. When the work is candidate-complete, present receipts and the live preview link per the protocol.`;
  const st = statusClause(status);
  // Codex has no Claude-Code skills — give it a plain-language end-to-end brief.
  if (agent === 'codex') {
    return `This chat is scoped to issue ${named}${st}, and you were launched autonomously to implement it end-to-end. Run \`node scripts/board.mjs get ${issueId}\` to load the full issue, then implement it fully — ${tail}`;
  }
  const skill = flow === 'bug' ? '/bug' : '/change';
  return `This chat is scoped to issue ${named}${st}, and you were launched autonomously to implement it end-to-end. Run \`node scripts/board.mjs get ${issueId}\` to load the full issue, then invoke the \`${skill}\` skill and carry it through to completion — ${tail}`;
}

// Intro for a NEW main chat — the main-root analog of issueChatIntro. Claude
// gets `/main` (the trunk-mode skill: work directly on the primary checkout, no
// worktree); codex, which has no Claude-Code skills, gets the same orientation
// in plain language. A RESUMED main chat gets no intro — its history is on disk.
export function mainChatIntro(agent = DEFAULT_AGENT) {
  if (agent === 'codex') {
    return "You're working directly in the primary checkout (main / trunk) — no worktree; commit straight to main. What should we work on?";
  }
  return '/main';
}

// Build the claude argv for a chat spawn — re-exported from the claude adapter
// so the standalone arg tests keep a stable import. Live spawns build argv via
// the chat's own agent adapter (see spawnChat). RESUME reopens an existing uuid;
// NEW mints one and (when given) carries an initial prompt as a positional arg —
// `claude … "<prompt>"` stays interactive AND submits that first turn.
export function buildChatArgs(opts) {
  return agentById('claude').buildArgs(opts);
}

function spawnChat({ issueId, sessionId, mode, cwd, cols, rows, initialPrompt, key, model, effort, agent = DEFAULT_AGENT }) {
  // Every chat's PTY is keyed by its session uuid — issue and main alike (`key`
  // defaults to sessionId). `issueId` is the env the chat belongs to ('main' or
  // an issue id) and rides into the session object + registry record.
  const mapKey = key || sessionId;
  // In-process idempotence: the attach/deliver paths await I/O between their
  // "no live session" check and this call, so two concurrent requests can both
  // reach here for one key. The claim below can't stop that (our own pid
  // re-stamps), so the map is the guard: a live PTY for the key IS the spawn.
  const existing = chats.get(mapKey);
  if (liveSession(existing)) return existing;
  // A foreign-shape survivor that outlived the eval-time retirement sweep
  // (planted after it, or a future gap) is retired here — never reused,
  // never leaked alongside the fresh spawn.
  if (foreignSession(existing)) {
    chats.delete(mapKey);
    killAndSettleClaims([[mapKey, existing]], { trusted: false });
  }
  // Machine-wide single owner: claim the key before spawning. Losing the claim
  // means another live server already hosts (or just now claimed) this chat —
  // returning null instead of forking a duplicate claude on the same session.
  if (!claimChat(mapKey, issueId, sessionId)) return null;
  const adapter = agentById(agent);
  const bin = adapter.bin();
  // Test stand-in (LAB_TERMINAL_CMD / LAB_CODEX_CMD, e.g. /bin/cat) takes no CLI
  // flags — it must just echo. The real CLI gets its agent-specific argv.
  const isStandIn = bin === process.env.LAB_TERMINAL_CMD || bin === process.env.LAB_CODEX_CMD;
  const args = isStandIn ? [] : adapter.buildArgs({ mode, sessionId, initialPrompt, model, effort });

  let term;
  try {
    term = pty.spawn(bin, args, {
      name: 'xterm-256color',
      cols: cols || 100,
      rows: rows || 30,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
  } catch (e) {
    // The spawn itself failed AFTER we claimed the key: release it so a
    // retry (here or on another server) isn't blocked by a claim with no PTY
    // behind it. Re-throw so the caller surfaces the real error.
    releaseChat(mapKey);
    throw e;
  }

  return wireSession(term, { issueId, sessionId, mapKey, agent, cols, rows });
}

// Adopt a freshly-spawned PTY into the live-chat machinery: build the session
// object, re-stamp the claim with the child's identity (ptyPid + start time),
// register it in the chats map, and wire output/exit. Shared by spawnChat (id
// known up front) and spawnCodexNewChat (id discovered after spawn). Returns the
// session, or null if the post-spawn re-stamp fails (a chat later servers
// couldn't reason about — torn down like a failed spawn).
function wireSession(term, { issueId, sessionId, mapKey, agent, cols, rows }) {
  const session = {
    pty: term, issueId, sessionId, agent,
    buffer: [], cols: cols || 100, rows: rows || 30,
    attached: new Set(), geomOwner: null, exited: false, shape: CHAT_SHAPE,
  };
  chats.set(mapKey, session);
  if (!claimChat(mapKey, issueId, sessionId)) {
    chats.delete(mapKey);
    try { term.kill(); } catch {}
    releaseChat(mapKey);
    return null;
  }

  term.onData((data) => {
    bufferPush(session, data);
    broadcast(session, { type: 'output', data });
  });
  term.onExit(({ exitCode }) => {
    session.exited = true;
    broadcast(session, { type: 'exit', code: exitCode });
    // Only remove OUR OWN map entry: a successor PTY may already own this key
    // (kill old chat → immediately respawn), and a stale exit firing late must
    // not evict it — same guard the dev-server exit handler uses. When we DO own
    // it, also release the machine-wide claim so the chat is resumable anywhere
    // again (releaseChat is itself pid-guarded, but gating on our own map entry
    // keeps a late stale exit from touching a successor's claim).
    if (chats.get(mapKey) === session) { chats.delete(mapKey); releaseChat(mapKey); }
  });

  return session;
}

// Spawn a NEW codex chat and reconcile its identity. Codex mints its own session
// id, so — unlike claude — we CANNOT claim a key before spawning: we spawn codex
// in the worktree, read the id back from the rollout it writes (discoverSessionId,
// matched by cwd + recency), then adopt the live PTY under that real id. There is
// no pre-spawn claim because the id doesn't exist until codex creates it, and no
// other server can contend an id nobody else has seen yet; the claim lands the
// instant we know it. Returns { session, sessionId } or { error }.
async function spawnCodexNewChat({ issueId, cwd, cols, rows, initialPrompt, model }) {
  const adapter = agentById('codex');
  const bin = adapter.bin();
  const isStandIn = bin === process.env.LAB_TERMINAL_CMD || bin === process.env.LAB_CODEX_CMD;
  const args = isStandIn ? [] : adapter.buildArgs({ mode: 'new', initialPrompt, model });
  const since = Date.now();

  let term;
  try {
    term = pty.spawn(bin, args, {
      name: 'xterm-256color', cols: cols || 100, rows: rows || 30, cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
  } catch (e) { return { error: `codex spawn failed: ${e.message}` }; }

  const sessionId = await adapter.discoverSessionId({ cwd, sinceMs: since });
  if (!sessionId) {
    try { term.kill(); } catch {}
    return { error: 'could not determine codex session id (no rollout written) — is codex installed and authenticated?' };
  }
  // Another server can't own a brand-new codex id, but a live PTY for it in THIS
  // process would only exist if we somehow spawned twice — the map guard.
  const existing = chats.get(sessionId);
  if (liveSession(existing)) { try { term.kill(); } catch {} return { session: existing, sessionId }; }
  if (!claimChat(sessionId, issueId, sessionId)) {
    try { term.kill(); } catch {}
    return { error: 'codex chat is live in another dash server' };
  }
  const session = wireSession(term, { issueId, sessionId, mapKey: sessionId, agent: 'codex', cols, rows });
  if (!session) return { error: 'codex chat could not be claimed' };
  return { session, sessionId };
}

// Attach a websocket to a chat's PTY. If the PTY is already live (e.g. after a
// browser refresh) reattach and replay the recent buffer; otherwise spawn it.
// `mode` tells a cold spawn whether this is a brand-new chat or a resume of a
// linked-but-not-running session.
//
// NEVER REJECTS: vite's upgrade handler calls this fire-and-forget with no
// frame to catch in, so a rejection escaping here is an unhandled rejection —
// which kills the whole dash and every chat in it (i-chat-attach-crash). The
// boundary converts any unexpected failure into an honest exit frame + 1011
// close for THAT socket; every other chat is untouched.
export async function attachChat(ws, opts) {
  try { await attachChatInner(ws, opts); }
  catch (e) {
    console.error('[dash-terminal] attach failed:', e);
    try { send(ws, { type: 'exit', code: null, error: `attach failed: ${e.message}` }); } catch {}
    try { ws.close(1011, 'attach failed'); } catch {}
  }
}

async function attachChatInner(ws, { issueId, sessionId, mode, agent }) {
  const isMain = issueId === MAIN_ENV;
  // Every chat's PTY is keyed by its session uuid — main included. Reattaching to
  // a live PTY makes a browser reload (and a mid-session /clear) invisible: you
  // stay on the same terminal.
  const key = sessionId;
  let session = chats.get(key);
  const reattached = liveSession(session);

  if (!reattached) {
    // Machine-wide single-owner check BEFORE any cold spawn: if another live
    // dash server on this machine already hosts this chat, hand the client to
    // it instead of forking a second claude on the same session (the
    // i-chat-collision double-resume). verify:true enforces full process
    // identity so a recycled pid is never mistaken for the owner.
    const owner = await liveChatOwner(key, { verify: true });
    if (owner && owner.pid !== process.pid) {
      redirectToOwner(ws, owner);
      return;
    }
    const clientAgent = agent || DEFAULT_AGENT;
    // Codex mints its OWN id, so a codex chat is spawned eagerly at create time
    // (POST /chat) — by the time a browser attaches, its id + transcript exist.
    // A 'new' that reaches here for codex therefore means the eager PTY already
    // died; reopen it as a RESUME (a fresh 'new' would mint a second, unlinked
    // id). Claude 'new' spawns with the dash-minted id as usual.
    const asResume = mode === 'new' && !agentById(clientAgent).dashMintsId;
    const effMode = asResume ? 'resume' : mode;
    // Resolve where the chat runs. A NEW chat runs in the main repo (main) or the
    // issue's worktree. A RESUME runs in the directory its transcript recorded —
    // for a main chat that IS the repo root; for an issue chat its worktree or
    // wherever it was recorded. Bail if there's no live directory to run in.
    let cwd, chatAgent = DEFAULT_AGENT;
    if (effMode === 'new') {
      cwd = isMain ? MAIN_REPO : (hasWorktree(issueId) ? worktreeDir(issueId) : null);
      chatAgent = clientAgent;
    } else {
      const r = await resolveChat(sessionId);
      cwd = r.resumable ? r.cwd : null;
      chatAgent = r.resumable ? r.agent : clientAgent;
      // Same belt deliverMessage wears: an agent carrying this session id in
      // its argv is the session RUNNING, registry record or not — a manual
      // `claude --resume` / `codex resume`, an orphan whose dash died, or a
      // just-released chat whose process is still winding down after a
      // graceful stop. Cold-resuming over it would fork the transcript.
      if (cwd && await sessionProcessAlive(sessionId)) {
        const err = 'an agent process for this session is alive outside any dash server — close it (or wait for it to exit) before reopening the chat here';
        send(ws, { type: 'exit', code: null, error: err });
        try { ws.close(1011, 'session process alive elsewhere') } catch {}
        return;
      }
    }
    if (!cwd) {
      const err = effMode === 'new'
        ? (isMain ? 'main repo unavailable' : 'no worktree for issue')
        : 'chat not resumable on this machine';
      send(ws, { type: 'exit', code: null, error: err });
      try { ws.close(1011, err); } catch {}
      return;
    }
    // A fresh chat opens with an auto-sent intro — this both orients the agent
    // AND guarantees a transcript is written (the resumability contract; an empty
    // session leaves no .jsonl and can never be reopened). Main gets the trunk-
    // mode intro (/main); an issue chat gets its issue-reference message (title
    // best-effort — a Supabase blip drops it). A resume sends no intro.
    const spawnMode = effMode || 'resume';
    const spawnSessionId = sessionId;
    let initialPrompt;
    if (effMode === 'new') {
      if (isMain) initialPrompt = mainChatIntro(chatAgent);
      else { const meta = await issueMeta(issueId); initialPrompt = issueChatIntro(issueId, meta.title, meta.status); }
    }
    session = spawnChat({ issueId, sessionId: spawnSessionId, mode: spawnMode, cwd, cols: 100, rows: 30, initialPrompt, key, agent: chatAgent });
    if (!session) {
      // The claim was refused. A stranded (dead-owner, dead-child) record would
      // have been reclaimed inside claimChat, so this is another server taking
      // ownership between the check above and the spawn (→ redirect), an ORPHAN
      // (its dash gone but its claude child still alive — name the pid so the
      // human can wait or kill it), or a registry we couldn't write. Never fork.
      const owner = await liveChatOwner(key, { verify: true });
      if (owner) { redirectToOwner(ws, owner); return; }
      const orphan = claimOrphanPid(key);
      const err = orphan
        ? `this chat's claude process (pid ${orphan}) is still running from a previous dash server — wait for it to exit, or kill it, then reopen`
        : 'chat could not be claimed';
      send(ws, { type: 'exit', code: null, error: err });
      try { ws.close(1011, 'chat claim refused'); } catch {}
      return;
    }
  }

  // MULTI-ATTACH: a chat holds any number of attached sockets — output is
  // broadcast to all, input is accepted from any. The old single-socket model
  // closed the previous pane with 1000 'superseded' whenever the chat was
  // opened anywhere else (a second tab, a worktree preview dash) — silently
  // freezing the pane the human was typing in, with reconnect deliberately off
  // for that code (two windows would steal the session back and forth forever).
  // Broadcasting removes that freeze class outright. Geometry can't be shared
  // the same way — a PTY has ONE grid — so it belongs to the socket that last
  // ASSERTED one (sent a resize; see the message handler): visible panes
  // assert their fit on ready, hidden panes (board-load activity mirrors)
  // never assert and so can never take the grid just by attaching. Everyone
  // else mirrors via the 'grid' broadcast, so output stays formatted for a
  // grid every pane is rendering.
  session.attached.add(ws);

  // `ready` and the message-handler registration below MUST stay in one
  // synchronous block: the client answers `ready` with its fitted geometry
  // (its delivery anchor — see ChatPane), so by the time that resize crosses
  // the wire the handler must exist. An await in between would reopen the
  // window where a client message arrives with no listener and evaporates.
  send(ws, { type: 'ready', reattached, cols: session.cols, rows: session.rows, sessionId: session.sessionId });

  if (reattached && session.buffer.length) {
    send(ws, { type: 'output', data: session.buffer.join('') });
  }

  // Both socket handlers run inside the ws emitter's dispatch — an exception
  // escaping them is an uncaught exception on the shared server, the same
  // whole-dash kill the attach boundary above exists to prevent. Contain per
  // socket: log, never rethrow.
  ws.on('message', (raw) => {
    try {
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (session.exited) return;
      if (msg.type === 'input' && typeof msg.data === 'string') {
        session.pty.write(msg.data);
      } else if (msg.type === 'resize') {
        // Asserting a grid takes ownership of it. Only real layout intent sends
        // a resize (hidden mirrors self-gate client-side; 'grid' frames never
        // echo one back), so there is no automatic fight — the pane the human
        // last resized wins, and everyone else mirrors it.
        const cols = Math.max(2, Math.min(500, msg.cols | 0));
        const rows = Math.max(1, Math.min(300, msg.rows | 0));
        if (cols && rows) {
          session.geomOwner = ws;
          session.cols = cols;
          session.rows = rows;
          try { session.pty.resize(cols, rows); } catch {}
          broadcast(session, { type: 'grid', cols, rows }, ws);
        }
      }
    } catch (e) {
      console.error('[dash-terminal] chat message handling failed:', e);
    }
  });

  // Socket close detaches ONE pane but DOES NOT kill the PTY — persistence is
  // the point. If the grid's owner left, the grid is up for grabs: every
  // remaining pane is told ('owner' frame) and answers by asserting its own
  // fit — hidden mirrors self-gate and stay mirrors, so the surviving visible
  // pane reclaims the grid and the PTY doesn't linger on the departed pane's
  // geometry.
  ws.on('close', () => {
    try {
      session.attached.delete(ws);
      if (session.exited) return; // dead PTY: no grid left to hand over
      if (session.geomOwner === ws) {
        session.geomOwner = null;
        broadcast(session, { type: 'owner' });
      }
    } catch (e) {
      console.error('[dash-terminal] chat detach failed:', e);
    }
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
// GET  /api/dash/terminal/transcript?session=<uuid>&after=<n>
//                                             → { sessionId, live, cursor, messages:[{i,role,text,timestamp}] }
// POST /api/dash/terminal/message { issue, session, text }
//                                             → deliver text into the chat → { ok, delivered:'pty'|'resume' }
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

  // /api/dash/terminal/chats — the env's tracked chats (issue row or main store).
  if (req.method === 'GET' && segs[0] === 'chats') {
    const issueId = new URL(req.url, 'http://x').searchParams.get('issue');
    if (!issueId) return json({ error: 'issue required' }, 400);
    const data = await issueChats(issueId);
    // Main has no reserved dev-server port (its app preview rides the origin);
    // only an issue reserves one — skip the Supabase read for main.
    data.port = issueId === MAIN_ENV ? null : await issuePort(issueId);
    return json(data);
  }

  // /api/dash/terminal/transcript — a session's spoken turns, for agent-to-agent
  // reads. `after` = the previous response's cursor for incremental polling.
  if (req.method === 'GET' && segs[0] === 'transcript') {
    const q = new URL(req.url, 'http://x').searchParams;
    const sessionId = q.get('session');
    if (!sessionId) return json({ error: 'session required' }, 400);
    const after = Math.max(0, parseInt(q.get('after') || '0', 10) || 0);
    const t = await readTranscript(sessionId, after);
    if (!t) return json({ error: `no transcript for session "${sessionId}" on this machine` }, 404);
    return json(t);
  }

  // /api/dash/terminal/message — deliver a message into an issue's chat (the
  // write half of agent-to-agent dialog; see deliverMessage for the gating).
  if (req.method === 'POST' && segs[0] === 'message') {
    const { issue, session, text } = await readBody();
    if (!issue || !session || !text || typeof text !== 'string') {
      return json({ error: 'issue, session, and text required' }, 400);
    }
    const r = await deliverMessage({ issueId: issue, sessionId: session, text });
    return json(r, r.ok ? 200 : (r.status || 500));
  }

  // /api/dash/terminal/git-status — main vs origin/main ahead/behind for the
  // board's sync button. Fetches, so it's the up-to-date count, not a stale one.
  if (req.method === 'GET' && segs[0] === 'git-status') {
    return json(await gitSyncStatus());
  }

  // /api/dash/terminal/git-sync — one-click fast-forward-pull + push of main.
  // A divergence drops a note into the main chat and returns { conflict:true }.
  if (req.method === 'POST' && segs[0] === 'git-sync') {
    const r = await gitSync();
    return json(r, r.ok ? 200 : (r.status || 200));
  }

  // /api/dash/terminal/live — the live server-side PTYs as {issue, session}
  // pairs. Cheap (in-memory map, no fs/spawn); board-load auto-attach seeds from
  // this so it only ever REATTACHES existing live chats, never cold-spawns
  // dormant ones.
  if (req.method === 'GET' && segs[0] === 'live') {
    return json({ sessions: await liveSessionChats() });
  }

  // /api/dash/terminal/<id>/open — ensure the dev server is up, then redirect.
  // The clickable link on the issue points here: one hop that lazy-starts vite
  // bound to the worktree (reusing a live one) and 302s to the running app AT
  // the issue's stored app-view path (default `/` = the canvas; `/dash/` etc.
  // point the iframe at another route — the single source of truth for where an
  // env's app view lands).
  if (req.method === 'GET' && segs.length === 2 && segs[1] === 'open') {
    const issueId = decodeURIComponent(segs[0]);
    if (!hasWorktree(issueId)) return json({ error: 'no worktree for issue' }, 404);
    // ONE row read for BOTH the port and the app-view path: a Supabase blip then
    // fails the redirect cleanly (no port → 409) instead of the split-read hazard
    // where the port resolves but the path lookup silently drops to the canvas.
    let row;
    try { const { get } = await import('./issues-store.mjs'); row = await get(issueId); }
    catch (e) { return json({ error: `issue lookup failed: ${e.message}` }, 502); }
    const port = row && row.port != null ? Number(row.port) : null;
    if (port == null) return json({ error: 'no port reserved for issue' }, 409);
    const r = await ensureDevServer(issueId, port);
    if (!r.ok) return json(r, 500);
    await waitForPort(port);
    // Build the redirect through the URL API, not string concat: the stored path
    // may carry its own query/hash (`/dash/#/tests`, `/foo?x=1`), and the app
    // panel's hard-refresh adds a `?cb=` bust — concatenation produced `?x=1?cb=`
    // and buried the bust inside a `#fragment`. Merging `cb` as a real search
    // param composes correctly, and .href percent-encodes any residual char so it
    // can't split the Location header. The normalized path keeps a single leading
    // slash, so the origin never moves — the same-origin check is belt-and-braces.
    const origin = `http://localhost:${port}`;
    const target = new URL(normalizeAppPath(row.app_path), origin);
    const cb = new URL(req.url, 'http://x').searchParams.get('cb');
    if (cb != null) target.searchParams.set('cb', cb);
    res.writeHead(302, {
      Location: target.origin === origin ? target.href : `${origin}/`,
      'Cache-Control': 'no-store',
    });
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
    const r = await ensureWorktree(issue);
    if (!r.ok) return json(r, 500);
    const alloc = await reservePort(issue);
    return json({ ...r, port: alloc.port ?? null });
  }

  // /api/dash/terminal/chat — new chat in the env, linked.
  //   { issue }                              → mint + link a chat; PTY spawns lazily
  //                                            when the browser attaches (human-launched).
  //   { issue, autonomous:true, flow?, prompt? }
  //                                          → ALSO spawn the PTY server-side now, into
  //                                            the chats map (no sockets attached), running the
  //                                            given flow (/change or /bug) end-to-end.
  //                                            Opening the card later reattaches to it.
  // `issue` is 'main' for a MAIN chat (repo root, tracked in the main store, no
  // worktree/port, never an autonomous kick-off) or an issue id (its worktree).
  if (req.method === 'POST' && segs[0] === 'chat') {
    const body = await readBody();
    const { issue, flow, prompt, model, effort } = body;
    const agent = agentById(body.agent).id; // normalize unknown → claude
    if (!issue) return json({ error: 'issue required' }, 400);
    const isMain = issue === MAIN_ENV;
    const autonomous = body.autonomous && !isMain; // main is never an autonomous kick-off
    // Main runs in the repo root with no worktree and no reserved port; an issue
    // must exist as a row and gets a worktree + port (idempotent).
    let dir, port = null;
    if (isMain) {
      dir = MAIN_REPO;
    } else {
      // Gate on issue existence BEFORE touching git, so a bad id never leaves an
      // orphaned worktree behind a failed link.
      if (!(await issueExists(issue))) return json({ error: `no such issue "${issue}"` }, 404);
      const wt = await ensureWorktree(issue);
      if (!wt.ok) return json(wt, 500);
      const alloc = await reservePort(issue);
      dir = wt.dir; port = alloc.port ?? null;
    }
    const flowVal = flow === 'bug' ? 'bug' : 'change';

    if (!agentById(agent).dashMintsId) {
      // CODEX: it mints its own id, so we spawn eagerly (human AND autonomous),
      // discover the id from its rollout, THEN link it. The browser attaches to
      // the returned id and REATTACHES to this already-live PTY. Intro: main →
      // trunk-mode; issue → autonomous brief when kicked off, else summarize-and-wait.
      let intro;
      if (isMain) intro = mainChatIntro(agent);
      else {
        const meta = await issueMeta(issue);
        intro = autonomous
          ? (prompt || autonomousChatIntro(issue, meta.title, flow, agent, meta.status))
          : issueChatIntro(issue, meta.title, meta.status);
      }
      const r = await spawnCodexNewChat({ issueId: issue, cwd: dir, cols: 100, rows: 30, initialPrompt: intro, model });
      if (r.error) return json({ error: r.error }, 500);
      const link = await linkChat(issue, r.sessionId, agent);
      if (link?.error) {
        // Codex is spawned BEFORE the link (its id doesn't exist until it runs),
        // so a link failure would strand a live, UNLINKED codex process — invisible
        // to the board and unaddressable. Tear it down rather than leak it; the
        // user retries. (Claude links before spawning, so it can't reach this.)
        try { r.session.exited = true; r.session.pty?.kill(); } catch {}
        releaseChat(r.sessionId);
        chats.delete(r.sessionId);
        return json({ error: `link failed: ${link.error}` }, 500);
      }
      return json({ ok: true, sessionId: r.sessionId, agent, mode: 'new',
        ...(autonomous ? { autonomous: true, flow: flowVal } : {}), dir, port });
    }

    // CLAUDE: the dash mints the uuid up front and links it; the PTY spawns
    // lazily when the browser attaches (human, with mainChatIntro/issueChatIntro
    // chosen there) or eagerly now (autonomous — issue only).
    const sessionId = crypto.randomUUID();
    const link = await linkChat(issue, sessionId, agent);
    if (link?.error) return json({ error: `link failed: ${link.error}` }, 500);
    if (autonomous) {
      // Spawn the real claude PTY immediately, keyed by sessionId (same key
      // attachChat uses for a 'new' chat) so a later browser open REATTACHES
      // to this running process rather than spawning a second one. The intro
      // tells it to run the flow to completion instead of waiting for direction.
      const meta = await issueMeta(issue);
      const intro = prompt || autonomousChatIntro(issue, meta.title, flow, agent, meta.status);
      const spawned = spawnChat({ issueId: issue, sessionId, mode: 'new', cwd: dir, cols: 100, rows: 30, initialPrompt: intro, key: sessionId, model, effort, agent });
      // A freshly-minted uuid losing its claim means another server claimed it
      // in the same instant — vanishingly rare, but never fork: report it.
      if (!spawned) return json({ error: 'chat is live in another dash server' }, 409);
      return json({ ok: true, sessionId, agent, mode: 'new', autonomous: true, flow: flowVal, dir, port });
    }
    return json({ ok: true, sessionId, agent, mode: 'new', dir, port });
  }

  // DELETE /api/dash/terminal/chat { issue, session } — unlink a chat from its
  // env (an issue's conversations[], or the main store). The transcript on disk
  // is untouched; this only drops the association. A live PTY (if any) is left
  // running and will be reaped on exit — unlinking is bookkeeping, not a kill.
  if (req.method === 'DELETE' && segs[0] === 'chat') {
    const { issue, session } = await readBody();
    if (!issue || !session) return json({ error: 'issue and session required' }, 400);
    // Handles are agent-prefixed; the client sends the bare session id, so resolve
    // the exact stored handle (bare uuid = claude, `codex:<uuid>` = codex) to drop.
    const handles = await chatHandlesFor(issue);
    const handle = handles.find(h => parseHandle(h).sessionId === session) || session;
    if (issue === MAIN_ENV) { unlinkMainChat(handle); return json({ ok: true }); }
    const { removeFromArray } = await import('./issues-store.mjs');
    const r = await removeFromArray(issue, 'conversations', [handle]);
    if (r?.error) return json({ error: `unlink failed: ${r.error}` }, 500);
    return json({ ok: true });
  }

  return json({ error: 'unknown terminal endpoint' }, 404);
}
