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

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import net from 'net';
import { run } from './proc.mjs';
import { journalOpen, journalStamp, journalClose, journalBlock, journalEnd, journalImportBlocked, reconcile, importLegacyRegistry } from './chat-journal.mjs';
import { registryDir, pidStartTime, signalTree, terminateVerified } from './proc-identity.mjs';
import {
  agentById, agentChoices, parseHandle, formatHandle,
  findTranscriptAny, readTurnsAny, discoverChatsAny, sessionPidsAny, DEFAULT_AGENT,
  agentAvailability, AgentMissingError, isLaunchable,
} from './agents.mjs';
import { createRequire } from 'module';
import {
  MAIN_ENV, MAIN_REPO, resolveWorktreeDir, worktreeDir, workspaceForDir, workspaceIssueMap,
} from './workspace-env.mjs';
import {
  mainChatsList, linkMainChat, unlinkMainChat, mainChatMeta, setMainChatName,
  forgetMainChatMeta,
} from './main-chats-store.mjs';
import { openSession, feedSession, resizeSession, closeSession, activitySnapshot, subscribeActivity } from './chat-activity.mjs';
import { normalizeAppPath } from '../src/app-env.mjs';
import { sameHostOriginFor } from '../src/same-host-origin.mjs';
import { git, hasWorktree, branchExists, ensureWorktree, restorableWorkspace, restoreCwdInside } from './worktree.mjs';
import { resolveViteBin } from '../scripts/lib/vite-bin.mjs';

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

// Locating a chat's transcript and reading the cwd it ran in is now agent-
// specific (claude scans ~/.claude/projects, codex scans ~/.codex/sessions) —
// see findTranscriptAny + each adapter in agents.mjs. Both are ASYNC by design:
// resolving a chat reads transcripts off disk, and board-load resolves many at
// once, so awaiting fs.promises lets those interleave with live requests instead
// of freezing the single dev-server event loop.

// Resolve a chat session to its on-disk reality:
//   { resumable, restorable, cwd, agent } — resumable iff this machine HAS the
//   chat, its agent is one the dash can START, and the cwd it ran in still
//   exists. `agent` is whichever adapter's store the chat was found in (a uuid
//   lives in exactly one). If the chat is absent (created on another machine) or
//   its agent is read-only (a Cursor chat — the dash cannot drive an editor), it
//   is present-but-unresumable: shown, never spawned. Whether it can be READ is
//   a separate question, and the mirror answers it.
//
// A chat whose CWD is gone is a third thing, and calling it unresumable was the
// lie this split removes: its workspace was a git worktree, which is derived
// state the dash knows how to rebuild (worktree.mjs), so the chat is dormant
// rather than dead. `restorable` says exactly that — the directory can be made
// again, at the path this chat recorded — and it is deliberately NOT `resumable`:
// rebuilding a workspace is a real act with real cost, so someone asks for it
// (the card's "Create dev env & reopen chat"), and nothing does it behind them.
async function resolveChat(sessionId) {
  const dormant = (fields) => ({ resumable: false, restorable: false, ...fields });
  const found = await findTranscriptAny(sessionId);
  if (!found) return dormant({ cwd: null, agent: DEFAULT_AGENT, reason: 'no-transcript', updated: 0 });
  const { agent, transcriptPath, launchable } = found;
  // When the chat last SAID anything. The transcript's mtime is the same ground
  // truth the idle reaper trusts, and the path is already resolved here, so this
  // is one stat rather than a second scan.
  const updated = await fs.promises.stat(transcriptPath).then(st => st.mtimeMs).catch(() => 0);
  const cwd = await agentById(agent).transcriptCwd(transcriptPath, sessionId);
  if (!launchable) return dormant({ cwd, agent, reason: 'not-launchable', updated });
  if (!cwd) return dormant({ cwd: null, agent, reason: 'no-cwd', updated });
  const live = await fs.promises.stat(cwd).then(st => st.isDirectory()).catch(() => false);
  if (!live) {
    return dormant({ cwd, agent, reason: 'cwd-gone', updated, restorable: !!restorableWorkspace(cwd) });
  }
  return { resumable: true, restorable: false, cwd, agent, reason: null, updated };
}

// Parse a claude transcript's jsonl into spoken turns. Re-exported from the
// claude adapter so the standalone arg/parse tests keep a stable import; the
// live read path (readTranscript) reads through whichever agent actually owns
// the chat.
export function parseTranscriptMessages(raw, after = 0) {
  return agentById('claude').parseTranscript(raw, after);
}

// Read a session's spoken turns. `after` is the previous read's cursor (0 = from
// the start). Works for ANY session ANY agent has on this machine — each adapter
// owns how it gets its own turns (a jsonl file for the CLIs, a database row for
// Cursor), so this is one call rather than a find-then-read the caller assembles.
// Reading is deliberately unrestricted (transcripts are world-visible context
// for agents); only WRITING is gated on the issue link.
export async function readTranscript(sessionId, after = 0) {
  const t = await readTurnsAny(sessionId, after);
  if (!t) return null;
  const live = globalThis.__labChats.get(sessionId);
  return { sessionId, live: !!live && !live.exited, ...t };
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

// Does this issue OWN this chat? The one definition of membership, because every
// act that writes through an issue on a chat's behalf — delivering a message,
// rebuilding the chat's workspace — has to ask the same question, or one of them
// becomes a way around the other.
//
// conversations[] entries carry an agent prefix (formatHandle), so the match is
// on the PARSED session id, not the raw entry: a codex chat (`codex:<uuid>`) is
// addressable by its bare uuid exactly like a claude one.
function linkedTo(row, sessionId) {
  return Array.isArray(row?.conversations)
    && row.conversations.some(h => parseHandle(h).sessionId === sessionId);
}

async function chatLinkedTo(issueId, sessionId) {
  try {
    const { get } = await import('./issues-store.mjs');
    return linkedTo(await get(issueId), sessionId);
  } catch { return false; }
}

// WHICH issues claim a workspace folder — the ones whose id IS that folder, or
// whose recorded branches include it. EVERY claimant, not the first: a branch is
// often linked to a long-lived umbrella issue as well as the attempt on it (the
// same reason worktreeVerdicts counts them all), and first-match would refuse a
// legitimate card because someone else's row happened to sort earlier.
//
// Asked of the whole board, because "does anyone else own this directory" is
// exactly the question one row cannot answer. A board we cannot read is a claim
// we cannot disprove, so a failure is reported, never softened into "unclaimed".
// ensureWorktree's typed refusals → HTTP. One table, so a new reason is a line
// here rather than a condition somewhere in the handler; anything unmapped is
// ours to answer for (500).
const WORKTREE_STATUS = {
  'ambiguous-branch': 409,   // which branch this workspace held is not recorded
  'branch-checked-out': 409, // another worktree holds it; close that one
  'board-unreadable': 503,   // we could not ask, so we did not guess
};

async function workspaceClaimants(workspace) {
  try {
    const { listAll } = await import('./issues-store.mjs');
    const rows = await listAll();
    return { ids: rows.filter(r => r.id === workspace || (r.branches || []).includes(workspace)).map(r => r.id) };
  } catch (e) {
    return { error: `could not read the board to see who owns "${workspace}": ${e.message}` };
  }
}

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
  if (!linkedTo(row, sessionId)) return { ok: false, status: 404, error: `session not linked to issue "${issueId}"` };

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
  // A dormant chat whose workspace was collected is not undeliverable forever —
  // it is one deliberate act away. Delivery is not that act (a sender wants to
  // TALK to a chat, not spend seconds of git rebuilding a checkout on its
  // behalf), so this names the door rather than opening it.
  if (r.restorable) {
    return { ok: false, status: 409, reason: 'cwd-gone', error: 'that chat\'s dev environment was collected — reopen it from its card ("Create dev env & reopen chat") and send again' };
  }
  if (!r.resumable) return { ok: false, status: 409, error: `chat not deliverable (${r.reason})` };
  // An agent already running on this session ANYWHERE on this machine makes a
  // resume-spawn a FORK: two processes appending to one transcript. Refuse and
  // name the condition.
  //
  // Card-open RECLAIMS such a process instead (reclaimSession): opening a card
  // is a request for that chat to live HERE, and a refusal leaves a dead pane
  // nothing but a hand-run `kill` can fix. A message is not that request — the
  // sender wants to TALK to the chat, not take it over — so delivery stays a
  // refusal the sender can act on, and no send can cost someone a running agent.
  if (await sessionProcessAlive(sessionId)) {
    return { ok: false, status: 409, error: 'session is live in an agent process this server does not own — send via the server that owns it, or wait for it to exit' };
  }
  const cursor = (await readTranscript(sessionId))?.cursor ?? 0;
  // Resume under the agent whose store the transcript was found in — a claude
  // uuid resumes with claude, a codex uuid with `codex resume`.
  spawnChat({ issueId, sessionId, mode: 'resume', cwd: r.cwd, cols: 100, rows: 30, initialPrompt: text, key: sessionId, agent: r.agent });
  return { ok: true, delivered: 'resume', sessionId, cursor };
}

// --- Git sync (the board's GitHub-Desktop-style sync button) ---
// LAB_MAIN_REPO (set by tests) already redirects MAIN_REPO at module load, so
// these hit the hermetic scratch repo under test.

// The most-recently-spawned live PTY for an env, or null. Chats are uuid-keyed,
// so find the newest live session belonging to that env — the one the human is
// most likely looking at.
function liveEnvSession(env) {
  let found = null;
  for (const s of chats.values()) {
    if (liveSession(s) && s.issueId === env) found = s; // last wins = newest
  }
  return found;
}

// Paste a message into an env's live chat PTY, exactly like typed input (the
// same bracketed-paste + Enter deliverMessage uses). No-op if that env has no
// live chat — the button still surfaces the conflict, so a dormant chat never
// blocks a sync. Returns whether it landed.
async function deliverToEnvChat(env, text) {
  const session = liveEnvSession(env);
  if (!session) return false;
  session.pty.write(`\x1b[200~${text}\x1b[201~`);
  await new Promise(r => setTimeout(r, PASTE_SETTLE_MS));
  if (!session.exited) session.pty.write('\r');
  return true;
}

// --- git sync, for ANY environment ---
//
// One mechanism, two places it surfaces. `main` syncs the primary checkout; an
// ISSUE syncs its own worktree branch, so a teammate can push and pull the
// branch for a card straight from the card. The board's button is this with
// env='main' — it is not a separate path with its own bugs.
//
// Resolving an env to (working dir, branch) is the whole generalization: main is
// the repo root on `main`, an issue is its worktree on whatever branch is
// checked out there. Everything downstream — the ahead/behind count, the
// fast-forward, the push — is branch-relative and identical for both.
async function syncTargetFor(env) {
  if (!env || env === MAIN_ENV) return { dir: MAIN_REPO, env: MAIN_ENV };
  const dir = resolveWorktreeDir(env);
  if (!dir) return { error: `no worktree for "${env}" on this machine` };
  return { dir, env };
}

// Run git in a specific working directory (main repo or a worktree).
async function gitIn(dir, args) {
  return run('git', ['-C', dir, ...args]);
}

// A branch vs its origin counterpart after a fetch: how many commits each is
// ahead of the other, plus whether the tree is dirty. `rev-list --left-right
// --count <upstream>...HEAD` → [behind, ahead] (left = remote-only, right =
// local-only). `hasRemote` false means the branch has never been pushed — that
// is a normal state for a fresh issue branch, and PUSHABLE, not an error.
export async function gitSyncStatus({ fetch = true, env = MAIN_ENV } = {}) {
  const target = await syncTargetFor(env);
  if (target.error) return { ok: false, error: target.error, env };
  const { dir } = target;
  if (fetch) await gitIn(dir, ['fetch', 'origin', '--quiet']);
  const branch = (await gitIn(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const remote = `origin/${branch}`;
  const hasRemote = (await gitIn(dir, ['rev-parse', '--verify', '--quiet', remote])).status === 0;
  let ahead = 0, behind = 0;
  if (hasRemote) {
    const counts = (await gitIn(dir, ['rev-list', '--left-right', '--count', `${remote}...HEAD`])).stdout.trim();
    const m = counts.split(/\s+/).map(n => parseInt(n, 10) || 0);
    behind = m[0] || 0; ahead = m[1] || 0;
  } else {
    // Never pushed: everything this branch has past main is what a push would
    // publish, so the button can honestly offer "push" rather than reading as
    // in-sync with a remote that doesn't exist.
    const base = (await gitIn(dir, ['rev-parse', '--verify', '--quiet', 'main'])).status === 0 ? 'main' : null;
    if (base) ahead = parseInt((await gitIn(dir, ['rev-list', '--count', `${base}..HEAD`])).stdout.trim(), 10) || 0;
  }
  const dirty = (await gitIn(dir, ['status', '--porcelain'])).stdout.trim().length > 0;
  return { ok: true, env, branch, ahead, behind, dirty, hasRemote, publishable: !hasRemote && ahead > 0 };
}

// One-click sync: fast-forward the branch to its origin counterpart if behind,
// then push if ahead. A divergence that can't fast-forward (or a push rejected
// because the remote moved mid-sync) is NOT auto-resolved — it drops a note into
// the env's chat and reports { conflict:true } so the button flags it and the
// human (or the agent in that chat) resolves it.
//
// The main env additionally refuses when the primary checkout isn't on main:
// there, "the branch" is whatever someone left checked out, and syncing it under
// the label "sync main" would be a lie. An issue has no such ambiguity — its
// worktree is on its own branch by construction.
export async function gitSync({ env = MAIN_ENV } = {}) {
  const target = await syncTargetFor(env);
  if (target.error) return { ok: false, conflict: false, error: target.error, env };
  const { dir } = target;
  const st = await gitSyncStatus({ env });
  if (!st.ok) return st;
  if (env === MAIN_ENV && st.branch !== 'main') {
    return { ...st, ok: false, conflict: false, error: `primary checkout is on '${st.branch}', not main` };
  }
  const remote = `origin/${st.branch}`;

  let pulled = 0, pushed = 0;
  if (st.behind > 0) {
    const pull = await gitIn(dir, ['merge', '--ff-only', remote]);
    if (pull.status !== 0) {
      const msg = `⚠️ Git sync couldn't fast-forward: ${st.branch} and ${remote} have diverged (${st.ahead} ahead, ${st.behind} behind). Pull ${remote}, resolve the conflicts, and push — then the board's sync will be clean again.`;
      const delivered = await deliverToEnvChat(env, msg);
      return { ...st, ok: false, conflict: true, delivered, pulled, pushed };
    }
    pulled = st.behind;
  }

  const mid = await gitSyncStatus({ fetch: false, env });
  if (mid.ahead > 0) {
    // -u on a branch with no upstream yet: publishing an issue branch for the
    // first time is the common case here, and it must set tracking so the next
    // sync has a remote to compare against.
    const args = mid.hasRemote ? ['push', 'origin', mid.branch] : ['push', '-u', 'origin', mid.branch];
    const push = await gitIn(dir, args);
    if (push.status !== 0) {
      // A push rejected here means origin moved between our fetch and push — a
      // race, not a merge conflict. Surface it the same way: note + report.
      const msg = `⚠️ Git sync push was rejected — ${remote} moved. Pull, resolve if needed, and push again.`;
      const delivered = await deliverToEnvChat(env, msg);
      return { ...mid, ok: false, conflict: true, delivered, pulled, pushed, error: push.stderr.trim() };
    }
    pushed = mid.ahead;
  }

  const final = await gitSyncStatus({ fetch: false, env });
  return { ...final, ok: true, pulled, pushed };
}

// Is an agent process for this session running anywhere on this machine? Each
// agent proves it its own way (agents.mjs sessionPids — argv for claude, argv
// plus the rollout's writer lock for codex); this is the union.
// FAIL CLOSED: a probe that could not run at all reads as alive, so an
// unanswerable question refuses the resume rather than risking a forked
// transcript.
export async function sessionProcessAlive(sessionId) {
  const { pids, uncertain } = await sessionPidsAny(sessionId);
  return uncertain || pids.length > 0;
}

// Is this session free for this supervisor to resume — and if a process it does
// not own is holding it, RECLAIM it: end the verified holder(s) and confirm.
// True also when nothing held it, which is the ordinary case.
//
// This is boot reconciliation's rule — "child provably ALIVE → terminate the
// verified child, await its death, then RESUME" — applied at the OTHER place a
// chat comes back to life. Card-open used to refuse instead, and the asymmetry
// was the bug: a chat whose supervisor died leaving no journal record to act on
// dead-ended forever (nothing would ever clear the holder), and for codex the
// refusal never even fired — a fresh codex carries no id in its argv, so the
// cold resume went ahead and codex answered `already has an active writer
// (-32600)` (i-codex-resume-collision).
//
// Two things are never reclaimed. A session we could not PROVE is held stays
// fail-closed — we do not kill on a guess. And a session this environment does
// not LIST is not ours to end: the link (an issue's conversations[], main's
// local list) is the dash's ownership record, so it is what separates
// reclaiming our own chat from killing a stranger's process.
export async function reclaimSession(env, sessionId) {
  const held = await sessionPidsAny(sessionId);
  if (held.uncertain) return false;
  // A PTY this supervisor is hosting is not stranded — and between a caller's
  // "not in my map" read and this probe, a concurrent attach may have spawned
  // exactly that. Killing it would be the reclaim eating its own chats; the
  // spawn downstream is idempotent on the map, so leaving it alone lands on the
  // live session instead.
  const hosted = ownPtyPids();
  const stranded = held.pids.filter((pid) => !hosted.has(pid));
  if (!stranded.length) return true;
  // Identity is stamped HERE, next to the detection that named these pids —
  // not later, next to the kill. terminateVerified re-checks it immediately
  // before signalling, so a holder that exits while we look up the link cannot
  // hand its pid to a bystander we then kill.
  //
  // A holder whose start time we cannot READ has no identity to re-check, and a
  // kill we cannot verify is exactly what this function must not do: refuse the
  // whole reclaim. (Elsewhere a null start time is fine — abortSpawnedChild is
  // ending a child THIS process spawned and holds the handle to. Only here is
  // the target a process we merely found.)
  const holders = await Promise.all(stranded.map(async (pid) => ({ pid, startTime: await pidStartTime(pid) })));
  if (holders.some((h) => !h.startTime)) return false;
  const handles = await chatHandlesFor(env);
  if (!handles.some((h) => parseHandle(h).sessionId === sessionId)) return false;
  for (const { pid, startTime } of holders) {
    // Each proven death IS the proof the session is free — re-probing after the
    // loop would only add a second way for a loaded machine to fail to answer.
    if (!(await terminateVerified(pid, startTime))) return false;
    console.log(`[dash-terminal] reclaimed ${sessionId.slice(0, 8)} from stranded process ${pid}`);
  }
  return true;
}

// The pids of the PTYs this supervisor is currently hosting — its in-process
// ownership record, and the one thing that separates a chat of ours from a
// process nobody owns.
const ownPtyPids = () => new Set([...chats.values()]
  .filter((s) => liveSession(s) && Number.isInteger(s.pty?.pid))
  .map((s) => s.pty.pid));

// The tracked chat handles for an environment. An issue reads its shared
// Supabase conversations[]; MAIN reads the machine-local main-chats store. Both
// return the same agent-prefixed handle format (formatHandle), so every caller
// downstream treats an issue and main identically.
// `row` lets a caller that already holds the env's snapshot pass it in (issueChats
// reads the row ONCE and derives handles, meta, and branch resolution from it);
// omit it and the row is fetched. `undefined` means "not passed" — a passed `null`
// (a failed snapshot) is honored as an empty list, not re-fetched.
async function chatHandlesFor(env, row) {
  if (env === MAIN_ENV) return mainChatsList();
  const r = row !== undefined ? row : await (await import('./issues-store.mjs')).get(env).catch(() => null);
  return Array.isArray(r?.conversations) ? r.conversations : [];
}

// Link a chat to an environment, encoding its agent AND role in the handle (bare
// uuid = claude, `codex:<uuid>` = codex, `reviewer:codex:<uuid>` = codex reviewer
// — see formatHandle). Issue chats append to the shared Supabase conversations[];
// MAIN appends to the machine-local store. ONE entry per call (both append paths
// de-dupe).
async function linkChat(env, sessionId, agent = DEFAULT_AGENT, role = null) {
  const handle = formatHandle(agent, sessionId, role);
  // Register the chat's existence in the shared corpus the moment it is born,
  // so every open board — the owner's and every teammate's — lists it via
  // realtime immediately instead of after the next mirror sweep. Fire-and-
  // forget: a corpus hiccup must never cost the chat itself, and the sweep
  // registers whatever this misses.
  const register = async () => {
    const { registerChat } = await import('./chat-mirror.mjs');
    const { operatorEmail, machineName } = await import('./operator.mjs');
    await registerChat({ sessionId, env, agent, owner: await operatorEmail(), host: machineName() });
  };
  if (env === MAIN_ENV) {
    // Main's chats are numbered by the same rule as an issue's, out of the
    // machine-local store that stands in for the row — and by the same one call,
    // so a listed chat always has a number.
    const r = linkMainChat(handle);
    register().catch(() => {});
    return r;
  }
  // The facts this chat is BORN with — its number in the env, and whose computer
  // it lives on — go down WITH the link, in one write. The issue row already
  // recorded WHICH chats exist; without these it could say neither whose nor
  // which one this is, so a teammate's chat showed up as an unexplained dead
  // entry and every chat's number was re-counted off whatever order the list
  // happened to be in. Both are properties of the CHAT, not of the pane rendering
  // it, which is why they are stored rather than inferred from whoever is looking.
  //
  // Resolving WHO is best-effort and happens first: a git/hostname hiccup must
  // degrade to "no owner shown", which is honest, and must never cost the chat
  // its link — or, now that the two are one write, its number.
  let origin = {};
  try {
    const { operatorEmail, machineName } = await import('./operator.mjs');
    origin = { owner: await operatorEmail(), host: machineName() };
  } catch (e) {
    console.error(`[dash-terminal] could not resolve the owner of chat ${sessionId}:`, e.message);
  }
  const { addChat } = await import('./issues-store.mjs');
  const r = await addChat(env, handle, sessionId, origin);
  if (!r?.error) register().catch(() => {});
  return r;
}

// Everything an environment's ROW knows about its chats, sessionId →
// { name?, ordinal?, owner?, host? }. Same env split as chatHandlesFor: an
// issue's meta lives on the shared row (chat_meta), MAIN's in the machine-local
// store. {} = nothing recorded. Keyed by the FULL session uuid, never the 8-char
// display prefix, so the key is an identity rather than a truncation.
//
// ONE read for name, number AND ownership: the list needs all of them on every
// build, and separate reads would be separate round-trips and chances to
// disagree.
async function chatMetaFor(env, row) {
  // Every main chat runs in THIS repo root, so its owner is by definition the
  // person at this machine — there is no cross-machine case to record, and the
  // machine-local store carries the same { name, ordinal } entries as the row.
  if (env === MAIN_ENV) return mainChatMeta();
  const { get, readChatMeta } = await import('./issues-store.mjs');
  const r = row !== undefined ? row : await get(env).catch(() => null);
  return readChatMeta(r);
}

// Name (or un-name) one chat within an environment — the twin of linkChat, and
// the ONLY write path for a chat name (HTTP, CLI and UI all land here or on the
// store function it calls). A blank name clears back to the chat's number.
// Resolves to { ok, names } with the whole updated map, so a caller repaints
// without a second read.
async function setChatName(env, sessionId, name) {
  if (!sessionId) return { error: 'session required' };
  if (env === MAIN_ENV) return setMainChatName(sessionId, name);
  const { setChatName: setRowChatName } = await import('./issues-store.mjs');
  const r = await setRowChatName(env, sessionId, name);
  if (r.error) return r;
  const names = {};
  for (const [sid, m] of Object.entries(r.chat_meta || {})) if (m.name) names[sid] = m.name;
  return { ok: true, names };
}

// Forget everything the env's row knows about a chat — used when the chat is
// UNLINKED. The metadata belongs to the LINK, not the transcript: name, number
// and the ownership stamp go together, so an unlinked-then-relinked chat starts
// clean and the map can't accumulate entries for chats the env no longer has.
async function forgetChatMeta(env, sessionId) {
  if (env === MAIN_ENV) return forgetMainChatMeta(sessionId);
  const { clearChatMeta } = await import('./issues-store.mjs');
  return clearChatMeta(env, sessionId);
}

// Drop the dash API's memoized issue list after a chat write. Both `chat_meta`
// and `conversations` ride in the board's LIST_COLS, so a chat rename or unlink
// makes that cached feed stale for the rest of its TTL. Lazy import: dash-api is
// already loaded in this process (vite mounts both), so it's a cache hit, and
// terminal.js keeps no static dependency on the API layer above it.
async function invalidateIssuesCache() {
  try { (await import('./dash-api.js')).invalidateCache(); } catch {}
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
// runs get `pnpm exec vite --port <port> --strictPort`; the test suite swaps in a
// deterministic stand-in via LAB_DEV_SERVER_CMD (the same trick LAB_TERMINAL_CMD
// plays for the claude PTY) — run through `sh -c` with PORT in the env so the
// stand-in needs no vite-specific argv. Detached + unref so it survives this
// request and never blocks the event loop.
function spawnDevServer(dir, port) {
  const cmd = process.env.LAB_DEV_SERVER_CMD;
  if (cmd) {
    return spawn('sh', ['-c', cmd], { cwd: dir, detached: true, stdio: 'ignore', env: { ...process.env, PORT: String(port) } });
  }
  // The canonical launcher: the worktree is served through MAIN's host config
  // and MAIN's vite binary (absolute paths — the old `pnpm exec vite` only
  // resolved through a pnpm-run PATH the supervisor doesn't carry), so a
  // historical checkout's own vite.config.js — possibly still carrying the old
  // in-process control plane — never registers. The worktree's branch-owned
  // app-dev module (dev/app-server.mjs) is composed by the host config.
  const hostConfig = path.join(MAIN_REPO, 'vite.host.config.js');
  const viteBin = resolveViteBin(MAIN_REPO);
  // No --host here: WHERE it listens is DASH_BIND_HOST, read by the host config
  // itself (vite.host.config.js) alongside allowedHosts, so the edge and every
  // worktree server answer to one setting in one place.
  return spawn(viteBin, ['--config', hostConfig, '--port', String(port), '--strictPort'],
    { cwd: dir, detached: true, stdio: 'ignore', env: { ...process.env } });
}

// Ensure a vite dev server is running on `port` with cwd = the issue's worktree.
// Reuses one we already spawned (live child) or any server already answering on
// the port (e.g. survived a Dash-server restart). Otherwise spawns a detached,
// long-lived child bound to the worktree. Nothing kills it at merge time any
// more: the reaper collects it with the rest of the workspace once the issue has
// retired AND every chat in that worktree has gone quiet (worktree-reaper.mjs).
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
  try {
    await new Promise((resolve, reject) => {
      proc.once('spawn', resolve);
      proc.once('error', reject);
    });
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

// What has actually landed on an issue's branch, DERIVED from the branch rather
// than stored. There used to be a `commits` column appended by hand, which meant
// it was right only on the runs where someone remembered — and nothing rendered
// it, so it was write-only besides. Reading it from git instead cannot drift.
//
// Deliberately NOT part of the board list: this is one git call, and doing it
// per card on every board render is the repository scan that used to freeze the
// dash terminal. It is fetched by the OPEN issue only, on demand.
//
// The states are distinct on purpose — "no branch", "branch not on this
// machine", and "branch with nothing past main" are three different facts, and
// collapsing them into an empty list would report unseen work as no work.
export async function issueCommits(issueId) {
  const { get } = await import('./issues-store.mjs');
  const row = await get(issueId).catch(() => null);
  if (!row) return { state: 'unknown-issue', commits: [] };
  const branch = Array.isArray(row.branches) ? row.branches.find(Boolean) : null;
  if (!branch) return { state: 'no-branch', branch: null, commits: [] };
  if (!(await branchExists(branch))) return { state: 'branch-absent', branch, commits: [] };

  // Commits on the branch that aren't on main — the work this issue added. A
  // repo with no main to compare against lists the branch's own recent history.
  const base = (await git(['rev-parse', '--verify', '--quiet', 'main'])).ok ? 'main' : null;
  const range = base ? `${base}..${branch}` : branch;
  const r = await git(['log', range, '--no-merges', '--format=%H%x1f%h%x1f%s%x1f%aI', '--max-count=50']);
  if (!r.ok) return { state: 'branch-absent', branch, commits: [] };
  const commits = r.out.split('\n').filter(Boolean).map((line) => {
    const [sha, short, subject, date] = line.split('\x1f');
    return { sha, short, subject, date };
  });
  return { state: commits.length ? 'ok' : 'no-commits', branch, merged: !!base, commits };
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

// Whether a linked chat can run on this machine, and where. A live PTY — in this
// process OR in another dash server on this machine — answers without touching
// disk; the attach path redirects to that owner, so reporting it resumable+live
// is honest, and reporting it dormant would invite a duplicate cold resume.
// Otherwise its transcript decides (resolveChat).
//
// The ONE reading of runnability: the env list renders it per chat, and the
// main-thread invariant (ensureMainChat) decides on it. Two readings would be
// two chances to disagree about whether a chat exists.
//
// `updated` — when the chat last SAID anything — is the switcher's whole sort
// key, so it has to be true for a LIVE chat too. It used to be hard-coded 0 for
// them ("it's writing now, it needs no timestamp") and the list compensated by
// floating live chats above every timestamp, which is exactly how a chat left
// open since yesterday outranked the one you spoke in a minute ago. A live chat
// pays the same transcript resolve as any other; that costs one directory scan
// (~3ms across 230 project dirs here) and there are at most a couple of live
// chats per environment.
//
// A chat whose PTY is up but whose agent has not written a transcript line yet —
// the first seconds of a freshly spawned one — has no mtime to read, so it falls
// back to when its PTY started. That IS the last thing it did, and without it a
// brand-new chat would sort to the bottom of the list that just made it.
//
// The fallback FILLS a gap; it does not compete. Taking the later of the two
// would make merely RESUMING an old chat — which stamps a PTY start of "now" —
// outrank the chat you actually spoke in, and a restart resumes every chat the
// journal left behind at once, which would reshuffle the whole list by boot
// order. A chat that has a transcript is judged on it, always; the resume writes
// to that transcript within seconds anyway, and then it has earned the top spot.
//
// The supervisor holds every PTY in one process, so its live map is the whole
// answer — there is no other server on this machine to ask.
async function chatRunState(sessionId) {
  const session = globalThis.__labChats?.get(sessionId);
  const live = liveSession(session) ? session : null;
  const { resumable, restorable, cwd, updated } = await resolveChat(sessionId);
  if (!live) return { resumable, restorable, live: false, cwd, updated };
  return { resumable: true, restorable: false, live: true, cwd: null, updated: updated || live.startedAt || 0 };
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
  const isMain = env === MAIN_ENV;
  // ONE snapshot of the issue's shared row (null for MAIN, which reads its
  // machine-local stores instead): the conversations list, the chat_meta, and the
  // branch→issue resolution for derived Cursor chats all come off this single
  // read. Three separate reads of the same row would be three round-trips and
  // three chances to disagree.
  const row = isMain ? null : await (await import('./issues-store.mjs')).get(env).catch(() => null);
  const conversations = (await chatHandlesFor(env, row)).map(parseHandle);
  // Names, numbers AND ownership ride along with the list so the switcher renders
  // from ONE response — no second fetch, and no window where the trigger shows a
  // chat's number before its name lands.
  const meta = await chatMetaFor(env, row);
  // MAIN's workspace is the repo root — always present; an issue's is its
  // worktree dir (null until created).
  const dir = isMain ? MAIN_REPO : resolveWorktreeDir(env);
  // Resolve conversations SEQUENTIALLY, not via Promise.all: board-load already
  // mounts in-progress issues a couple at a time, and each unresolved transcript
  // is a full transcript-store scan. Resolving an issue's convos one-by-one
  // keeps the in-flight scan count bounded by the issue throttle (≈2) rather than
  // 2 × convos-per-issue. A live PTY short-circuits the scan entirely.
  const chats = [];
  for (const { sessionId, agent, role } of conversations) {
    const m = meta[sessionId] || {};
    // `name` null = the chat goes by its `ordinal` ("chat 2"), stamped when it
    // was linked and never recomputed. `owner`/`host` say whose computer it was
    // created on, so a chat that can't run here can still say who it belongs to
    // instead of reading as broken.
    const base = {
      sessionId, agent, role,
      name: m.name || null, ordinal: Number.isInteger(m.ordinal) ? m.ordinal : null,
      owner: m.owner || null, host: m.host || null,
    };
    chats.push({ ...base, ...(await chatRunState(sessionId)) });
  }
  // WHICH computer this is, so the client can tell "lives on someone else's
  // machine" from "was created here but its transcript is gone" — two different
  // sentences, and only the row's recorded host can separate them.
  const { machineName } = await import('./operator.mjs');
  const host = machineName();

  // Chats nothing LINKED but that plainly belong here — a Cursor conversation,
  // whose editor records the folder it ran in and nothing about issues. The
  // folder places it, so these are derived rather than stored: no write to the
  // shared row, no membership anyone has to curate, and unlinking one would be
  // meaningless because it was never linked. They can never run here (Cursor is
  // not a CLI), so they arrive read-only and stay that way.
  //
  // A folder resolves to its issue by id OR branch — a branch-named worktree's
  // folder is its branch, not the issue id — so match through the SAME
  // workspaceIssueMap the mirror uses, or those chats vanish from their own issue.
  // Built from the single row snapshot above: we only ask whether a folder
  // resolves to THIS env, and that env's own row carries every branch it could.
  const issueOf = workspaceIssueMap(row ? [row] : []);
  const linked = new Set(chats.map(c => c.sessionId));
  for (const c of await discoverChatsAny()) {
    if (linked.has(c.sessionId) || issueOf.get(workspaceForDir(c.dir)) !== env) continue;
    // No `ordinal`: nothing linked these, so nothing ever numbered them. They go
    // by the title their editor gave them, or by their handle — never by a
    // position, which is the one thing a name must not be.
    chats.push({
      sessionId: c.sessionId, agent: c.agent, name: c.title || null, ordinal: null,
      owner: null, host, role: null,
      resumable: false, restorable: false, live: false, cwd: c.dir,
      updated: c.updatedAt ? Date.parse(c.updatedAt) || 0 : 0,
    });
  }
  return { worktree: !!dir, dir, chats, machine: host };
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
  // The supervisor is the only PTY host on this machine, so the in-memory map
  // IS machine-wide liveness — the cross-server registry scan this used to do
  // died with the multi-dash model.
  return out;
}

// --- live PTYs, keyed by SESSION ID ---

// Each session: { pty, issueId, journal, buffer:[], cols, rows,
// attached:Set<ws>, geomOwner:ws|null, exited, shape }. Any number of sockets
// may attach (output is broadcast); the PTY grid belongs to the socket that
// last asserted one (sent a resize) — never to a socket merely for attaching.
// On globalThis so the test host's fresh module imports share one map; the
// supervisor itself never re-evaluates this module (no HMR), which is what
// retired the old shape-stamp/retirement machinery.
if (!globalThis.__labChats) globalThis.__labChats = new Map();
const chats = globalThis.__labChats;

// The session object's contract version — stamped so a TEST that plants a
// malformed entry (or a future host that somehow double-evaluates) can never
// hand live paths an object they don't understand: liveSession contains every
// property read, so even a throwing getter classifies as not-reusable.
export const CHAT_SHAPE = 3;
const liveSession = (s) => {
  try { return !!s && !s.exited && s.shape === CHAT_SHAPE; } catch { return false; }
};

// --- crash journal ---
//
// PTY liveness is PROCESS-scoped now: the supervisor is the only PTY host on
// this machine, so the in-memory chats map is the whole liveness story while it
// runs. What survives it is the crash journal (chat-journal.mjs): a provisional
// record opened before each spawn, stamped with the child's verified identity
// after, and durably cleared on natural exit. Boot reconciliation resumes what
// a crash stranded and parks what it cannot prove — see reconcileChats below.
// The old distributed claim/tomb registry (per-key O_EXCL claims, cross-server
// redirects, lock-free reclaim) died with the multi-dash model that needed it.

// A chat map-key is untrusted — the session id rides in on a WebSocket query
// param — so it is validated before it can key anything. The only legal shape
// is a uuid: every chat — issue AND main — is keyed by its session uuid.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validKey = (key) => typeof key === 'string' && UUID_RE.test(key);

// Boot reconciliation — the supervisor calls this once, after its middlewares
// are mounted. The journal's state machine classifies every record (see
// chat-journal.mjs); this side only supplies HOW to resume one: the same
// guards the human attach path uses, then a spawn with the restart note.
export async function reconcileChats() {
  const { resumed, blocked } = await reconcile({ resume: resumeJournalRecord });
  if (resumed.length) console.log(`restored ${resumed.length} chat(s) the previous supervisor was running`);
  for (const { rec, reason } of blocked) {
    console.error(`[journal] BLOCKED ${rec.sessionId || rec.operationId}: ${reason} — not respawned; clear ${'journal.' + rec.operationId + '.json'} once resolved`);
  }
  const legacy = await importLegacyChats();
  return { resumed: resumed.length, blocked: blocked.length, legacy };
}

// One-shot migration from the pre-supervisor world, run as part of every boot
// reconciliation — the first NEW boot on a machine imports whatever the old
// per-dash registry left behind, and later boots find nothing (imported files
// are deleted). Classification is the cutover contract: `finished` records and
// unresumable strays are endings (deleted); a record whose stamped agent child
// still runs is BLOCKED (kept + reported — the cutover stops the old fleet
// first, so this is the rare straggler); the rest resume with the restart
// note, exactly like journal records. Old lease files are inert to the new
// world and swept unconditionally.
async function importLegacyChats() {
  const { resumable, finished, blocked } = await importLegacyRegistry();
  let resumed = 0;
  for (const { file, entry } of resumable) {
    try {
      const ok = await resumeJournalRecord({
        sessionId: entry.sessionId, issueId: entry.issueId,
        cols: entry.cols, rows: entry.rows,
      });
      if (ok) resumed += 1;
    } catch (e) {
      console.error(`[legacy] ${String(entry.sessionId).slice(0, 8)} not imported: ${e.message}`);
      continue; // keep the file — evidence for the next boot
    }
    try { fs.unlinkSync(path.join(registryDir(), file)); } catch {}
  }
  for (const { file } of finished) {
    try { fs.unlinkSync(path.join(registryDir(), file)); } catch {}
  }
  // A blocked legacy record (its agent child still runs) converts INTO the
  // journal — state blocked, identity carried over — and its old-format file
  // is deleted: after this pass NOTHING reads the legacy format, and the next
  // boot reconsiders the record through the one remaining state machine.
  const alreadyConverted = new Set(
    (await import('./chat-journal.mjs')).journalRecords().map((r) => r.sessionId).filter(Boolean),
  );
  for (const { file, entry, reason } of blocked) {
    console.error(`[legacy] BLOCKED ${String(entry.sessionId).slice(0, 8)}: ${reason}`);
    // Idempotent: a crash between open/block/unlink re-runs this pass, and a
    // record already converted for this session must not be minted twice.
    if (alreadyConverted.has(entry.sessionId)) {
      try { fs.unlinkSync(path.join(registryDir(), file)); } catch {}
      continue;
    }
    try {
      journalImportBlocked({
        agent: entry.agent || 'claude', issueId: entry.issueId,
        sessionId: entry.sessionId, ptyPid: entry.ptyPid,
        ptyStartTime: entry.ptyStartTime, cols: entry.cols, rows: entry.rows,
      });
      fs.unlinkSync(path.join(registryDir(), file));
    } catch {}
  }
  let leases = 0;
  try {
    for (const f of fs.readdirSync(registryDir())) {
      const isLease = f.startsWith('lease.') && f.endsWith('.json');
      const isTomb = /\.reclaim\.\d+$/.test(f);
      if (isLease || isTomb) {
        try { fs.unlinkSync(path.join(registryDir(), f)); leases += 1; } catch {}
      }
    }
  } catch {}
  if (resumed || finished.length || blocked.length || leases) {
    console.log(`[legacy] imported: ${resumed} resumed, ${finished.length} finished cleared, ${blocked.length} blocked, ${leases} lease file(s) swept`);
  }
  return { resumed, finished: finished.length, blocked: blocked.length, leases };
}

// The note a restored chat wakes up to. It is a NOTE, not an instruction: the
// agent holds its own transcript and is the only thing that knows whether it was
// mid-task or waiting on Dennis, so the message states the mechanical fact and
// lets it decide. Anything phrased as "continue" would put words in Dennis's
// mouth for every chat that was simply waiting for him.
export const RESTART_NOTE = '[dash] The dash server restarted and reopened this chat — Dennis did not send this. If you were mid-task, pick up where you left off; if you were waiting on him, ignore this and stay put.';

// Resume one journal record's chat — the `resume` callback reconcileChats
// hands the journal. Every guard the human attach path uses applies, in the
// same order: a chat already live here is skipped (idempotent re-entry), an
// agent process still carrying this session id anywhere on the machine blocks
// the resume (fail-closed pgrep), and a chat whose transcript or working
// directory is gone — a merged worktree, a Cursor conversation the dash cannot
// drive — is simply not resumable. Returns true iff a PTY is now running for
// the record, so the journal knows to close it (false = an ending: cleared).
async function resumeJournalRecord(rec) {
  if (!validKey(rec.sessionId)) return false;
  if (liveSession(chats.get(rec.sessionId))) return true;
  if (await sessionProcessAlive(rec.sessionId)) throw new Error('session process alive outside the supervisor');
  const { resumable, cwd, agent } = await resolveChat(rec.sessionId);
  if (!resumable) return false;
  const session = spawnChat({
    issueId: rec.issueId, sessionId: rec.sessionId, mode: 'resume', cwd,
    cols: rec.cols || 100, rows: rec.rows || 30,
    initialPrompt: RESTART_NOTE, key: rec.sessionId, agent,
  });
  return !!session;
}

// END a chat for good: kill its PTY, close its journal record, drop it from
// the map. This is the deliberate ending — /merge and /reject tearing down a
// landed issue, the reaper stopping an idle chat — as opposed to a supervisor
// shutdown, which leaves journal records so the next boot resumes them.
// Closing the journal is what keeps a reaped chat dead: without it the next
// boot would resurrect the very chat the reaper stopped. Idempotent; returns
// whether a live PTY was actually killed, so a caller can tell "torn down"
// from "was already gone".
// Abort a spawned child DELIBERATELY: kill, await confirmed death, and only
// then clear the journal — a resister keeps an 'ending' record the next boot
// re-kills and clears (never resumes). Every post-spawn abort routes through
// here (endChat, codex's rollout-timeout and duplicate-id aborts), so the
// confirmed-death contract cannot drift per call site.
async function abortSpawnedChild(journal, ptyLike) {
  const pid = journal?.ptyPid ?? ptyLike?.pid;
  const died = await terminateVerified(pid, journal?.ptyStartTime);
  if (!journal) return;
  if (died) journalClose(journal);
  else journalEnd(journal);
}

// Removing a chat from the map and ending its detector are ONE act. The
// detector is a view of a live PTY, so "not in the map but still publishing" is
// never a state worth having — it would leave a needs-input dot on a card whose
// chat the reaper stopped, and leak an emulator per ended chat. Both endings go
// through here so a third one cannot forget; `dash/chat-activity.test.mjs`
// refuses any other `chats.delete`.
function dropChat(mapKey, session) {
  chats.delete(mapKey);
  closeSession(session.sessionId);
}

export async function endChat(sessionId) {
  const session = chats.get(sessionId);
  const wasLive = liveSession(session);
  if (session) {
    try { session.exited = true; } catch {}
    dropChat(sessionId, session);
    await abortSpawnedChild(session.journal, session.pty);
  }
  return wasLive;
}

// Kill every live PTY on the way down, leaving journal records IN PLACE: a
// supervisor stop (graceful or not) is "something took these chats down", and
// the untouched records are exactly what the next boot's reconciliation
// resumes. Nothing waits for the children to die — reconcile verifies the
// stamped child identity before ever spawning over one.
let _shuttingDown = false;
function shutdownChats() {
  if (_shuttingDown) return;
  _shuttingDown = true;
  for (const [, s] of chats) {
    // The TREE, not the leader: node-pty's own kill signals the bare pid, which
    // left codex's helper processes running — and a helper that survives can
    // still hold the thread's rollout open, so the very next card-open collided
    // with a writer nothing owned (i-codex-resume-collision). Reconciliation
    // has always signalled the group; shutdown now agrees.
    try { s.exited = true; signalTree(s.pty?.pid); } catch {}
    closeSession(s.sessionId); // the detector dies with the PTY it reads
  }
  chats.clear();
}

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

// EVERY BYTE IN AND OUT OF A CHAT, on demand. Every hard question about this
// system is "what was on that screen, and who put it there" — a pane forwards
// its terminal's own device/focus replies as PTY input, a stale socket can send
// late, and a stand-in echoes all of it back as output. Guessing between those
// costs hours; a timestamped, escaped trace answers it in one run. Off unless
// DASH_PTY_TRACE is set, because it is a firehose of agent output.
const PTY_TRACE = !!process.env.DASH_PTY_TRACE;
function trace(dir, sessionId, data) {
  if (!PTY_TRACE) return;
  const shown = JSON.stringify(String(data).slice(0, 200));
  console.log(`[pty-trace] ${Date.now()} ${dir} ${String(sessionId).slice(0, 8)} ${data.length}b ${shown}`);
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
// run the work end-to-end on its own. `/change` is the one protocol; `flow`
// only says whether this issue is a reported regression, which makes /change
// run its reproduce prelude (step 0c) first. Codex has no Claude-Code skills,
// so it gets a plain-language end-to-end instruction. The human opens the card
// later to monitor/unblock, not to kick it off.
export function autonomousChatIntro(issueId, title, flow = 'change', agent = DEFAULT_AGENT, status = null) {
  const named = title ? `\`${issueId}\` — "${title}"` : `\`${issueId}\``;
  const tail = `confirm the scope to yourself and proceed without waiting for further direction. A human will open this chat to monitor and unblock you, not to start you. When the work is candidate-complete, present receipts and the live preview link per the protocol.`;
  const st = statusClause(status);
  // Codex has no Claude-Code skills — give it a plain-language end-to-end brief.
  if (agent === 'codex') {
    return `This chat is scoped to issue ${named}${st}, and you were launched autonomously to implement it end-to-end. Run \`node scripts/board.mjs get ${issueId}\` to load the full issue, then implement it fully — ${tail}`;
  }
  const regression = flow === 'bug'
    ? ' This issue is a reported regression, so run `/change`\u2019s reproduce prelude (step 0c) before fixing.'
    : '';
  return `This chat is scoped to issue ${named}${st}, and you were launched autonomously to implement it end-to-end. Run \`node scripts/board.mjs get ${issueId}\` to load the full issue, then invoke the \`/change\` skill and carry it through to completion.${regression} — ${tail}`;
}

// Intro for a REVIEWER chat — a chat spawned to REVIEW the change on this
// worktree's branch, not to implement anything. It rides the same eager
// server-side spawn as an autonomous kick-off (so the PTY survives the launcher's
// turn cycle — the whole reason reviewers moved off the reaped background bash),
// but the brief points it at the diff and asks for findings, not edits. Agent-
// agnostic: codex or claude both gather their own context from git + the source.
export function reviewerChatIntro(issueId, title) {
  const named = title ? `\`${issueId}\` — "${title}"` : `\`${issueId}\``;
  return `You are a CODE REVIEWER for issue ${named}. A change was implemented on THIS branch (the worktree you are in) — review it, do NOT edit any files. Run \`git status\` first. The change under review is usually the UNCOMMITTED working tree, so start with \`git diff HEAD\` (and if that's empty, the branch is committed — use \`git show HEAD\` / \`git diff HEAD~1\`). Ignore unrelated pre-existing divergence from \`main\` — review only THIS change. Read both CLAUDE.md files for the project's principles, then read the changed source. Report, most-severe first and each with a \`file:line\`: correctness bugs and broken edge cases (give a concrete failing input → wrong output); contract/interface violations; and change-philosophy problems (a band-aid over a wrong model, a pattern that should have been unified, a backwards-compat shim that should have been a deletion, a name that lies). Be concise and specific. If nothing would block merge, say so plainly. You are the reviewer — end with your findings rather than offering to implement fixes.`;
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
  // an issue id) and rides into the session object + journal record.
  const mapKey = key || sessionId;
  // In-process idempotence: the attach/deliver paths await I/O between their
  // "no live session" check and this call, so two concurrent requests can both
  // reach here for one key. The map is the guard: a live PTY for the key IS the
  // spawn — and with one supervisor hosting every PTY on the machine, the map
  // is the whole ownership story.
  const existing = chats.get(mapKey);
  if (liveSession(existing)) return existing;
  const adapter = agentById(agent);
  const bin = adapter.bin();
  // The CLI isn't on this computer. Refuse with a typed error, so the attach
  // boundary can turn it into install guidance instead of a raw `spawn …
  // ENOENT` in the terminal pane.
  if (!bin) throw new AgentMissingError(adapter.id);
  // Test stand-in (LAB_TERMINAL_CMD / LAB_CODEX_CMD, e.g. /bin/cat) takes no CLI
  // flags — it must just echo. The real CLI gets its agent-specific argv. The
  // adapter is the single authority on whether a stand-in is in play, so this
  // can't disagree with what bin() actually resolved.
  const isStandIn = !!adapter.standInCmd();
  const args = isStandIn ? [] : adapter.buildArgs({ mode, sessionId, initialPrompt, model, effort });

  // Intent BEFORE spawn: if we crash between here and the stamp, reconciliation
  // finds a provisional record and parks it rather than guessing.
  const journal = journalOpen({ agent, issueId, cwd, requestedSessionId: sessionId, cols, rows });
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
    // The spawn itself failed: nothing to recover at the next boot.
    journalClose(journal);
    throw e;
  }

  return wireSession(term, { issueId, sessionId, mapKey, agent, cols, rows, journal });
}

// Adopt a freshly-spawned PTY into the live-chat machinery: build the session
// object, stamp the journal with the child's identity (ptyPid + start time —
// and, for codex, the discovered session id), register it in the chats map,
// and wire output/exit. Shared by spawnChat (id known up front) and
// spawnCodexNewChat (id discovered after spawn).
//
// `pre` is whatever the child already printed before we got here. A codex chat
// spends SECONDS between spawn and this call while its id is discovered, and
// everything it drew in that window — its boot, and the status line that says
// it is working — used to be dropped on the floor. That cost the reattach
// buffer a chunk of scrollback, and it costs the detector its whole screen: an
// emulator that never saw the status line reads a blank viewport, so a codex
// chat that goes quiet inside a tool would flip to "needs input" mid-turn.
// Replaying it makes the two paths identical — every byte the child wrote is
// buffered and fed, whichever spawn shape produced it.
function wireSession(term, { issueId, sessionId, mapKey, agent, cols, rows, journal, pre }) {
  const session = {
    pty: term, issueId, sessionId, agent, journal,
    // When this PTY came up — the chat's last activity until its agent writes a
    // first transcript line, which is what keeps a just-spawned chat at the top
    // of a list sorted purely on activity (chatRunState).
    startedAt: Date.now(),
    buffer: [], cols: cols || 100, rows: rows || 30,
    attached: new Set(), geomOwner: null, exited: false, shape: CHAT_SHAPE,
  };
  chats.set(mapKey, session);
  journalStamp(journal, { ptyPid: term.pid, sessionId });
  // Working / needs-input detection starts with the PTY and ends with it — the
  // supervisor's detector, not a browser pane's (see chat-activity.mjs).
  openSession(session.sessionId, { agent, cols: session.cols, rows: session.rows });
  for (const data of pre || []) {
    bufferPush(session, data);
    feedSession(session.sessionId, data);
  }

  term.onData((data) => {
    trace('out', session.sessionId, data);
    bufferPush(session, data);
    feedSession(session.sessionId, data);
    broadcast(session, { type: 'output', data });
  });
  term.onExit(({ exitCode }) => {
    session.exited = true;
    broadcast(session, { type: 'exit', code: exitCode });
    // Only remove OUR OWN map entry: a successor PTY may already own this key
    // (kill old chat → immediately respawn), and a stale exit firing late must
    // not evict it. The journal close is the durable "this chat ended on its
    // own" mark — gated the same way so a late stale exit can't clear a
    // successor's record.
    if (chats.get(mapKey) === session) { dropChat(mapKey, session); journalClose(journal); }
  });

  return session;
}

// Spawn a NEW codex chat and reconcile its identity. Codex mints its own session
// id, so — unlike claude — the id doesn't exist until after spawn: we open a
// provisional journal record (requestedSessionId null), spawn codex in the
// worktree, read the id back from the rollout it writes (discoverSessionId,
// matched by cwd + recency), then stamp the record with the real id — the
// journal's promotion point. Returns { session, sessionId } or { error }.
async function spawnCodexNewChat({ issueId, cwd, cols, rows, initialPrompt, model }) {
  const adapter = agentById('codex');
  const bin = adapter.bin();
  // Codex isn't installed here — same typed refusal as the claude path, so the
  // create endpoint answers with install guidance instead of an ENOENT throw.
  if (!bin) throw new AgentMissingError(adapter.id);
  const isStandIn = !!adapter.standInCmd();
  const args = isStandIn ? [] : adapter.buildArgs({ mode: 'new', initialPrompt, model });
  // Exclude every rollout that existed before this child. The caller may itself
  // be a live Codex chat in this same worktree; its rollout can advance during
  // discovery and must never be adopted as the newly spawned chat.
  const priorRollouts = await adapter.rolloutInventory();
  const since = Date.now();

  const journal = journalOpen({ agent: 'codex', issueId, cwd, requestedSessionId: null, cols, rows });
  let term;
  try {
    term = pty.spawn(bin, args, {
      name: 'xterm-256color', cols: cols || 100, rows: rows || 30, cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
  } catch (e) { journalClose(journal); return { error: `codex spawn failed: ${e.message}` }; }
  // Hold everything the child prints while its id is being discovered. Attached
  // BEFORE the first await, so nothing is missed; handed to wireSession, which
  // replays it into the buffer and the detector (see wireSession's note).
  const pre = [];
  const preTap = term.onData((d) => pre.push(d));
  // Identity NOW, id later: rollout discovery takes seconds, and a crash in
  // that window must leave a record naming a verifiable child (reconcile then
  // terminates it and clears — there is nothing to resume, the chat never
  // spoke) rather than an identity-free record parked as blocked forever.
  journalStamp(journal, { ptyPid: term.pid });

  const sessionId = await adapter.discoverSessionId({ cwd, sinceMs: since, excludeRollouts: priorRollouts });
  if (!sessionId) {
    preTap.dispose();
    await abortSpawnedChild(journal, term);
    return { error: 'could not determine codex session id (no rollout written) — is codex installed and authenticated?' };
  }
  // A live PTY for this brand-new id would only exist if we somehow spawned
  // twice — the map guard.
  const existing = chats.get(sessionId);
  if (liveSession(existing)) { preTap.dispose(); await abortSpawnedChild(journal, term); return { session: existing, sessionId }; }
  // Stop tapping and hand over in the SAME synchronous step wireSession wires
  // its own listener, so no byte falls between the two.
  preTap.dispose();
  const session = wireSession(term, { issueId, sessionId, mapKey: sessionId, agent: 'codex', cols, rows, journal, pre });
  return { session, sessionId };
}

// --- The MAIN thread: one always-present, always-running chat ---------------
//
// Main differs from an issue in one behavioral way: an issue's chats are opt-in
// (its empty state waits for a click), while main ALWAYS has a thread. That
// invariant lives HERE, on the server, because only the server can settle it:
// it owns the list (main-chats-store) and the PTY table, and can read both in
// one uninterrupted step. The client used to assert it — comparing a chat list
// against a local snapshot and minting when the snapshot looked empty — and a
// snapshot assembled from several async sources is empty long before it is
// EMPTY. Every page load re-ran that comparison against a not-yet-answered list
// and minted another thread (i-main-chat-refresh).
//
// EAGERLY SPAWNED. A main chat is started at creation, not when a browser
// happens to attach. That is what makes the invariant checkable by the NEXT
// caller — a linked uuid with no PTY and no transcript is indistinguishable from
// a dead entry, so a lazily-spawned thread would leave a window in which two
// tabs (or two refreshes) each see "no thread" and each make one. Starting it
// also means main's list stops accumulating linked-but-never-run ids.
async function createMainChat(agent = DEFAULT_AGENT) {
  const intro = mainChatIntro(agent);
  const spawnArgs = { issueId: MAIN_ENV, cwd: MAIN_REPO, cols: 100, rows: 30, initialPrompt: intro };
  // CODEX mints its own id, so it is spawned first and linked with the id it
  // chose; CLAUDE takes a dash-minted uuid, so it is linked first and spawned
  // under that id. Same two orders the issue create path uses.
  if (!agentById(agent).dashMintsId) {
    const r = await spawnCodexNewChat({ ...spawnArgs });
    if (r.error) return { error: r.error };
    const link = await linkChat(MAIN_ENV, r.sessionId, agent);
    if (link?.error) {
      // Never leak a live, unlinked agent — it would be invisible to the board
      // and unaddressable. Tear it down; the caller retries.
      // Same teardown the issue path uses: a link failure strands a live,
      // UNLINKED codex process, and endChat is the one call that ends a chat for
      // good — kill, drop, and leave NO record, so the next boot has nothing to
      // resurrect. Hand-rolling the triple here would be a second copy of the
      // ending, and the two would drift the moment the ledger gains a state.
      await endChat(r.sessionId);
      return { error: `link failed: ${link.error}` };
    }
    return { sessionId: r.sessionId, agent };
  }
  const sessionId = crypto.randomUUID();
  const link = await linkChat(MAIN_ENV, sessionId, agent);
  if (link?.error) return { error: `link failed: ${link.error}` };
  const spawned = spawnChat({ ...spawnArgs, sessionId, mode: 'new', key: sessionId, agent });
  if (!spawned) return { error: 'chat is live in another dash server' };
  return { sessionId, agent };
}

// Single-flight: N tabs opening at once ask N times, and the answer must be one
// thread, not N. The in-flight promise makes concurrent ensures share ONE
// decision rather than each racing its own read→create window. (The supervisor
// is the machine's only PTY host, so in-process is the whole contention
// surface.)
let ensuringMain = null;

// Main's thread, creating it only when there genuinely isn't one. Idempotent:
// call it on every open, from every tab; it answers with the existing thread
// unless main has none that can run here.
//
// "Can run here" is live-or-resumable — a live PTY, or a transcript whose cwd
// still exists. A list of ids whose transcripts are gone is not a thread, and
// neither is somebody's read-only Cursor conversation in the repo root (never
// linked, never launchable), so both fall through to creating a real one.
export function ensureMainChat(agent = DEFAULT_AGENT) {
  if (ensuringMain) return ensuringMain;
  ensuringMain = (async () => {
    // Only LINKED chats can be main's thread: a derived Cursor conversation in
    // the repo root was never linked and can never be launched, so the list read
    // here is the store's, not issueChats' (which also discovers those).
    const linked = mainChatsList().map(parseHandle).filter(h => isLaunchable(h.agent));
    // LIVE first, and cheaply — a running PTY is a map lookup plus a registry
    // read, while resumability means scanning transcripts off disk. Newest-last
    // is switcher order, so scanning from the end lands on the thread you were
    // last talking to.
    const found = (h) => ({ ok: true, sessionId: h.sessionId, agent: h.agent, mode: 'resume', created: false });
    for (let i = linked.length - 1; i >= 0; i--) {
      if ((await chatRunState(linked[i].sessionId)).live) return found(linked[i]);
    }
    for (let i = linked.length - 1; i >= 0; i--) {
      if ((await chatRunState(linked[i].sessionId)).resumable) return found(linked[i]);
    }
    const r = await createMainChat(agent);
    if (r.error) return r;
    return { ok: true, sessionId: r.sessionId, agent: r.agent, mode: 'new', created: true };
  })().finally(() => { ensuringMain = null; });
  return ensuringMain;
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
    // The CLI simply isn't installed here. That is a normal state on a fresh
    // machine, not a crash — report it as its own kind so the pane can render
    // install guidance instead of printing `spawn claude ENOENT` at someone who
    // has no way to read that. Typed, never text-matched.
    if (e instanceof AgentMissingError) {
      try { send(ws, { type: 'exit', code: null, error: e.message, reason: 'agent-missing', agent: e.agent, install: e.install }); } catch {}
      try { ws.close(1011, 'agent not installed'); } catch {}
      return;
    }
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
      // A process holding this session — a manual `claude --resume` /
      // `codex resume`, an orphan whose supervisor died, a chat still winding
      // down after a graceful stop — must not be resumed OVER: that forks the
      // transcript, and codex refuses outright. If the chat is one this
      // environment owns, take it back; otherwise say so honestly.
      if (cwd && !(await reclaimSession(issueId, sessionId))) {
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
      send(ws, { type: 'exit', code: null, error: 'chat could not be started' });
      try { ws.close(1011, 'chat spawn refused'); } catch {}
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
        trace('in', session.sessionId, msg.data);
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
          // The emulator behind needs-input detection is the same grid the PTY
          // writes into; a frame is only readable in the grid it was formatted
          // for, so geometry moves to both or to neither.
          resizeSession(session.sessionId, cols, rows);
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
// GET  /api/dash/terminal/chats?issue=<id>   → { worktree, dir, port, chats:[{sessionId,agent,name,resumable}] }
// POST /api/dash/terminal/main-chat { agent? }
//                                             → ensure main's always-present thread (idempotent)
//                                               → { ok, sessionId, agent, mode, created }
// POST /api/dash/terminal/chat-name { issue, session, name }
//                                             → set/clear a chat's custom label → { ok, names }
// POST /api/dash/terminal/worktree { issue, session? }
//                                             → creates worktree (idempotent) + reserves port → { ok, dir, created, port }
//                                               with `session`, rebuilds it at THAT chat's
//                                               recorded path, so the chat can resume there
// POST /api/dash/terminal/chat     { issue }  → ensures worktree + reserves port + mints a new chat
//                                              (uuid), links it → { ok, sessionId, mode:'new', port }
// GET  /api/dash/terminal/activity            → { sessions: { <session>: {state, since} } }
// GET  /api/dash/terminal/activity/stream     → SSE: `snapshot` then `update` frames
// GET  /api/dash/terminal/<id>/open           → lazy-start the issue's dev server, 302→ <same host>:<port>/
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
    if (issueId === MAIN_ENV) {
      // Main has no reserved port (its app preview rides the origin) and no
      // shared issue row — its selected chat is per-browser (localStorage).
      data.port = null;
      data.selected_session = null;
    } else {
      // ONE row read for BOTH the reserved dev-server port and the explicit
      // selected chat, so the switcher's auto-open sees the shared choice.
      const { get } = await import('./issues-store.mjs');
      const row = await get(issueId).catch(() => null);
      data.port = row && row.port != null ? Number(row.port) : null;
      data.selected_session = row?.selected_session ?? null;
    }
    return json(data);
  }

  // /api/dash/terminal/commits — what has landed on the issue's branch, read
  // from git through the branch recorded on the row. The OPEN card asks for this;
  // the board list never does (one git call per card is the freeze we don't want).
  if (req.method === 'GET' && segs[0] === 'commits') {
    const issueId = new URL(req.url, 'http://x').searchParams.get('issue');
    if (!issueId) return json({ error: 'issue required' }, 400);
    return json(await issueCommits(issueId));
  }

  // /api/dash/terminal/agents — which agent CLIs this computer can actually run,
  // with install guidance for the ones it can't. The new-chat picker reads this
  // so an uninstalled agent is visibly unavailable before you click it, rather
  // than failing at spawn with a raw ENOENT.
  if (req.method === 'GET' && segs[0] === 'agents') {
    return json({ agents: agentAvailability() });
  }

  // /api/dash/terminal/transcript — a session's spoken turns, for agent-to-agent
  // reads. `after` = the previous response's cursor for incremental polling.
  //
  // Local first, then the SHARED COPY. An agent asking about a chat is a reader
  // like any other, so "not on this machine" stopped being the end of the
  // answer: a teammate's chat reads here exactly as it does in the pane, in the
  // same shape, with `mirrored: true` saying which copy answered. Local stays
  // first because it is live and exact — the mirror lags by a sweep.
  if (req.method === 'GET' && segs[0] === 'transcript') {
    const q = new URL(req.url, 'http://x').searchParams;
    const sessionId = q.get('session');
    if (!sessionId) return json({ error: 'session required' }, 400);
    const after = Math.max(0, parseInt(q.get('after') || '0', 10) || 0);
    const t = await readTranscript(sessionId, after);
    if (t) return json({ ...t, mirrored: false });
    const { mirroredChat, mirroredTurns } = await import('./chat-mirror.mjs');
    const chat = await mirroredChat(sessionId).catch(() => null);
    if (!chat) return json({ error: `no transcript for session "${sessionId}", here or in the shared copy` }, 404);
    // `after` is a position in the SOURCE transcript for both copies (that is
    // what `idx` records), so an incremental poll behaves identically whichever
    // copy answers it.
    const rows = await mirroredTurns(sessionId, after - 1);
    return json({
      sessionId, agent: chat.agent, live: false, mirrored: true,
      owner: chat.owner, host: chat.host,
      messages: rows.map(r => ({ i: r.idx, role: r.role, text: r.text, timestamp: r.ts })),
      cursor: chat.cursor,
    });
  }

  // /api/dash/terminal/mirror — push this machine's chats to the shared corpus
  // NOW, rather than waiting for the next sweep. The sweep is the normal path;
  // this is the "sync it, I'm watching" affordance (and what the tests drive),
  // and it is the same one pass either way.
  if (req.method === 'POST' && segs[0] === 'mirror') {
    const { mirrorSweep } = await import('./mirror-sweep.mjs');
    return json({ ok: true, ...(await mirrorSweep()) });
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

  // /api/dash/terminal/git-status?env=<main|issue-id> — that env's branch vs its
  // origin counterpart, ahead/behind. Fetches, so it's up to date, not stale.
  if (req.method === 'GET' && segs[0] === 'git-status') {
    const env = new URL(req.url, 'http://x').searchParams.get('env') || MAIN_ENV;
    return json(await gitSyncStatus({ env }));
  }

  // /api/dash/terminal/git-sync { env } — one-click fast-forward-pull + push of
  // that env's branch. A divergence drops a note into the env's chat and returns
  // { conflict:true }.
  if (req.method === 'POST' && segs[0] === 'git-sync') {
    const { env } = await readBody();
    const r = await gitSync({ env: env || MAIN_ENV });
    return json(r, r.ok ? 200 : (r.status || 200));
  }

  // /api/dash/terminal/live — the live server-side PTYs as {issue, session}
  // pairs. Cheap (in-memory map, no fs/spawn); board-load auto-attach seeds from
  // this so it only ever REATTACHES existing live chats, never cold-spawns
  // dormant ones.
  if (req.method === 'GET' && segs[0] === 'live') {
    return json({ sessions: await liveSessionChats() });
  }

  // /api/dash/terminal/activity[/stream] — what every live chat on this machine
  // is DOING, as the supervisor sees it (chat-activity.mjs).
  //
  // The stream opens with a full SNAPSHOT and only then sends deltas, which is
  // the whole point: a board that has just loaded knows every dot from its
  // first frame instead of watching them arrive as panes mount. `since` stamps
  // when each state began — the episode identity a client's "I've seen it"
  // dismissal is keyed to. The plain GET is the same truth without a socket,
  // for a caller that only wants to look once.
  if (req.method === 'GET' && segs[0] === 'activity') {
    if (segs[1] !== 'stream') return json({ sessions: activitySnapshot() });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // Say it to every proxy in the path: this response is not a document to
      // be collected before forwarding.
      'X-Accel-Buffering': 'no',
    });
    const frame = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ } };
    frame('snapshot', activitySnapshot());
    const off = subscribeActivity((u) => frame('update', u));
    // A comment line keeps idle intermediaries from collecting the connection.
    const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* client gone */ } }, 25000);
    beat.unref?.();
    const stop = () => { off(); clearInterval(beat); };
    req.on('close', stop);
    res.on('close', stop);
    return undefined;
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
    // The host comes from the REQUEST, not a literal: on a box the browser is
    // somewhere else and `localhost:<port>` would be the viewer's own laptop.
    // Safe to build from — ws-guard already refused every Host but loopback and
    // the operator's declared ones. See dash/src/same-host-origin.mjs.
    const origin = sameHostOriginFor(req, port);
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
  //
  // With `session`, the worktree is built at the path THAT CHAT recorded rather
  // than at the id-derived one — which is what brings a chat whose workspace was
  // collected back to life. It has to be that exact path: a chat's home is read
  // from its transcript's first cwd line and never changes, so a workspace
  // rebuilt elsewhere would leave resolveChat saying cwd-gone forever. Same act,
  // same idempotence, same port reservation: resurrection is creation aimed at a
  // remembered path, not a second mechanism.
  if (req.method === 'POST' && segs[0] === 'worktree') {
    const { issue, session } = await readBody();
    if (!issue) return json({ error: 'issue required' }, 400);
    if (!(await issueExists(issue))) return json({ error: `no such issue "${issue}"` }, 404);
    let dir = null;
    let chatCwd = null;
    if (session) {
      if (!validKey(session)) return json({ error: 'invalid session id' }, 400);
      // The chat must be THIS issue's. Restoring writes to the issue's row (its
      // branch, its port) and to a directory the chat chose, so an unrelated
      // session would let one card be rebuilt around another card's work. Same
      // gate the message path uses — membership, by parsed handle.
      if (!(await chatLinkedTo(issue, session))) {
        return json({ error: `session not linked to issue "${issue}"` }, 404);
      }
      const chat = await resolveChat(session);
      // Already runnable — the caller raced someone else, or the directory was
      // never gone. Reserve the port and report the workspace it has.
      if (!chat.resumable && !chat.restorable) {
        return json({ error: `chat cannot be restored here (${chat.reason})`, reason: chat.reason }, 409);
      }
      chatCwd = chat.cwd;
      const space = restorableWorkspace(chat.cwd);
      if (!space) return json({ error: 'that chat did not run in a worktree of this checkout' }, 409);
      // Membership is not OWNERSHIP. Issue↔chat links are many-to-many, so a
      // session legitimately linked to two issues would otherwise let either one
      // materialise ITS branch at the OTHER's directory — A's work checked out at
      // B's path, under B's name. The workspace is a separate claim, and the
      // board is what settles it: the folder must resolve to THIS issue (its id,
      // or a branch it records) or to no issue at all. A folder some other card
      // claims is that card's ground, whoever the chat belongs to.
      const claim = await workspaceClaimants(space.workspace);
      if (claim.error) return json({ error: claim.error }, 503);
      if (claim.ids.length && !claim.ids.includes(issue)) {
        return json({ error: `that chat's workspace "${space.workspace}" belongs to ${claim.ids.join(', ')} — reopen the chat from that card` }, 409);
      }
      dir = space.dir;
    }
    const r = await ensureWorktree(issue, { dir });
    // A TYPED reason decides the status, never the shape of the sentence: a
    // situation the caller can act on is a 409, a board we could not read is a
    // 503, a git failure is ours (500). Matching on error text would make the
    // message part of the interface, and rewording it would silently change what
    // clients are told.
    if (!r.ok) return json(r, WORKTREE_STATUS[r.reason] ?? 500);
    // A chat may have run in a SUBDIRECTORY of its workspace, and the branch we
    // rebuilt onto need not still contain it. Make the exact recorded directory
    // (restoreCwdInside, which refuses anything a symlink would place outside
    // the worktree) and then PROVE the chat can run before answering ok. A 200
    // that leaves the chat dormant is the one outcome this endpoint must never
    // produce: the pane would offer the same button again, forever.
    if (chatCwd) {
      const made = await restoreCwdInside(r.dir, chatCwd);
      if (!made.ok) return json({ error: `rebuilt ${r.dir} but ${made.error}` }, 409);
      const after = await resolveChat(session);
      if (!after.resumable) {
        return json({ error: `rebuilt ${r.dir} but the chat still cannot run here (${after.reason})`, reason: after.reason }, 500);
      }
    }
    const alloc = await reservePort(issue);
    return json({ ...r, port: alloc.port ?? null });
  }

  // /api/dash/terminal/main-chat — ENSURE main's always-present thread.
  // Idempotent, and the ONLY thing that decides whether main needs one: every
  // open (and every tab) calls it unconditionally and gets back the thread it
  // should land on. `created` says whether this call made it, which is all the
  // client needs to know to open it as new rather than resume.
  if (req.method === 'POST' && segs[0] === 'main-chat') {
    const body = await readBody();
    const agent = agentById(body.agent).id; // normalize unknown → claude
    // Refuse before minting anything: with the CLI absent there is no thread to
    // start, and the client renders install guidance off the typed reason.
    if (!agentById(agent).bin()) {
      const missing = new AgentMissingError(agent);
      return json({ error: missing.message, reason: 'agent-missing', agent, install: missing.install }, 409);
    }
    const r = await ensureMainChat(agent);
    return r.error ? json(r, 500) : json(r);
  }

  // /api/dash/terminal/chat — new chat in the env, linked.
  //   { issue }                              → mint + link a chat; for an ISSUE the
  //                                            PTY spawns lazily when the browser
  //                                            attaches, for MAIN it starts now.
  //   { issue, autonomous:true, flow?, prompt? }
  //                                          → ALSO spawn the PTY server-side now, into
  //                                            the chats map (no sockets attached), running the
  //                                            /change end-to-end (flow marks a regression).
  //                                            Opening the card later reattaches to it.
  // `issue` is 'main' for a MAIN chat (repo root, tracked in the main store, no
  // worktree/port, never an autonomous kick-off) or an issue id (its worktree).
  if (req.method === 'POST' && segs[0] === 'chat') {
    const body = await readBody();
    const { issue, flow, prompt, model, effort } = body;
    const agent = agentById(body.agent).id; // normalize unknown → claude
    if (!issue) return json({ error: 'issue required' }, 400);
    // Refuse BEFORE making a worktree, reserving a port or minting an id: with
    // the CLI absent there is no chat to open, and a half-built environment
    // behind a failed spawn is worse than a clear "install it first". Structured,
    // so the client renders guidance rather than the sentence.
    if (!agentById(agent).bin()) {
      const missing = new AgentMissingError(agent);
      return json({ error: missing.message, reason: 'agent-missing', agent, install: missing.install }, 409);
    }
    // A reviewer chat reviews a branch — always issue-scoped, never main.
    const role = body.role === 'reviewer' ? 'reviewer' : null;
    if (issue === MAIN_ENV) {
      if (role) return json({ error: 'a reviewer chat requires an issue, not main' }, 400);
      // MAIN has ONE creation path — repo root, no worktree, no port, no shared
      // selection row, started eagerly. The "+" button lands here; the
      // always-present thread lands on the same function via ensureMainChat.
      const r = await createMainChat(agent);
      if (r.error) return json(r, 500);
      return json({ ok: true, sessionId: r.sessionId, agent: r.agent, mode: 'new', dir: MAIN_REPO, port: null });
    }
    // A reviewer FORCES the eager server-side spawn (like an autonomous kick-off)
    // so its PTY is owned by the server and survives the launcher's turn cycle —
    // that survival is the whole point of moving reviews off the reaped bash task.
    const autonomous = body.autonomous || role === 'reviewer';
    // The issue must exist as a row, and gets a worktree + port (idempotent).
    // Gate on existence BEFORE touching git, so a bad id never leaves an orphaned
    // worktree behind a failed link.
    if (!(await issueExists(issue))) return json({ error: `no such issue "${issue}"` }, 404);
    const wt = await ensureWorktree(issue);
    if (!wt.ok) return json(wt, 500);
    const alloc = await reservePort(issue);
    const dir = wt.dir, port = alloc.port ?? null;
    const flowVal = flow === 'bug' ? 'bug' : 'change';
    // The autonomous first turn: a reviewer gets the review brief, everything
    // else gets the implement-it brief. `prompt` overrides either.
    const autonomousIntro = (meta) => prompt
      || (role === 'reviewer'
        ? reviewerChatIntro(issue, meta.title)
        : autonomousChatIntro(issue, meta.title, flow, agent, meta.status));
    // Creating a WORK chat makes it the issue's selected chat (the one the card
    // speaks for), covering the + button, spawn-issue and kick-off in one place.
    // A reviewer NEVER writes selected_session, so selection can't flip to it.
    const selectChat = async (sid) => {
      if (role === 'reviewer') return;
      const { update } = await import('./issues-store.mjs');
      // Retry once: the chat is already linked (and, when autonomous, its PTY is
      // spawned), so we must NEVER fail the request and strand a live chat — but a
      // transient PATCH failure would leave the new chat unselected, which the
      // create-select contract forbids, so the persisted selection is worth a
      // second attempt. A persistent failure self-heals: the creating client shows
      // the chat locally, and the next card-open re-picks + persists it.
      for (let attempt = 0; attempt < 2; attempt++) {
        try { const r = await update(issue, { selected_session: sid }); if (!r?.error) return; }
        catch { /* transient — retry, then fall through to best-effort */ }
      }
    };

    if (!agentById(agent).dashMintsId) {
      // CODEX: it mints its own id, so we spawn eagerly (human AND autonomous),
      // discover the id from its rollout, THEN link it. The browser attaches to
      // the returned id and REATTACHES to this already-live PTY. The intro is the
      // autonomous brief when kicked off, else summarize-and-wait.
      const meta = await issueMeta(issue);
      const intro = autonomous ? autonomousIntro(meta) : issueChatIntro(issue, meta.title, meta.status);
      const r = await spawnCodexNewChat({ issueId: issue, cwd: dir, cols: 100, rows: 30, initialPrompt: intro, model });
      if (r.error) return json({ error: r.error }, 500);
      const link = await linkChat(issue, r.sessionId, agent, role);
      if (link?.error) {
        // Codex is spawned BEFORE the link (its id doesn't exist until it runs),
        // so a link failure would strand a live, UNLINKED codex process — invisible
        // to the board and unaddressable. Tear it down rather than leak it; the
        // user retries. (Claude links before spawning, so it can't reach this.)
        await endChat(r.sessionId);
        return json({ error: `link failed: ${link.error}` }, 500);
      }
      await selectChat(r.sessionId);
      return json({ ok: true, sessionId: r.sessionId, agent, mode: 'new',
        ...(autonomous ? { autonomous: true, flow: flowVal } : {}), ...(role ? { role } : {}), dir, port });
    }

    // CLAUDE: the dash mints the uuid up front and links it; the PTY spawns
    // lazily when the browser attaches (human, with issueChatIntro chosen there)
    // or eagerly now (autonomous).
    const sessionId = crypto.randomUUID();
    const link = await linkChat(issue, sessionId, agent, role);
    if (link?.error) return json({ error: `link failed: ${link.error}` }, 500);
    if (autonomous) {
      // Spawn the real claude PTY immediately, keyed by sessionId (same key
      // attachChat uses for a 'new' chat) so a later browser open REATTACHES
      // to this running process rather than spawning a second one. The intro
      // tells it to run the flow to completion (or, for a reviewer, to review).
      const meta = await issueMeta(issue);
      const intro = autonomousIntro(meta);
      const spawned = spawnChat({ issueId: issue, sessionId, mode: 'new', cwd: dir, cols: 100, rows: 30, initialPrompt: intro, key: sessionId, model, effort, agent });
      // A freshly-minted uuid losing its claim means another server claimed it
      // in the same instant — vanishingly rare, but never fork: report it.
      if (!spawned) return json({ error: 'chat is live in another dash server' }, 409);
      await selectChat(sessionId);
      return json({ ok: true, sessionId, agent, mode: 'new', autonomous: true, flow: flowVal, ...(role ? { role } : {}), dir, port });
    }
    await selectChat(sessionId);
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
    if (issue === MAIN_ENV) {
      unlinkMainChat(handle);
      await forgetChatMeta(issue, session);
      return json({ ok: true });
    }
    const { removeFromArray, get, update } = await import('./issues-store.mjs');
    const r = await removeFromArray(issue, 'conversations', [handle]);
    if (r?.error) return json({ error: `unlink failed: ${r.error}` }, 500);
    await forgetChatMeta(issue, session);
    // Keep the invariant: selected_session must point at a LINKED chat. If we just
    // unlinked the selected one, clear it so auto-open falls back and the board
    // stops warming a chat this issue no longer tracks. Authoritative here (not
    // just in the client) so a direct API unlink can't leave it dangling.
    try {
      const row = await get(issue).catch(() => null);
      if (row?.selected_session === session) await update(issue, { selected_session: null });
    } catch { /* best-effort; the unlink itself succeeded */ }
    await invalidateIssuesCache();
    return json({ ok: true });
  }

  // POST /api/dash/terminal/chat-name { issue, session, name } — set or clear a
  // chat's custom display name within its env (an issue's chat_meta column, or
  // the main store's names file). An empty/absent name clears back to the
  // derived label. Returns the whole updated map so the client repaints from the
  // response instead of re-resolving the chat list.
  if (req.method === 'POST' && segs[0] === 'chat-name') {
    const { issue, session, name } = await readBody();
    if (!issue || !session) return json({ error: 'issue and session required' }, 400);
    const r = await setChatName(issue, session, typeof name === 'string' ? name : '');
    if (r?.error) return json({ error: r.error }, 500);
    if (issue !== MAIN_ENV) await invalidateIssuesCache();
    return json({ ok: true, names: r.names });
  }

  return json({ error: 'unknown terminal endpoint' }, 404);
}
