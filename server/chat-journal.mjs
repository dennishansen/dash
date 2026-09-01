// The supervisor's crash journal — the single record of which chats SHOULD be
// live on this machine, and the boot-time reconciliation that acts on it.
//
// This replaces the distributed live-chat registry (claims, tombs, reclaim
// races, cross-server redirects). Those existed because N dash servers could
// each resume any session and had to arbitrate ownership file-by-file. With ONE
// supervisor owning every PTY, there is nothing to arbitrate: in-process state
// (the chats map) is the authority while the supervisor lives, and this journal
// exists only so a crash can be survived honestly. It is evidence, not a lock.
//
// A record's life:
//   open()    → { state:'starting' } persisted BEFORE pty.spawn — identity is
//               not knowable yet (the pid exists only after spawn; a new codex
//               session has no id until its rollout is discovered), so the
//               record is deliberately provisional.
//   stamp()   → child identity (pid + OS start time) and, once known, the real
//               session id. state:'live'. This is the promotion point for
//               codex's discovered id.
//   close()   → the chat ended on purpose (natural exit, endChat, graceful
//               shutdown kill). The file is unlinked — durably clearing the
//               intent so a later boot cannot resurrect finished work. The
//               clear cannot be atomic with the child's death; the accepted
//               contract is AT-LEAST-ONCE: a crash landing in that window may
//               reopen a finished chat once, visibly.
//
// Boot reconciliation (reconcile) — the explicit state machine, per record:
//   'starting', or no provable child identity → BLOCKED: report it, keep the
//       file as evidence, never spawn — a duplicate conversation is the one
//       unrecoverable outcome, so uncertainty always parks.
//   'live', child provably DEAD  → RESUME from transcript.
//   'live', child provably ALIVE → terminate the verified child, await its
//       death (bounded), then RESUME; if it will not die → BLOCKED + report.
//
// Files live in the same machine-local dir as before (LAB_CHAT_REGISTRY_DIR
// honored — the test seam), named journal.<operationId>.json so they can never
// collide with legacy <uuid>.json records during migration.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  registryDir, atomicWrite, selfStartTime, pidStartTimeSync,
  processStates, processMatchesAsync, terminateVerified,
} from './proc-identity.mjs';

const FILE_RE = /^journal\.([0-9a-f-]{36})\.json$/i;
const jPath = (operationId) => path.join(registryDir(), `journal.${operationId}.json`);

function readRecord(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeRecord(rec) {
  try { fs.mkdirSync(registryDir(), { recursive: true }); } catch {}
  atomicWrite(jPath(rec.operationId), JSON.stringify(rec));
}

// Persist intent BEFORE the spawn. Everything identity-shaped is null on
// purpose — stamp() fills it in the moment it becomes true.
export function journalOpen({ agent, issueId, cwd, requestedSessionId = null, cols, rows }) {
  const rec = {
    operationId: crypto.randomUUID(),
    state: 'starting',
    agent, issueId, cwd,
    requestedSessionId,
    sessionId: requestedSessionId, // promoted by stamp() when discovery differs
    supervisorPid: process.pid,
    supervisorStartTime: selfStartTime(),
    ptyPid: null, ptyStartTime: null,
    cols: cols || 100, rows: rows || 30,
    openedAt: new Date().toISOString(),
  };
  writeRecord(rec);
  return rec;
}

// The spawn succeeded: stamp the child's verified identity, and promote the
// session id when the agent minted its own (codex). From here the record is
// actionable by a future boot.
export function journalStamp(rec, { ptyPid, sessionId }) {
  rec.state = 'live';
  rec.ptyPid = Number.isInteger(ptyPid) ? ptyPid : null;
  rec.ptyStartTime = rec.ptyPid ? pidStartTimeSync(rec.ptyPid) : null;
  if (sessionId) rec.sessionId = sessionId;
  writeRecord(rec);
  return rec;
}

// The chat ended on purpose. Unlink is the durable clear (see header for the
// at-least-once window this accepts).
export function journalClose(rec) {
  try { fs.unlinkSync(jPath(rec.operationId)); } catch {}
}

// Park a record as BLOCKED — never respawned until a human clears it. Used by
// reconciliation and by the legacy import when it converts an old-format
// record whose agent child still runs.
export function journalBlock(rec) {
  rec.state = 'blocked';
  writeRecord(rec);
  return rec;
}

// One-shot migration write: a COMPLETE identity-bearing blocked record in a
// single atomic write, for the legacy import — composing it from open+stamp
// would persist an identity-less intermediate, and a crash there (followed by
// the reboot's dedupe deleting the legacy file) stranded the live child with
// no identity to ever act on.
export function journalImportBlocked({ agent, issueId, sessionId, ptyPid, ptyStartTime, cols, rows }) {
  const rec = {
    operationId: crypto.randomUUID(),
    state: 'blocked',
    agent, issueId, cwd: null,
    requestedSessionId: sessionId,
    sessionId,
    supervisorPid: process.pid,
    supervisorStartTime: selfStartTime(),
    ptyPid: Number.isInteger(ptyPid) ? ptyPid : null,
    ptyStartTime: ptyStartTime || null,
    cols: cols || 100, rows: rows || 30,
    openedAt: new Date().toISOString(),
  };
  writeRecord(rec);
  return rec;
}

// Mark a record ENDING — a DELIBERATE stop (reap, merge, reject, link
// teardown) whose child resisted the kill. Distinct from blocked on purpose:
// blocked means "this chat should live and cannot safely be spawned yet",
// ending means "this chat must die" — reconciliation retries the termination
// and CLEARS on death, never resumes. Conflating the two resurrected reaped
// chats after a restart.
export function journalEnd(rec) {
  rec.state = 'ending';
  writeRecord(rec);
  return rec;
}

// Every journal record on disk, with its file path.
export function journalRecords() {
  let files = [];
  try { files = fs.readdirSync(registryDir()); } catch { return []; }
  const out = [];
  for (const f of files) {
    const m = f.match(FILE_RE);
    if (!m) continue;
    const rec = readRecord(path.join(registryDir(), f));
    if (rec && rec.operationId) out.push(rec);
  }
  return out;
}

// Boot reconciliation. `resume(rec)` is injected by the caller (terminal.js —
// it owns spawning); this module owns only the classification. Returns
// { resumed, blocked } where blocked entries carry a reason for the report.
// Records classified BLOCKED stay on disk (state re-written) — they are the
// evidence a human or a later, wiser pass acts on; they are never respawned.
export async function reconcile({ resume }) {
  const records = journalRecords();
  const resumed = [];
  const blocked = [];
  if (!records.length) return { resumed, blocked };

  const pids = records.map((r) => r.ptyPid).filter(Number.isInteger);
  const states = await processStates(pids);

  for (const rec of records) {
    // A deliberate stop whose child resisted: retry the termination; the
    // record clears on confirmed death and NEVER resumes.
    if (rec.state === 'ending') {
      if (Number.isInteger(rec.ptyPid) && rec.ptyStartTime
        && await processMatchesAsync(rec.ptyPid, rec.ptyStartTime, states)
        && !(await terminateVerified(rec.ptyPid, rec.ptyStartTime))) {
        blocked.push({ rec, reason: `deliberately-ended chat's process ${rec.ptyPid} still won't exit` });
        continue;
      }
      journalClose(rec);
      continue;
    }
    // Identity-less records park forever (a duplicate conversation is the one
    // unrecoverable outcome, so uncertainty always parks). A BLOCKED record
    // that CARRIES identity is different: it was parked because its child was
    // alive at some earlier boot (a pre-cutover import, an orphan that
    // wouldn't die) — it re-enters the state machine below, and resumes the
    // moment its child is provably gone.
    if (!Number.isInteger(rec.ptyPid) || !rec.ptyStartTime) {
      blocked.push({ rec, reason: 'no provable child identity (crash between spawn and stamp)' });
      if (rec.state !== 'blocked') { rec.state = 'blocked'; writeRecord(rec); }
      continue;
    }
    const alive = await processMatchesAsync(rec.ptyPid, rec.ptyStartTime, states);
    if (alive) {
      // The supervisor died but its child kept running. We cannot adopt a lost
      // PTY master — terminate the VERIFIED child and resume from transcript.
      if (!(await terminateVerified(rec.ptyPid, rec.ptyStartTime))) {
        blocked.push({ rec, reason: `orphaned agent process ${rec.ptyPid} did not exit` });
        if (rec.state !== 'blocked') { rec.state = 'blocked'; writeRecord(rec); }
        continue;
      }
    }
    // A record with verified identity but NO session id is a chat that died
    // before it ever had an identity to resume by (codex crash inside the
    // rollout-discovery window): the child is now provably gone and there is
    // no transcript to reopen — an ending, not a blockage.
    if (!rec.sessionId) { journalClose(rec); continue; }
    // Child provably gone → the transcript is the recovery point.
    try {
      const ok = await resume(rec);
      if (ok) { resumed.push(rec); journalClose(rec); }
      else {
        // Not resumable (transcript or worktree gone, agent not drivable) —
        // that is an ENDING, not a blockage: clear the intent.
        journalClose(rec);
      }
    } catch {
      blocked.push({ rec, reason: 'resume threw — left for the next boot' });
    }
  }
  return { resumed, blocked };
}

// ---- one-shot migration from the legacy registry ---------------------------
//
// Reads the old distributed-claim records (<uuid>.json) ONCE, classifies each
// exactly as the cutover contract demands, and returns the classification; the
// caller (the cutover script) deletes the legacy files only after every entry
// is accounted for. Legacy tombs and lease files are pure wreckage by cutover
// time (their owners are stopped) and are the caller's to remove wholesale.
const LEGACY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;

export async function importLegacyRegistry() {
  const dir = registryDir();
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return { resumable: [], finished: [], blocked: [] }; }
  const resumable = []; const finished = []; const blocked = [];
  const entries = [];
  for (const f of files) {
    if (!LEGACY_RE.test(f)) continue;
    const e = readRecord(path.join(dir, f));
    if (e && e.sessionId) entries.push({ file: f, entry: e });
  }
  const states = await processStates(entries.map(({ entry }) => entry.ptyPid).filter(Number.isInteger));
  for (const { file, entry } of entries) {
    if (entry.finished) { finished.push({ file, entry }); continue; }
    const childAlive = Number.isInteger(entry.ptyPid)
      && await processMatchesAsync(entry.ptyPid, entry.ptyStartTime, states);
    if (childAlive) blocked.push({ file, entry, reason: `agent process ${entry.ptyPid} still running` });
    else resumable.push({ file, entry });
  }
  return { resumable, finished, blocked };
}
