// Machine-local process-identity primitives for the dash's crash journal
// (chat-journal.mjs) and anything else that must ask "is the process this
// record names still the SAME process?". Three subtle parts live here once:
//
//   • WHERE records live — one machine-local dir, `~/.claude/dash-live-chats`,
//     overridable via LAB_CHAT_REGISTRY_DIR so tests never touch the real one.
//   • HOW a record is written without a reader ever seeing a half-file —
//     atomicWrite (temp + rename).
//   • WHETHER the process a record names is still the SAME process — pid
//     liveness, zombie detection, and OS start-time comparison to defeat pid
//     reuse. This is the load-bearing, easy-to-get-wrong part; it lives here
//     once so the registry and the lease can't drift apart on it.
//   • HOW a process is ENDED and its death proven — the group signal plus the
//     bounded identity-checked wait. Same reason: every caller that ends an
//     agent must end it the same way, or one of them strands the children the
//     others reap.
//
// Everything here is process-identity plumbing — no chat-specific or lease-
// specific policy. The key SHAPE each caller accepts (a session uuid vs a lease
// name) and what it DOES with ownership stay with the caller.
//
// SYNC vs ASYNC is a hard contract, not a convenience: the dash's one event
// loop also relays every terminal keystroke, and a spawnSync here blocks it
// for the child's whole lifetime — under machine load that is SECONDS per
// spawn (the terminal-typing-freeze failure mode, which once crept back in
// through the zombie probe below). The sync probes are therefore legal ONLY
// inside the single-tick claim writes (claimChat and its reclaim dance), where
// an await would open the in-process double-claim window they exist to close.
// Every path that merely READS liveness — registry scans, lease checks, chat
// lists, any poll — must use the async probes (processStates / pidAliveWith /
// processMatchesAsync), which batch one `ps` for a whole pid set off-loop.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { run } from './proc.mjs';

// The machine's OWN record store — where the one control plane keeps the chats
// it is responsible for. Named separately from registryDir() so a caller can
// ask the load-bearing question "am I about to act on the MACHINE's chats, or
// on a private set of my own?" (supervisor.mjs refuses to boot off-port on the
// machine's store — see i-codex-resume-collision).
export function machineRegistryDir() {
  return path.join(os.homedir(), '.claude', 'dash-live-chats');
}

// The dir this process's records live in. Read lazily (not a module const) so
// test files with static imports can still set the env first.
export function registryDir() {
  return process.env.LAB_CHAT_REGISTRY_DIR || machineRegistryDir();
}

// Atomic overwrite: write a temp file and rename it into place (rename is
// atomic on a single filesystem). A concurrent reader therefore never observes
// a half-written record it could mistake for corruption. The temp name carries
// our pid so two processes writing the same key don't collide on the temp.
export function atomicWrite(p, data) {
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  try { fs.renameSync(tmp, p); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}

// CLAIM-PATH ONLY (see header): blocks the event loop on a `ps` spawn when the
// pid exists. Poll paths use pidAliveWith/processStates instead.
export function pidAlive(pid) {
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
// mis-reading a live owner as gone would authorize a duplicate.
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
export async function pidStartTime(pid) {
  const r = await run('ps', ['-o', 'lstart=', '-p', String(pid)]);
  return r.status === 0 ? r.stdout.trim() || null : null;
}
// Synchronous variant for the CLAIM path only: a claim (and the staleness
// checks it runs) must stay claim+write-in-a-single-tick — an await inside
// would open the in-process double-claim window. Claims/reclaims are rare,
// action-paced events; the poll paths use the async one above.
export function pidStartTimeSync(pid) {
  try {
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
    return r.status === 0 ? (r.stdout || '').trim() || null : null;
  } catch { return null; }
}
// OUR OWN start time stays a cached synchronous one-shot: a claim must run
// claim+write in a single tick (an await inside it would open an in-process
// double-claim window), and one ~20ms spawnSync once per process lifetime is
// the deliberate cost of that atomicity.
let _selfStart = undefined;
export function selfStartTime() {
  if (_selfStart === undefined) _selfStart = pidStartTimeSync(process.pid);
  return _selfStart;
}

// Is this registry record OUR OWN — by full identity, pid AND recorded start
// time? Bare pid equality is not ownership: a dead server's pid can be
// recycled into THIS very process, and treating its leftover as ours would
// re-stamp/unlink a record whose stamped child may still be alive — the exact
// double-owner the identity contract exists to prevent. Fail-safe like
// processMatches: a record with NO startTime is accepted on pid alone. That
// exception is deliberate — our own records carry startTime: null whenever ps
// fails at stamp time, and refusing them would strand our own claims (we could
// never re-stamp or release them). The cost: a legacy no-startTime record whose
// dead owner's pid was recycled into this process reads as ours — a triple
// coincidence accepted over stranding real claims on a ps hiccup.
export function isOwnClaim(entry) {
  return !!entry && entry.pid === process.pid
    && (!entry.startTime || entry.startTime === selfStartTime());
}

// Does this pid name the SAME process the record described? Deterministic
// process identity: alive, and (when the record carries one) the OS start time
// agrees — a recycled pid names a different process with a later start time.
// FAIL SAFE like isOwnClaim: a null start time (ps failed) can't disprove
// identity, so the process is treated as matching.
// CLAIM-PATH ONLY (see header) — poll paths use processMatchesAsync.
export function processMatches(pid, startTime) {
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

// --- async identity: the poll-path probes ---

// One `ps` for a whole pid set, off the event loop → Map<pid, state string>.
// A pid absent from the map carries NO information by itself (ps exits non-zero
// whenever any queried pid is dead, and a wholesale ps failure yields an empty
// map) — liveness still comes from process.kill(0); the map only answers the
// zombie question, and fail-safe in the same direction as pidIsZombie: no
// state → not provably a zombie.
export async function processStates(pids) {
  const want = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0);
  const out = new Map();
  if (!want.length) return out;
  const r = await run('ps', ['-o', 'pid=', '-o', 'state=', '-p', want.join(',')]);
  for (const line of (r.stdout || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)/);
    if (m) out.set(Number(m[1]), m[2]);
  }
  return out;
}

// pidAlive, evaluated against a prefetched state map — the batched form every
// registry/lease scan uses so N records cost ONE child process, awaited.
export function pidAliveWith(pid, states) {
  try { process.kill(pid, 0); } catch (e) { return e.code === 'EPERM'; }
  return !String(states?.get(pid) || '').toUpperCase().startsWith('Z');
}

export async function pidAliveAsync(pid) {
  if (!Number.isInteger(pid)) return false;
  return pidAliveWith(pid, await processStates([pid]));
}

// processMatches without the event-loop block: same identity decision, same
// fail-safe rules, spawned children awaited instead of waited-on. Pass a
// prefetched `states` map when checking many records in one scan.
export async function processMatchesAsync(pid, startTime, states) {
  if (!Number.isInteger(pid)) return false;
  const s = states ?? await processStates([pid]);
  if (!pidAliveWith(pid, s)) return false;
  if (startTime) {
    const st = pid === process.pid ? selfStartTime() : await pidStartTime(pid);
    if (st !== null && st !== startTime) return false;
  }
  return true;
}

// --- ending a process, and proving it ---

// Signal a process's whole GROUP, falling back to the bare pid when there is no
// group to signal. The group is the point: an agent PTY child is a session
// leader, so its own children (codex's app-server, an MCP sidecar) go with it
// instead of surviving to hold the transcript it was writing open. Synchronous
// — the shutdown path runs inside process 'exit', where nothing can be awaited.
export function signalTree(pid, signal = 'SIGTERM') {
  if (!Number.isInteger(pid)) return;
  try { process.kill(-pid, signal); }
  catch { try { process.kill(pid, signal); } catch {} }
}

// Await a pid's death, bounded. Returns true iff the process (by exact
// identity) is provably gone.
export async function awaitDeath(pid, startTime, { timeoutMs = 8000, stepMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await processMatchesAsync(pid, startTime))) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return !(await processMatchesAsync(pid, startTime));
}

// End a process and prove it ended: check identity, signal its tree, then wait
// out its death by that same identity. The ONE way anything in the dash ends an
// agent — boot reconciliation, a deliberate abort, reclaiming a stranded writer
// — so a resister is reported by every caller instead of quietly assumed dead.
//
// The identity check comes BEFORE the signal on purpose. `startTime` is the OS
// start time recorded when the caller decided this process was its target; a
// pid that no longer matches it is the target already gone and its number
// reissued to something else, and signalling then would kill a bystander. (The
// check cannot be atomic with the signal — no Unix offers that — but it closes
// the window from "however long the caller took to decide" down to microseconds.)
export async function terminateVerified(pid, startTime, opts) {
  if (!Number.isInteger(pid)) return true;
  if (startTime && !(await processMatchesAsync(pid, startTime))) return true;
  signalTree(pid);
  return awaitDeath(pid, startTime, opts);
}
