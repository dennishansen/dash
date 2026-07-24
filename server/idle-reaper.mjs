// Reaper — CHECKER ONLY (read-only proposal), deliberately ISOLATED. Covers two
// fleets: idle chat agents, and worktree dev (vite) servers.
//
// CHATS — background `claude` agent processes that would be safe to stop:
//   • idle for >= IDLE_MINUTES   (last activity = the chat transcript's mtime —
//     the ground-truth moment the agent last wrote anything; no model turn is
//     silent for 20 minutes, so this alone excludes "waiting on the model")
//   • NOT linked to any in-progress issue on the board
//   • nothing running underneath it (no active child shell / build / task, and
//     the agent process itself isn't burning CPU)
//
// Nothing is killed here. `node dash/server/idle-reaper.mjs` prints the proposal
// so a human can eyeball it; wiring the actual stop + a sweep timer comes later.
// All signals are deterministic snapshots of the OS + the board — no viewport
// scraping, no CPU-threshold guessing for the kill decision (CPU is reported as
// a secondary flag only).

import './node-env.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { listAll, reservedPorts, TABLE as ISSUES_TABLE, PROD_TABLE as ISSUES_PROD } from './issues-store.mjs';
import { parseHandle } from './agents.mjs';
import { selectedChats, TABLE as PROFILES_TABLE, PROD_TABLE as PROFILES_PROD } from './profiles-store.mjs';
import { freePort } from './ports.mjs';

const pExec = promisify(execFile);
export const IDLE_MINUTES = 20;

// --- who may reap ------------------------------------------------------------
// Everything below decides the fate of MACHINE-GLOBAL things: OS processes and
// TCP listeners that every checkout on this box shares. A board pointed at a
// CLONED table (a test/dev profiles clone) can't speak for this machine: reading
// real pids/ports against a cloned board inverts every verdict — nothing matches,
// so every dev server reads "orphaned" and every chat "not in-progress", and a
// sweep would stop the whole fleet. So authority is granted only by the exact
// production tables, and it gates the VERDICT, not merely the kill. Anything not
// production fails closed.
export function reapAuthority() {
  const foreign = [];
  if (ISSUES_TABLE !== ISSUES_PROD) foreign.push(`issues table "${ISSUES_TABLE}"`);
  if (PROFILES_TABLE !== PROFILES_PROD) foreign.push(`profiles table "${PROFILES_TABLE}"`);
  return foreign.length
    ? { ok: false, reason: `not the production board (${foreign.join(', ')}) — it cannot speak for this machine` }
    : { ok: true, reason: null };
}

// --- live agent processes ---------------------------------------------------
// The REAL session process carries `--session-id <uuid>` but NOT `--bg-pty-host`
// (that flag marks the pty-host wrapper, which only echoes the same uuid). The
// `--resume <path>.jsonl` arg, when present, is the transcript path directly.
async function liveAgents() {
  const { stdout } = await pExec('ps', ['-Ao', 'pid=,command=']);
  const agents = [];
  for (const line of stdout.split('\n')) {
    if (!line.includes('--session-id') || line.includes('--bg-pty-host')) continue;
    const id = line.match(/--session-id\s+([0-9a-f-]{36})/);
    if (!id) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    const resume = line.match(/--resume\s+(\S+\.jsonl)/);
    agents.push({ pid, sessionId: id[1], transcript: resume ? resume[1] : null });
  }
  return agents;
}

// --- last activity = transcript file mtime ----------------------------------
function transcriptFor(agent) {
  if (agent.transcript && fs.existsSync(agent.transcript)) return agent.transcript;
  const root = path.join(os.homedir(), '.claude', 'projects');
  try {
    for (const dir of fs.readdirSync(root)) {
      const f = path.join(root, dir, `${agent.sessionId}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch {}
  return null;
}
function idleFor(agent) {
  const t = transcriptFor(agent);
  if (!t) return null;
  return (Date.now() - fs.statSync(t).mtimeMs) / 60000; // minutes
}

// --- process tree, to spot work running under an agent ----------------------
async function processTree() {
  const { stdout } = await pExec('ps', ['-Ao', 'pid=,ppid=,pcpu=,comm=']);
  const byPid = new Map();
  const kids = new Map();
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const [pid, ppid, pcpu, ...comm] = t.split(/\s+/);
    byPid.set(+pid, { pid: +pid, ppid: +ppid, cpu: +pcpu, comm: comm.join(' ') });
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
// "Real work" = a child actually using the processor, or a shell mid-command
// (a shell with its own child). Merely-existing idle helpers (background `node`
// servers for editor/tools, at ~0% cpu, no children) are NOT work.
function busyReason(pid, { byPid, kids }) {
  for (const d of descendants(pid, kids)) {
    const p = byPid.get(d);
    if (!p) continue;
    if (p.cpu > 5) return `busy child ${p.comm} (${p.cpu.toFixed(0)}%)`;
    const isShell = /(^|\/)(sh|bash|zsh|fish)$/.test(p.comm);
    if (isShell && (kids.get(d) || []).length > 0) return `shell running a command`;
  }
  return null;
}

// --- session -> linked issues + their status --------------------------------
async function statusBySession() {
  const issues = await listAll();
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

// --- the checker ------------------------------------------------------------
// Returns one row per live agent with all signals + a reap verdict. Pure read.
export async function pruneCandidates({ idleMinutes = IDLE_MINUTES } = {}) {
  const auth = reapAuthority();
  const [agents, tree, statuses, mainSel] = await Promise.all([
    liveAgents(), processTree(), statusBySession(), selectedChats().then((s) => new Set(s)),
  ]);
  return agents.map((a) => {
    const idle = idleFor(a);
    const links = statuses.get(a.sessionId) || [];
    const inProgress = links.some((l) => l.status === 'in-progress');
    const busy = busyReason(a.pid, tree);
    const ownCpu = tree.byPid.get(a.pid)?.cpu ?? 0;
    const viewed = mainSel.has(a.sessionId);
    const keepReasons = [];
    // A board that may not reap keeps everything — and says so, so the report
    // reads as "I'm not allowed to judge this", not a silent all-clear.
    if (!auth.ok) keepReasons.push('board may not reap');
    if (viewed) keepReasons.push('currently selected');
    if (idle == null) keepReasons.push('no transcript found');
    else if (idle < idleMinutes) keepReasons.push(`active ${idle.toFixed(0)}m ago`);
    if (inProgress) keepReasons.push('issue in-progress');
    if (busy) keepReasons.push(busy);
    if (ownCpu > 5) keepReasons.push(`agent busy (${ownCpu.toFixed(0)}% cpu)`);
    return { ...a, idle, links, inProgress, busy, ownCpu, reap: keepReasons.length === 0, keepReasons };
  });
}

// --- dev servers ------------------------------------------------------------
// The vite preview server for a worktree. Unlike a chat there is no "idle" —
// a server for an issue that is no longer in-progress is dead weight, and one
// listening on a port no issue reserves is an orphan (its owning dash died and
// left it running, parented to launchd). Both are safe to stop: the dash
// respawns a server on demand when you open that issue's app tab. So the rule
// is simply "not on an in-progress issue → reap", no timer needed.
const DEV_PORT_MIN = 5200;
const DEV_PORT_MAX = 5299;

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

// One row per live dev server with a reap verdict. Reap = not tied to an
// in-progress issue (a done/next/rejected issue's leftover server, or an orphan
// no issue reserves at all).
export async function devServerCandidates() {
  const auth = reapAuthority();
  const [live, reserved, issues] = await Promise.all([liveDevPorts(), reservedPorts(), listAll()]);
  const statusById = new Map(issues.map((i) => [i.id, i.status]));
  const issueByPort = new Map([...reserved].map(([id, port]) => [Number(port), id]));
  return live.map(({ port, pid }) => {
    const issue = issueByPort.get(port) || null;
    const status = issue ? (statusById.get(issue) || 'unknown') : null;
    // "Orphaned" is only meaningful when the board OWNS these ports. On a cloned
    // board no real port maps to anything, so the flag can never carry a verdict.
    const orphaned = !issue;
    const inProgress = status === 'in-progress';
    return { port, pid, issue, status, orphaned, reap: auth.ok && !inProgress };
  });
}

// --- CLI proposal report ----------------------------------------------------
function fmt(rows) {
  const line = (c) => c.join('  ');
  const out = [line(['REAP', 'PID', 'IDLE', 'ISSUE(status)', 'SESSION', 'WHY KEPT'])];
  for (const r of rows.sort((a, b) => (b.reap - a.reap) || ((b.idle ?? -1) - (a.idle ?? -1)))) {
    out.push(line([
      r.reap ? ' ✓ ' : '   ',
      String(r.pid).padEnd(6),
      (r.idle == null ? '  ?  ' : `${r.idle.toFixed(0)}m`).padEnd(6),
      (r.links.map((l) => `${l.id}(${l.status})`).join(',') || '(no issue)').padEnd(28),
      r.sessionId.slice(0, 8),
      r.reap ? '' : r.keepReasons.join('; '),
    ]));
  }
  return out.join('\n');
}

function fmtServers(rows) {
  const out = ['REAP  PORT   PID     ISSUE(status)'];
  for (const r of rows.sort((a, b) => (b.reap - a.reap) || (a.port - b.port))) {
    const where = r.orphaned ? '(orphaned — no issue)' : `${r.issue}(${r.status})`;
    out.push(`${r.reap ? ' ✓  ' : '    '}  ${String(r.port).padEnd(5)}  ${String(r.pid).padEnd(6)}  ${where}`);
  }
  return out.join('\n');
}

async function report() {
  const auth = reapAuthority();
  if (!auth.ok) console.log(`⚠ this process may not reap: ${auth.reason}\n  (verdicts below are all "keep" for that reason, not because the fleet is clean)\n`);
  const [rows, servers] = await Promise.all([pruneCandidates(), devServerCandidates()]);
  const reap = rows.filter((r) => r.reap);
  const reapS = servers.filter((s) => s.reap);
  console.log('CHATS');
  console.log(fmt(rows));
  console.log(`\n${rows.length} live agents · ${reap.length} proposed to reap (idle ≥ ${IDLE_MINUTES}m, not in-progress, nothing running under them)`);
  if (reap.length) console.log(`would stop: ${reap.map((r) => r.pid).join(' ')}`);
  console.log('\nDEV SERVERS');
  console.log(fmtServers(servers));
  console.log(`\n${servers.length} live dev servers · ${reapS.length} proposed to reap (not on an in-progress issue)`);
  if (reapS.length) console.log(`would free ports: ${reapS.map((s) => s.port).join(' ')}`);
}

// --- execute: actually stop the reap candidates -----------------------------
// Chats: SIGTERM the agent process — its transcript is on disk, so it cold-
// resumes later, and the dash notices the pty exit and cleans its own registry.
// Dev servers: freePort tears down the listener and clears the issue's port
// reservation; an orphan with no issue is killed by pid. Idempotent — an
// already-gone target just no-ops.
export async function reap() {
  const auth = reapAuthority();
  if (!auth.ok) { console.log(`reaper: refusing to reap — ${auth.reason}`); return; }
  const [chats, servers] = await Promise.all([pruneCandidates(), devServerCandidates()]);
  const chatKills = chats.filter((c) => c.reap);
  const serverKills = servers.filter((s) => s.reap);
  for (const c of chatKills) {
    try { process.kill(c.pid, 'SIGTERM'); console.log(`stopped chat ${c.sessionId.slice(0, 8)} (pid ${c.pid})`); }
    catch (e) { console.log(`chat ${c.pid} — ${e.message}`); }
  }
  for (const s of serverKills) {
    if (s.issue) {
      const r = await freePort(s.issue);
      console.log(r.error ? `server ${s.issue} — ${r.error}` : `freed port ${s.port} (${s.issue})`);
    } else {
      try { process.kill(s.pid, 'SIGTERM'); console.log(`killed orphan server on ${s.port} (pid ${s.pid})`); }
      catch (e) { console.log(`orphan ${s.port} — ${e.message}`); }
    }
  }
  console.log(`\nreaped ${chatKills.length} chat(s) + ${serverKills.length} dev server(s)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const run = process.argv.includes('--reap') ? reap : report;
  run().catch((e) => { console.error(e); process.exit(1); });
}
