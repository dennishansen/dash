// Reaper — CHECKER ONLY (read-only proposal), deliberately ISOLATED. Covers
// three fleets: idle chat agents, worktree dev (vite) servers, and the worktree
// workspaces themselves.
//
// CHATS — background agent processes (claude AND codex, identically) that would
// be safe to stop:
//   • idle for >= IDLE_MINUTES   (last activity = the timestamp on the last
//     record INSIDE the transcript; no model turn is silent for 20 minutes, so
//     this alone excludes "waiting on the model")
//   • NOT linked to any in-progress issue on the board
//   • not the selected chat of a surface that is still live
//   • nothing running underneath it (a shell mid-command)
//
// That chat rule is also the ONE definition of "still working" the other two
// fleets read, through busyWorkspaces: a chat this fleet would keep HOLDS its
// workspace, so nothing beneath a working agent — not its preview server, not
// its directory — is ever collected out from under it. Teardown is a state a
// workspace enters when its issue retires, not an event `/merge` fires; the
// worktree fleet (worktree-reaper.mjs) collects it once the chat goes quiet.
//
// EVERY INPUT IS A FACT ABOUT THE CONVERSATION — not about the file it happens
// to be stored in, not about a pointer that once named it, not about how loaded
// the machine is. That sentence is the whole repair (i-reaper-keeps-everything),
// because this fleet had drifted to four signals that were none of those things
// and it consequently proposed 0 of 50 chats while the box sat at 73% kernel
// time:
//
//   identity  ← the supervisor's own journal (pid ↔ session), not argv
//               archaeology. Codex puts no id in its argv, so an argv-only
//               reaper could not date a single codex chat and kept them all;
//               meanwhile a codex chat's OWN `codex app-server` grandchild
//               matched on basename and was counted as an extra, undatable
//               agent that held its worktree hostage.
//   idle      ← the last message's timestamp inside the transcript, not the
//               file's mtime. Transcripts get rewritten in place (same inode,
//               no new lines); mtime can therefore only ever UNDER-report
//               idleness, and on this machine it did so for 164 of 273 files.
//   selection ← only from a surface that is still live. `selected_session` is
//               sticky — the last chat ever clicked on a card — so treating
//               membership as "being viewed" made every card's last chat
//               immortal regardless of the card's status.
//   load      ← not a signal at all. CPU is REPORTED and never decides: an idle
//               claude TUI on a thrashing box reads 6-17%, so the old
//               `cpu > 5` rule inverted under exactly the overload it was meant
//               to relieve — more load ⇒ everything looks busy ⇒ nothing reaps
//               ⇒ more load. "Still running a command" is a shell with a child,
//               which is structural and true at any load.
//
// So all signals are deterministic snapshots of the OS, the journal and the
// board — no viewport scraping, no CPU-threshold guessing.

import './node-env.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { listAll, TABLE as ISSUES_TABLE, PROD_TABLE as ISSUES_PROD } from './issues-store.mjs';
import { parseHandle, agentProcNames, chatActivity } from './agents.mjs';
import { journalRecords } from './chat-journal.mjs';
import { selectedChats, TABLE as PROFILES_TABLE, PROD_TABLE as PROFILES_PROD } from './profiles-store.mjs';
import { freePort } from './ports.mjs';
import { DEV_PORT_MIN, DEV_PORT_MAX } from './supervisor-contract.mjs';
import { workspaceForDir } from './workspace-env.mjs';
import { listWorkspaces, worktreeVerdicts, probeSafety, collectWorkspace, liveCwds } from './worktree-reaper.mjs';

const pExec = promisify(execFile);

// 20 minutes, and the number is measured rather than assumed. Across 38 live
// transcripts (20,862 turn-to-turn gaps, 2026-08-18) the gap distribution is
// sharply bimodal: p50 1s, p90 12s, p99 2.0m — then nothing until p99.9 at 4.3
// HOURS. A chat that is working writes a line every couple of minutes; a chat
// that has been parked is parked for hours. 20m sits in the empty valley
// between the two humps, so the rule separates them without landing on either.
// Only 0.19% of all gaps reach it, and a chat stopped at one cold-resumes from
// its transcript anyway.
export const IDLE_MINUTES = 20;

// --- who may reap ------------------------------------------------------------
// Everything below decides the fate of MACHINE-GLOBAL things: OS processes and
// TCP listeners that every checkout on this box shares. The board is the
// opposite — a per-run isolation axis, keyed in `dash_test_issues` so a test never
// touches the live one. Reading real pids and ports out of a cloned board
// inverts every verdict at once: nothing matches, so every genuine dev server
// reads "orphaned" and every real chat reads "not in-progress", and the sweep
// stops the whole fleet (i-reaper-test-table).
//
// So authority is granted only by the exact production board, and it gates the
// VERDICT, not merely the kill — a `reap` flag is a recommendation to stop a
// real process, and a wrong one is a landmine for the next consumer (a sweep
// today, a click-to-approve list tomorrow). Anything that is not production
// fails closed, including a table name nobody recognises.
export function reapAuthority() {
  const foreign = [];
  if (ISSUES_TABLE !== ISSUES_PROD) foreign.push(`issues table "${ISSUES_TABLE}"`);
  if (PROFILES_TABLE !== PROFILES_PROD) foreign.push(`profiles table "${PROFILES_TABLE}"`);
  return foreign.length
    ? { ok: false, reason: `not the production board (${foreign.join(', ')}) — it cannot speak for this machine` }
    : { ok: true, reason: null };
}

// --- live agent processes ---------------------------------------------------
// What a process IS comes from argv[0] — the basename of the executable, matched
// against the agent registry (agents.mjs `agentProcNames`), so the reaper knows
// about Codex because the registry does, not because this file hardcoded a
// second name. `bin()` resolves an absolute path (PATH, or an app bundle), so
// the basename is the identity and the bare string never appears.
//
// Anchoring on argv[0] rather than on the flags matters because this fleet's
// verdicts end in SIGTERM: a shell wrapper that launched an agent carries the
// same flags in its own argv, and matching the substring would put the wrapper
// on the kill list. `--bg-pty-host` is excluded for the mirror reason — it marks
// the pty-host wrapper, which only echoes the session uuid.
//
// The SESSION id, when the line carries one, is named in any of three ways:
//
//   --session-id <uuid>        a claude chat being created
//   --resume <uuid>            a chat being resumed — how EVERY restarted chat
//                              runs, and how the dash relaunches its own PTYs
//   --resume <path>.jsonl      the same, naming the transcript directly
//
// Matching only the first was a hole with teeth: a resumed chat was invisible to
// every fleet, so it was never reaped (harmless) and, once the other fleets
// started reading chats to decide what is still working, could not hold its own
// workspace either — the reaper would collect the directory out from under
// exactly the long-running agent this whole model exists to protect.
//
// A process with NO session id here is not yet undatable — argv is only the
// FALLBACK identity, for an agent someone runs in their own terminal. Every chat
// the dash hosts is named by the journal instead (chatIdentities), which is how
// codex — whose new sessions carry no id in argv at all — gets dated exactly
// like claude. A process neither the journal nor argv can name is reported, and
// it HOLDS its workspace, but it can never be reaped: with no session there is
// no transcript, so there is no idle evidence, and the chat rule already keeps
// anything it cannot date. That is the fail-safe direction, and it is why the
// reviewer chat that read this branch could not have had its own worktree
// deleted underneath it.
export function parseAgentLine(line, procNames) {
  if (line.includes('--bg-pty-host')) return null;
  const [pidStr, exe = ''] = line.trim().split(/\s+/);
  const agent = procNames.find((n) => path.basename(exe) === n);
  if (!agent) return null;
  const pid = Number(pidStr);
  if (!Number.isFinite(pid)) return null;
  const transcript = line.match(/--resume\s+(\S+\.jsonl)/)?.[1] ?? null;
  const sessionId = line.match(/--session-id\s+([0-9a-f-]{36})/)?.[1]
    ?? line.match(/(?:--resume|resume)\s+([0-9a-f-]{36})(?:\s|$)/)?.[1]
    ?? (transcript ? path.basename(transcript, '.jsonl').match(/^[0-9a-f-]{36}$/)?.[0] : null)
    ?? null;
  return { pid, agent, sessionId, transcript };
}

async function agentProcesses() {
  const [{ stdout }, procNames] = [await pExec('ps', ['-Ao', 'pid=,command=']), agentProcNames()];
  return stdout.split('\n').map((l) => parseAgentLine(l, procNames)).filter(Boolean);
}

// --- who each process IS ----------------------------------------------------
// The supervisor's crash journal is the AUTHORITY on identity, because it is the
// only party that ever knew it: it opened the record before the spawn and
// stamped the child's pid and session id the moment both were true. Reading it
// is not a lookup of last resort, it is asking the process's own parent who it
// started.
//
// Everything else was archaeology on a command line, and codex simply does not
// write its id there — a new codex mints its own id after spawn, so `ps` shows
// nothing to date it by, and the reaper kept every codex chat forever. The
// journal has known that id all along.
//
// Keyed on the bare pid, with no start-time verification, and that is safe for a
// structural reason rather than an optimistic one: nothing downstream ever
// signals the pid this map is keyed by. stopChats calls endChat(sessionId), and
// endChat acts only on the supervisor's in-process `chats` map — a session it
// does not hold is a no-op, not a kill. So the worst a recycled pid meeting a
// stale record could do is mis-DATE a row in a report; it cannot reach a
// process. If a future caller ever kills by `row.pid`, that changes, and this
// map owes a processMatchesAsync check against the record's ptyStartTime.
export function chatIdentities(records) {
  const byPid = new Map();
  for (const r of records || []) {
    // 'ending' records name a chat we already decided to stop; every other
    // state names one that should be live. Either way the pid↔session pairing
    // is what we came for.
    if (!Number.isInteger(r.ptyPid) || !r.sessionId) continue;
    byPid.set(r.ptyPid, { agent: r.agent || 'claude', sessionId: r.sessionId });
  }
  return byPid;
}

// Which agent process IS which chat — resolved by walking UP the process tree,
// once, because both hard questions live on that one path.
//
// The first is that a journal record does NOT necessarily name the agent binary.
// It names what the supervisor spawned, and how far that is from the agent
// depends on how the CLI was installed: a direct binary IS the agent (macOS,
// ~/.local/bin/codex), while an npm install puts a `node` shim in between, so
// the recorded ptyPid is a wrapper and the real `codex` is its child. Keying the
// map on the pid alone therefore matched nothing at all on the Linux box — every
// hosted chat looked unhosted, and a brand-new codex (whose argv carries no id)
// was undatable again for a completely different reason. So a record claims the
// agent process at OR BENEATH its ptyPid, which is true however many wrappers a
// packaging choice inserts.
//
// The second is that a chat's own helpers share its EXECUTABLE NAME, so no
// basename check can separate them: a live `codex resume <id>` spawns a
// node_repl which spawns `codex app-server --listen stdio://`, and that
// grandchild parsed as a second agent — no session id, therefore undatable,
// therefore immortal, and holding its worktree busy against the other two
// fleets. Eight were doing exactly that on the box that prompted this fix.
//
// One rule settles both: a journal record owns exactly ONE chat — the SHALLOWEST
// agent process at or beneath its ptyPid — and anything deeper under that same
// record is the chat's own tooling. The wrapper case and the helper case are the
// same shape (an agent-named process below a recorded pid) distinguished only by
// distance, which is why one walk answers both.
//
// A process no record claims falls back to descent alone: an agent running
// underneath another agent process is that agent's tooling, and anything else is
// somebody's own terminal, identified by argv. Neither needs an allow-list, so
// the next helper codex or claude ships is covered the day it appears — the
// reason `--bg-pty-host` and `codex-code-mode-host` each had to be special-cased
// one at a time before.
export function identifyChats(procs, identities = new Map(), tree = { byPid: new Map() }) {
  const agentPids = new Set(procs.map((p) => p.pid));
  // The nearest journalled ancestor-or-self and how far up it sits, plus whether
  // any other agent process lies in between — one walk toward init per process.
  const lineage = (pid) => {
    let owner = identities.has(pid) ? pid : null;
    let depth = 0;
    let underAgent = false;
    const seen = new Set([pid]);
    let d = 0;
    for (let p = tree.byPid.get(pid)?.ppid; Number.isInteger(p) && p > 1 && !seen.has(p); p = tree.byPid.get(p)?.ppid) {
      seen.add(p);
      d++;
      if (owner == null && identities.has(p)) { owner = p; depth = d; }
      if (agentPids.has(p)) underAgent = true;
      if (owner != null && underAgent) break;
    }
    return { owner, depth, underAgent };
  };

  const claimed = new Map(); // journal ptyPid → the shallowest agent process under it
  const lines = new Map();
  for (const p of procs) {
    const l = lineage(p.pid);
    lines.set(p.pid, l);
    if (l.owner == null) continue;
    const held = claimed.get(l.owner);
    // Shallowest wins; equal depth breaks on the lower pid so the answer never
    // depends on the order `ps` happened to list them in.
    if (!held || l.depth < held.depth || (l.depth === held.depth && p.pid < held.pid)) {
      claimed.set(l.owner, { pid: p.pid, depth: l.depth });
    }
  }

  // Helpers are reported so the CLI can say why a process it can see is not on
  // the chat list, and nothing more — what holds their ground is the chat's whole
  // process tree (busyWorkspaces), which covers a plain `bash` running a build
  // just as well as a second `codex`, and needs no ownership guess about which
  // agent a nested one belongs to.
  const chats = [];
  const helpers = [];
  for (const p of procs) {
    const { owner, underAgent } = lines.get(p.pid);
    if (owner != null) {
      if (claimed.get(owner).pid === p.pid) chats.push({ ...p, ...identities.get(owner), hosted: true });
      else helpers.push(p);
      continue;
    }
    if (underAgent) { helpers.push(p); continue; }
    chats.push({ ...p, hosted: false });
  }
  return { chats, helpers };
}

// Every process running under a chat, with the workspace it is standing in —
// the input busyWorkspaces needs to hold ground a chat is working on somewhere
// other than its own cwd. `cwds` is read for these pids alongside the chats'.
//
// The descent STOPS at another chat, and that boundary is the whole reason this
// is a walk rather than a plain descendants() call. A chat can sit inside
// another chat's tree — identifyChats deliberately allows it, because a chat the
// supervisor journalled is a chat whatever its ancestry — and swallowing it here
// would make the two functions disagree about who owns that subtree: the inner
// chat gets its own verdict, but its ground would be held on the OUTER chat's
// behalf, so an independently reapable child could never release its workspace.
// Each chat owns its own subtree, up to the next chat down.
export function chatOccupants(chats, tree, cwds) {
  const boundary = new Set(chats.map((c) => c.pid));
  const out = [];
  for (const c of chats) {
    const stack = [...(tree.kids.get(c.pid) || [])];
    const seen = new Set();
    while (stack.length) {
      const pid = stack.pop();
      if (seen.has(pid) || boundary.has(pid)) continue; // another chat owns itself and everything under it
      seen.add(pid);
      for (const k of tree.kids.get(pid) || []) stack.push(k);
      const cwd = cwds.get(pid) ?? null;
      if (!cwd) continue; // unreadable cwd tells us nothing; the chat still holds its own
      out.push({ pid, comm: tree.byPid.get(pid)?.comm ?? null, workspace: workspaceForDir(cwd), chatPid: c.pid });
    }
  }
  return out;
}

// --- which workspace a process is standing in -------------------------------
// A process's cwd, straight from the kernel via lsof — the one deterministic
// answer to "which worktree does this belong to". A chat records its cwd nowhere
// else, and a detached vite's port reservation can be released out from under it,
// so neither can be resolved through the board alone.
//
// A pid whose cwd we cannot read maps to `null`, and callers must treat that as
// UNKNOWN rather than "outside every worktree" — guessing there is exactly how a
// working agent loses its ground. lsof exits non-zero when any listed pid has
// already gone; it still prints the rest, so the partial stdout on the error is
// the result, not a failure.
async function cwdByPid(pids) {
  const out = new Map();
  if (!pids.length) return out;
  let stdout = '';
  try { ({ stdout } = await pExec('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn'])); }
  catch (e) { stdout = e?.stdout || ''; }
  let pid = null;
  for (const line of stdout.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid != null) out.set(pid, line.slice(1));
  }
  return out;
}

// How a row names itself in a reason string or a report. A session id when it
// has one, its pid when it doesn't — a brand-new codex has no id yet, and "codex
// pid 19313" is still a thing a human can go look at.
const agentLabel = (r) => `${r.agent} ${r.sessionId ? r.sessionId.slice(0, 8) : `pid ${r.pid}`}`;

// The workspaces a chat is still working in, and who is holding each. This is
// the single shared definition of "still working": a chat the CHAT fleet would
// keep — for any of its reasons, whether active minutes ago, running a build, or
// simply on screen — holds its workspace against the other two fleets.
//
// It holds every workspace ANY PROCESS IN ITS TREE stands in, not just the one
// the agent binary sits in. A chat routinely works somewhere else: its Bash tool
// shells out, and that shell's `npm test` can be running in a different worktree
// entirely. Holding only the agent's own cwd left that directory unheld while a
// build ran in it, which is the one catastrophe this model exists to prevent —
// and the descendants are already in hand, because busyReason walks the same
// tree to decide whether a shell is mid-command.
//
// `occupants` are those processes: { pid, comm, workspace, chatPid }. A chat this
// sweep is about to reap holds nothing, itself or through its tree.
//
// NOT covered, and worth naming because it is tempting to assume otherwise: the
// processes of a REAPED chat are not guaranteed to die with it. endChat goes
// through node-pty's kill(), which signals the PTY child alone and not its
// process group, so a descendant that called setsid outlives the chat — and if
// it is not agent-named, the next sweep cannot see it either. That is a standing
// (pre-existing) gap, and the place to close it is the removal itself:
// collectWorkspace should refuse to delete a directory that is any live
// process's cwd. Deferring the hold here would only postpone the same race by
// one pass while delaying every teardown.
export function busyWorkspaces(chats, occupants = []) {
  const busy = new Map();
  const hold = (workspace, why) => {
    if (!workspace) return;
    if (!busy.has(workspace)) busy.set(workspace, []);
    busy.get(workspace).push(why);
  };
  const kept = new Map();
  for (const c of chats) {
    if (c.reap) continue;
    kept.set(c.pid, c);
    hold(c.workspace, `${agentLabel(c)} (${c.keepReasons.join('; ') || 'still working'})`);
  }
  for (const o of occupants) {
    const chat = kept.get(o.chatPid);
    if (!chat || o.workspace === chat.workspace) continue; // the chat's own line already says it
    hold(o.workspace, `${o.comm || 'process'} ${o.pid}, running under ${agentLabel(chat)}`);
  }
  return busy;
}

// --- last activity ----------------------------------------------------------
// Two facts bound it, and the TRUER one is whichever is smaller:
//
//   • the last message IN the transcript — when this conversation actually last
//     moved;
//   • the agent PROCESS's own age — because a process cannot have been idle for
//     longer than it has existed.
//
// The second used to be a belt. Measured on a live fleet of 13 agents
// (2026-07-28) against the OLD mtime clock it changed no verdict at all, because
// mtime is refreshed at resume and so a resumed chat already read as young.
//
// Reading the conversation's own clock instead makes that bound LOAD-BEARING,
// and deliberately so — but on a NARROWER path than it first appears, and the
// difference is worth stating because it is easy to assume the wrong one.
//
// The supervisor's BOOT RESTORE is not the case. It resumes every chat with
// RESTART_NOTE as an initial prompt (terminal.js), the agent submits that as a
// real turn, and the transcript therefore gains a line immediately — measured on
// the first sweep after a live restart, all 18 chats read 1m idle from their own
// transcripts, and the bound changed nothing for any of them.
//
// The case it genuinely covers is ATTACH: reopening a cold chat resumes it with
// no intro at all ("A resume sends no intro" — terminal.js), so nothing is
// written and the last message stays as old as it was. A chat someone reopened
// thirty seconds ago after four days therefore carries a four-day-old last
// message, and without this min() the next sweep would stop it. The bound is
// what distinguishes "quiet for days AND nobody has reopened it" from "somebody
// just reopened it". Both inputs stay deterministic: one record timestamp, one
// elapsed time.
export function lastActivityMinutes(transcriptIdleMin, processAgeMin) {
  if (transcriptIdleMin == null) return null;
  if (processAgeMin == null) return transcriptIdleMin;
  return Math.min(transcriptIdleMin, processAgeMin);
}

// Attach each chat's dating evidence, once, before any verdict is formed. The
// filesystem work lives HERE rather than inside chatVerdicts so the verdict
// stays pure and synchronous over plain numbers — which is what lets every rule
// below be read, and tested, without a transcript on disk.
export async function dateChats(chats) {
  return Promise.all(chats.map(async (c) => {
    const a = await chatActivity(c.agent, c.sessionId).catch(() => null);
    return { ...c, transcript: a?.transcript ?? null, lastMessageMs: a?.lastMessageMs ?? null, fileMs: a?.fileMs ?? null };
  }));
}

// `ps` elapsed time — [[dd-]hh:]mm:ss — as minutes. Null if unparseable, which
// lastActivityMinutes reads as "no process-age evidence" and ignores.
export function etimeMinutes(etime) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec((etime || '').trim());
  if (!m) return null;
  const [, d, h, min, sec] = m;
  return (+(d || 0)) * 1440 + (+(h || 0)) * 60 + (+min) + (+sec) / 60;
}

// Minutes since `stampMs`, bounded by how long the process has existed. Pure —
// dateChats already did the reading.
function idleFrom(stampMs, ageMin) {
  if (stampMs == null) return null;
  return lastActivityMinutes((Date.now() - stampMs) / 60000, ageMin);
}

// --- process tree, to spot work running under an agent ----------------------
// `etime` rides along so an agent's own age can bound how idle it can possibly
// be (lastActivityMinutes). It sits before `comm` because comm is the only
// field that may contain spaces.
async function processTree() {
  const { stdout } = await pExec('ps', ['-Ao', 'pid=,ppid=,pcpu=,etime=,comm=']);
  const byPid = new Map();
  const kids = new Map();
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const [pid, ppid, pcpu, etime, ...comm] = t.split(/\s+/);
    byPid.set(+pid, { pid: +pid, ppid: +ppid, cpu: +pcpu, ageMin: etimeMinutes(etime), comm: comm.join(' ') });
    if (!kids.has(+ppid)) kids.set(+ppid, []);
    kids.get(+ppid).push(+pid);
  }
  return { byPid, kids };
}
function descendants(pid, kids) {
  const out = [];
  const stack = [...(kids.get(pid) || [])];
  while (stack.length) {
    const p = stack.pop();
    out.push(p);
    for (const c of kids.get(p) || []) stack.push(c);
  }
  return out;
}
// Returns a human reason string if real WORK is running under `pid`, else null.
// "Real work" is STRUCTURAL: a shell that has a child of its own is a shell
// mid-command. Merely-existing idle helpers (background `node` servers for
// editor/tools, no children) are NOT work.
//
// CPU used to count here too (`cpu > 5` ⇒ "busy child"), and it had to go. Load
// is not work: on a box thrashing badly enough to need the reaper, idle claude
// TUIs alone read 6-17%, so the rule fired hardest exactly when it was most
// wrong — every chat looked busy, nothing reaped, and the load that produced the
// reading went up. A rule whose false-positive rate rises with the pressure it
// exists to relieve is not a conservative rule, it is a latch. Whether a shell
// has a child is true at any load.
function busyReason(pid, { byPid, kids }) {
  for (const d of descendants(pid, kids)) {
    const p = byPid.get(d);
    if (!p) continue;
    const isShell = /(^|\/)(sh|bash|zsh|fish)$/.test(p.comm);
    if (isShell && (kids.get(d) || []).length > 0) return `shell running a command`;
  }
  return null;
}

// --- session -> linked issues + their status --------------------------------
function statusBySession(issues) {
  const map = new Map();
  for (const it of issues) {
    for (const h of it.conversations || []) {
      const { sessionId } = parseHandle(h);
      if (!sessionId) continue;
      if (!map.has(sessionId)) map.set(sessionId, []);
      map.get(sessionId).push({ id: it.id, status: it.status });
    }
  }
  return map;
}

// WHICH CHATS A LIVE SURFACE POINTS AT, from BOTH registries — selection is
// stored per surface: a main chat's lives in a profile column, an issue chat's is
// `selected_session` on the issue row. Reading only the first left every issue
// chat unprotected, so the "not on screen" half of the contract simply did not
// apply to them; with worktree collection downstream, that now costs a directory
// and not just a process.
//
// But selection is a STICKY POINTER, not attention: `selected_session` is the
// last chat ever clicked on that card and it is never cleared, so reading
// membership as "being viewed" made every card's last chat immortal — done,
// rejected, next, all of them — and with it that card's dev server and its
// worktree. Every card has one, which is why a fleet of fifty proposed zero.
//
// So a card only speaks for its selection while the card is still live work.
// Retire the issue and its selection stops holding anything, which is the
// correct reading of a pointer whose meaning is "where this card would open",
// not "somebody is looking at this right now". A PROFILE has no such retirement
// state — there is no card to close, and a person's main chat is the one thread
// the dash guarantees exists — so that half is unconditional.
export function selectedSessions(mainSelected, rows) {
  const live = (rows || []).filter((r) => r.status === 'in-progress');
  return new Set([...(mainSelected || []), ...live.map((r) => r.selected_session).filter(Boolean)]);
}

// --- the chat verdict -------------------------------------------------------
// One row per live chat with all signals + a reap verdict, pure over its inputs:
// every fact it needs was gathered by identifyChats and dateChats first, so this
// reads as the RULE and nothing else. `workspace` is the folder the agent is
// standing in — the handle the other two fleets hold it by.
//
// `ownCpu` rides on the row and decides nothing. It is worth printing — a chat
// pinning a core is worth a human's eye — but it must never be a keep reason;
// see busyReason for what that cost.
export function chatVerdicts({ agents, tree, rows, selected, cwds, idleMinutes = IDLE_MINUTES, authOk = true }) {
  const statuses = statusBySession(rows);
  return agents.map((a) => {
    const ageMin = tree.byPid.get(a.pid)?.ageMin ?? null;
    const idle = idleFrom(a.lastMessageMs ?? null, ageMin);
    // The same clock the reaper used to trust, kept for the report alone so the
    // gap between the file and the conversation is visible rather than silent.
    const fileIdle = idleFrom(a.fileMs ?? null, ageMin);
    const links = statuses.get(a.sessionId) || [];
    const inProgress = links.some((l) => l.status === 'in-progress');
    const busy = busyReason(a.pid, tree);
    const ownCpu = tree.byPid.get(a.pid)?.cpu ?? 0;
    const viewed = selected.has(a.sessionId);
    const cwd = cwds.get(a.pid) ?? null;
    const keepReasons = [];
    // A board that may not reap keeps everything — and says so, so the report
    // reads as "I'm not allowed to judge this" rather than a silent all-clear.
    // Terse here on purpose: the full reason is the report's banner, and one
    // row is not the place to repeat it N times.
    if (!authOk) keepReasons.push('board may not reap');
    if (viewed) keepReasons.push('currently selected');
    if (!a.sessionId) keepReasons.push('no session id — nothing to date it by');
    else if (idle == null) keepReasons.push('no transcript found');
    else if (idle < idleMinutes) keepReasons.push(`active ${idle.toFixed(0)}m ago`);
    if (inProgress) keepReasons.push('issue in-progress');
    if (busy) keepReasons.push(busy);
    return {
      ...a, cwd, workspace: cwd ? workspaceForDir(cwd) : null,
      idle, fileIdle, links, inProgress, busy, ownCpu, reap: keepReasons.length === 0, keepReasons,
    };
  });
}

// --- dev servers ------------------------------------------------------------
// The vite preview server for a worktree. A server for an issue that is no
// longer in-progress is dead weight, and one listening on a port no issue
// reserves is an orphan (its owning dash died and left it running, parented to
// launchd). Both are safe to stop — the dash respawns a server on demand when
// you open that issue's app tab — but only once the WORKSPACE is quiet: a chat
// still working there is watching that preview, and killing it is half of the
// ground going out from under a merge.

// Every port in the dev range with a live LISTEN socket, mapped to its pid. One
// lsof over the range (vite binds ::1 and/or 127.0.0.1 — dedup by port).
async function liveDevPorts() {
  let stdout = '';
  try {
    ({ stdout } = await pExec('lsof', ['-nP', `-iTCP:${DEV_PORT_MIN}-${DEV_PORT_MAX}`, '-sTCP:LISTEN', '-Fpn']));
  } catch { return []; }
  const byPort = new Map();
  let pid = null;
  for (const line of stdout.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n') { const m = line.match(/:(\d+)$/); if (m) byPort.set(Number(m[1]), pid); }
  }
  return [...byPort].map(([port, p]) => ({ port, pid: p }));
}

// The pure verdict, pulled out of the survey so the rule is testable without
// lsof/Supabase and so it has one obvious home. Given the live dev-server ports
// (each with the cwd of the process holding it), the board's port reservations,
// issue statuses, which workspaces are still busy, OUR OWN pid, and whether this
// board is even allowed to reap, decide which servers are reapable.
//
// A server is dead weight unless its port is reserved by an in-progress issue —
// but "dead weight" is not the same as "collectable now": while a chat is still
// working in the server's workspace, its preview is part of that chat's ground
// and stays up. That is the idle requirement this verdict used not to have.
//
// A cwd we cannot read is UNKNOWN, not "outside every worktree": the row is kept
// and says so. Failing safe costs a port; failing open costs a working agent.
//
// No self guard, no stand-down: this runs only in the supervisor, which
// listens on 5170 — never inside the 5200-5299 range it reaps — and is not
// tied to any issue's status. The old elected-dash world needed a process to
// never reap its own server and to hand the role off when its own issue
// retired; both concepts died with per-dev-server election.
export function devServerVerdicts({
  live, reserved, statusById, busy = new Map(), authOk = true,
}) {
  const issueByPort = new Map([...reserved].map(([id, port]) => [Number(port), id]));
  return live.map(({ port, pid, cwd = null }) => {
    const issue = issueByPort.get(port) || null;
    const status = issue ? (statusById.get(issue) || 'unknown') : null;
    // "Orphaned" is only meaningful when the board OWNS these ports. On a cloned
    // board no real port maps to anything, so the flag is reported for the human
    // reading the CLI but can never carry a verdict.
    const orphaned = !issue;
    const inProgress = status === 'in-progress';
    const workspace = cwd ? workspaceForDir(cwd) : null;
    const holders = workspace ? (busy.get(workspace) || []) : [];
    const keepReasons = [];
    if (!authOk) keepReasons.push('board may not reap');
    if (inProgress) keepReasons.push('issue in-progress');
    if (!cwd) keepReasons.push('cwd unknown');
    keepReasons.push(...holders);
    return {
      port, pid, cwd, workspace, issue, status, orphaned,
      quiet: holders.length === 0, reap: keepReasons.length === 0, keepReasons,
    };
  });
}

// --- the survey -------------------------------------------------------------
// ONE read of the world, three fleets off it. The board, the process table and
// the listeners are all sampled once, and the chat verdicts feed the other two
// through busyWorkspaces — so the three fleets can never disagree about which
// workspaces are still working, which is the whole point of the shared rule.
//
// Ordering is deliberate: the cheap signals (board status, chats) decide who is
// even a candidate, and only then does probeSafety run `git status` — one index
// refresh per candidate worktree, on a box that can hold dozens of them.
//
// Run from the CLI our pid is the short-lived reaper process — never a dev
// server — so `self` matches nothing there.
export async function reapSurvey({ idleMinutes = IDLE_MINUTES } = {}) {
  const auth = reapAuthority();
  const [procs, tree, rows, mainSel, live, spaces] = await Promise.all([
    agentProcesses(), processTree(), listAll(), selectedChats(), liveDevPorts(),
    listWorkspaces(),
  ]);
  // Identity first (the journal names the hosted chats and unmasks their helper
  // subprocesses), then dating — so a chat codex named only in the journal still
  // gets a transcript looked up for it.
  const { chats: named, helpers } = identifyChats(procs, chatIdentities(journalRecords()), tree);
  const agents = await dateChats(named);
  // Every process under a chat needs its cwd read, not just the agent binaries:
  // a chat's shell can be running a build in a different worktree, and that
  // directory has to be held. One lsof for the lot.
  const underChats = named.flatMap((c) => descendants(c.pid, tree.kids));
  const cwds = await cwdByPid([...new Set([
    ...agents.map((a) => a.pid), ...underChats, ...live.map((l) => l.pid),
  ])]);

  const chats = chatVerdicts({
    agents, tree, rows, selected: selectedSessions(mainSel, rows), cwds, idleMinutes, authOk: auth.ok,
  });
  const busy = busyWorkspaces(chats, chatOccupants(chats, tree, cwds));

  const reserved = new Map(rows.filter((r) => r.port != null).map((r) => [r.id, Number(r.port)]));
  const statusById = new Map(rows.map((i) => [i.id, i.status]));
  const servers = devServerVerdicts({
    live: live.map((l) => ({ ...l, cwd: cwds.get(l.pid) ?? null })),
    reserved, statusById, busy, authOk: auth.ok,
  });

  const selfWorkspace = workspaceForDir(process.cwd());
  const unprobed = worktreeVerdicts({ worktrees: spaces, rows, busy, selfWorkspace, authOk: auth.ok });
  const safety = await probeSafety(spaces.filter((s) => unprobed.find((r) => r.workspace === s.workspace)?.collect));
  const worktrees = worktreeVerdicts({ worktrees: spaces, rows, busy, safety, selfWorkspace, authOk: auth.ok });

  return { auth, rows, chats, helpers, servers, worktrees };
}

// The per-fleet checkers, each a thin read of the one survey — kept because the
// CLI report and the isolation tests ask for a single fleet at a time.
export async function pruneCandidates(opts) { return (await reapSurvey(opts)).chats; }
export async function devServerCandidates() { return (await reapSurvey()).servers; }
export async function worktreeCandidates() { return (await reapSurvey()).worktrees; }

// --- CLI proposal report ----------------------------------------------------
// IDLE is the conversation's own clock; MTIME is the transcript file's. They are
// printed SIDE BY SIDE because their disagreement is the defect this fleet was
// built on — a file rewritten in place with no new line reads as freshly active,
// and the reaper used to believe it. Seeing `4d / 10m` in one row is the whole
// argument for why the left column is the one that decides.
const mins = (m) => (m == null ? '?' : m < 90 ? `${m.toFixed(0)}m` : m < 2880 ? `${(m / 60).toFixed(0)}h` : `${(m / 1440).toFixed(0)}d`);

function fmt(rows) {
  const line = (c) => c.join('  ');
  const out = [line(['REAP', 'PID', 'IDLE ', 'MTIME', 'ISSUE(status)', 'AGENT/SESSION', 'WHY KEPT'])];
  for (const r of rows.sort((a, b) => (b.reap - a.reap) || ((b.idle ?? -1) - (a.idle ?? -1)))) {
    out.push(line([
      r.reap ? ' ✓ ' : '   ',
      String(r.pid).padEnd(6),
      mins(r.idle).padEnd(5),
      mins(r.fileIdle).padEnd(5),
      (r.links.map((l) => `${l.id}(${l.status})`).join(',') || '(no issue)').padEnd(28),
      agentLabel(r).padEnd(18),
      r.reap ? '' : r.keepReasons.join('; '),
    ]));
  }
  return out.join('\n');
}

function fmtServers(rows) {
  const out = ['REAP  PORT   PID     ISSUE(status)          WHY KEPT'];
  for (const r of rows.sort((a, b) => (b.reap - a.reap) || (a.port - b.port))) {
    const where = r.orphaned ? '(orphaned — no issue)' : `${r.issue}(${r.status})`;
    out.push(`${r.reap ? ' ✓  ' : '    '}  ${String(r.port).padEnd(5)}  ${String(r.pid).padEnd(6)}  ${where.padEnd(22)} ${r.reap ? '' : r.keepReasons.join('; ')}`);
  }
  return out.join('\n');
}

// Three columns, because a worktree has three fates, not two: kept, collected
// (port + server) and fully removed (directory + branch). A row that is
// collected but not removable owes the reason — "dirty" and "unmerged" are the
// two states a human has to resolve by hand, and silence about them reads as
// "the reaper is stuck" instead of "your work is still there".
function fmtWorktrees(rows) {
  const out = ['COLLECT  RM   WORKSPACE                       ISSUE(status)          NOTES'];
  for (const r of rows.sort((a, b) => (b.collect - a.collect) || a.workspace.localeCompare(b.workspace))) {
    const where = r.issue ? `${r.issue}(${r.status})` : '(no issue)';
    const note = r.collect ? (r.remove ? '' : `dir kept — ${r.removeBlockers.join('; ')}`) : r.keepReasons.join('; ');
    out.push(`  ${r.collect ? '✓' : ' '}      ${r.remove ? '✓' : ' '}   ${r.workspace.padEnd(30)}  ${where.padEnd(22)} ${note}`);
  }
  return out.join('\n');
}

async function report() {
  const { auth, chats, helpers, servers, worktrees } = await reapSurvey();
  if (!auth.ok) console.log(`⚠ this process may not reap: ${auth.reason}\n  (verdicts below are all "keep" for that reason, not because the fleet is clean)\n`);
  const reap = chats.filter((r) => r.reap);
  const reapS = servers.filter((s) => s.reap);
  const collect = worktrees.filter((w) => w.collect);
  const drifted = chats.filter((r) => r.idle != null && r.fileIdle != null && r.idle - r.fileIdle >= IDLE_MINUTES);
  console.log('CHATS');
  console.log(fmt(chats));
  console.log(`\n${chats.length} live chats · ${reap.length} proposed to reap (idle ≥ ${IDLE_MINUTES}m, not in-progress, nothing running under them)`);
  if (helpers?.length) console.log(`${helpers.length} agent subprocess(es) excluded — a chat's own tooling, not a chat: ${helpers.map((h) => `${h.agent} ${h.pid}`).join(', ')}`);
  if (drifted.length) console.log(`${drifted.length} transcript(s) whose MTIME under-reports idleness by ≥ ${IDLE_MINUTES}m — rewritten in place, no new message`);
  if (reap.length) console.log(`would stop: ${reap.map((r) => r.pid).join(' ')}`);
  console.log('\nDEV SERVERS');
  console.log(fmtServers(servers));
  console.log(`\n${servers.length} live dev servers · ${reapS.length} proposed to reap (retired issue, workspace quiet)`);
  if (reapS.length) console.log(`would free ports: ${reapS.map((s) => s.port).join(' ')}`);
  console.log('\nWORKTREES');
  console.log(fmtWorktrees(worktrees));
  console.log(`\n${worktrees.length} worktrees · ${collect.length} proposed to collect · ${collect.filter((w) => w.remove).length} fully removable (clean + merged or gravestoned)`);
}

// --- the plan: everything this process would stop, and whether it may --------
// Read-only, and the single surface both the sweep and the tests ask. An
// unauthorised board short-circuits: it does no probing at all and plans
// nothing, so "may not reap" can never degrade into "reaped a little".
export async function reapPlan() {
  const { ok, reason } = reapAuthority();
  if (!ok) return { authorized: false, reason, kill: { chats: [], servers: [], worktrees: [] } };
  const { chats, servers, worktrees } = await reapSurvey();
  return {
    authorized: true,
    reason: null,
    kill: {
      chats: chats.filter((c) => c.reap),
      servers: servers.filter((s) => s.reap),
      worktrees: worktrees.filter((w) => w.collect),
    },
  };
}

// --- execute: actually stop the reap candidates -----------------------------
// Chats: SIGTERM the agent process — its transcript is on disk, so it cold-
// resumes later, and the dash notices the pty exit and cleans its own registry.
// Dev servers: freePort tears down the listener and clears the issue's port
// reservation; an orphan with no issue is killed by pid.
// Worktrees LAST, because collecting one frees the same port the server pass may
// already have taken — and both are idempotent, so the second run is a no-op
// rather than a conflict. A collected worktree loses its directory and branch
// only when git said it was safe; otherwise it keeps them and says why.
//
// It prints a line PER KILL and nothing else, returning the counts so the caller
// decides whether a summary is worth saying: the server's five-minute sweep is
// silent on an idle pass (housekeeping that did nothing is not news in a server
// log), while a hand-run `--reap` always reports, since silence there reads as
// a failed command.
// Stop the reaped chats — the ONLY way this module ends a chat, extracted so the
// contract can be driven directly. Its own function because "how the reaper stops
// a chat" is exactly the thing that must not silently regress: this branch and
// i-merge-teardown both rewrote reap(), and a merge that quietly restored a
// direct `process.kill(c.pid)` here would be invisible to a test that only
// exercised endChat.
//
// Stopping a chat must go through the LEDGER, not straight to the signal.
// Reaping is a deliberate finish, and the registry is now what distinguishes that
// from "a server died under a working chat" — the second gets resurrected at the
// next boot. Signalling the agent directly leaves precisely the
// dead-owner/dead-child record that reads as the second, so every chat the reaper
// stopped for being idle would come back on the next restart: the reaper would
// invert itself, and only because chats learned to come back at all.
//
// endChat owns the whole ending — it kills the PTY and clears the record when the
// chat belongs to this dash, and for an ORPHAN (the reaper's usual target, where
// no dash is left to observe the exit) it marks the record finished and then
// signals the agent. Imported lazily so the read-only report path, and the CLI
// that only prints a proposal, never load the terminal module.
// endChat is map + journal only now (no process probes — the supervisor is the
// sole PTY host), so the old prefetched-evidence dance is gone with the
// registry it probed. A reaped chat found by the ps scan but NOT hosted here is
// an agent someone runs in their own terminal — never ours to kill.
export async function stopChats(chatKills) {
  if (!chatKills.length) return 0;
  const { endChat } = await import('./terminal.js');
  for (const c of chatKills) {
    try { await endChat(c.sessionId); console.log(`stopped chat ${c.sessionId.slice(0, 8)} (pid ${c.pid})`); }
    catch (e) { console.log(`chat ${c.pid} — ${e.message}`); }
  }
  return chatKills.length;
}

// Stop the reapable dev servers. freePort tears down the listener AND clears the
// issue's reservation; an orphan that no issue reserves is killed by pid.
export async function stopServers(serverKills) {
  for (const s of serverKills) {
    if (s.issue) {
      const r = await freePort(s.issue);
      console.log(r.error ? `server ${s.issue} — ${r.error}` : `freed port ${s.port} (${s.issue})`);
    } else {
      try { process.kill(s.pid, 'SIGTERM'); console.log(`killed orphan server on ${s.port} (pid ${s.pid})`); }
      catch (e) { console.log(`orphan ${s.port} — ${e.message}`); }
    }
  }
  return serverKills.length;
}

// Collect the retired, quiet workspaces. Returns how many DIRECTORIES went —
// a collection that only released a port is real work but not a removal.
export async function collectWorkspaces(spaces) {
  let removed = 0;
  // One kernel read of every live cwd for the whole pass, shared by each removal
  // (see worktree-reaper's liveCwds): the plan said these workspaces were free,
  // and this is the last-moment re-check that nobody is still standing in one.
  // A FAILED read comes back null and every removal in the pass declines — never
  // undefined, which would send each row off to read for itself and turn one
  // failure into N. When nothing is removable the read is skipped entirely, and
  // an empty Set is the honest input: no removal will consult it.
  const cwds = spaces.some((w) => w.remove) ? await liveCwds() : new Set();
  for (const w of spaces) {
    const r = await collectWorkspace(w, cwds);
    if (r.removed) removed++;
    // Speak only when something actually CHANGED. Most retired worktrees stay
    // forever — a dirty tree or an unmerged branch is a standing state, not
    // news — and narrating each one every five minutes would bury the real
    // events under dozens of identical lines. The read-only report is where you
    // go to see the standing state and why.
    if (!r.removed && r.port == null && !r.errors.length) continue;
    const what = r.removed
      ? `removed worktree ${w.workspace}${r.branchDeleted ? ` + branch ${w.branch}` : ''}`
      : `collected ${w.workspace} — directory kept (${w.removeBlockers.join('; ')})`;
    console.log(r.errors.length ? `${what} — ${r.errors.join('; ')}` : what);
  }
  return removed;
}

// Execute the plan. Dependency-injected for the same reason reaperTick is: the
// thing that must not silently change is the DISPATCH — that all three fleets
// are acted on, in this order. Two branches rewrote this function at once and
// the merge could have dropped a fleet with every test still green, because the
// suites drive stopChats/collectWorkspace directly and nothing checked that
// `reap` still calls them. That is the trap of a function too destructive to run
// in a test: you test its collaborators, and testing the collaborators is what
// makes you feel covered. Injected, the dispatch is assertable without killing
// anything, and the defaults ARE the production path.
//
// ORDER is part of the contract. Chats stop first so a reaped chat's record is
// marked finished before anything else touches its workspace — otherwise the
// next boot's restore sees a live-looking record for a chat we deliberately
// stopped. Worktrees go last, because collecting one frees the same port the
// server pass may already have taken, and both are idempotent.
export async function reap({
  plan: makePlan = reapPlan,
  chats: doChats = stopChats,
  servers: doServers = stopServers,
  worktrees: doWorktrees = collectWorkspaces,
} = {}) {
  const plan = await makePlan();
  if (!plan.authorized) {
    console.log(`reaper: refusing to reap — ${plan.reason}`);
    return { authorized: false, reason: plan.reason, chats: 0, servers: 0, worktrees: 0 };
  }
  const { chats: chatKills, servers: serverKills, worktrees: spaces } = plan.kill;
  const chats = await doChats(chatKills);
  const servers = await doServers(serverKills);
  const worktrees = await doWorktrees(spaces);
  return { authorized: true, reason: null, chats, servers, worktrees };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const run = process.argv.includes('--reap')
    ? () => reap().then((n) => { if (n.authorized !== false) console.log(`\nreaped ${n.chats} chat(s) + ${n.servers} dev server(s) + ${n.worktrees} worktree(s)`); })
    : report;
  run().catch((e) => { console.error(e); process.exit(1); });
}
