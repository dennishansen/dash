// Idle-agent reaper — CHECKER ONLY (read-only proposal), deliberately ISOLATED.
//
// Finds background `claude` agent processes that would be safe to stop:
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
import { listAll } from './issues-store.mjs';
import { parseHandle } from './agents.mjs';
import { selectedChats } from './profiles-store.mjs';

const pExec = promisify(execFile);
export const IDLE_MINUTES = 20;

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
  const [agents, tree, statuses, selected] = await Promise.all([
    liveAgents(), processTree(), statusBySession(), selectedChats().then((s) => new Set(s)),
  ]);
  return agents.map((a) => {
    const idle = idleFor(a);
    const links = statuses.get(a.sessionId) || [];
    const inProgress = links.some((l) => l.status === 'in-progress');
    const busy = busyReason(a.pid, tree);
    const ownCpu = tree.byPid.get(a.pid)?.cpu ?? 0;
    const viewed = selected.has(a.sessionId);
    const keepReasons = [];
    if (viewed) keepReasons.push('currently selected');
    if (idle == null) keepReasons.push('no transcript found');
    else if (idle < idleMinutes) keepReasons.push(`active ${idle.toFixed(0)}m ago`);
    if (inProgress) keepReasons.push('issue in-progress');
    if (busy) keepReasons.push(busy);
    if (ownCpu > 5) keepReasons.push(`agent busy (${ownCpu.toFixed(0)}% cpu)`);
    return { ...a, idle, links, inProgress, busy, ownCpu, reap: keepReasons.length === 0, keepReasons };
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

async function report() {
  const rows = await pruneCandidates();
  const reap = rows.filter((r) => r.reap);
  console.log(fmt(rows));
  console.log(`\n${rows.length} live agents · ${reap.length} proposed to reap (idle ≥ ${IDLE_MINUTES}m, not in-progress, nothing running under them)`);
  if (reap.length) console.log(`would stop: ${reap.map((r) => r.pid).join(' ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  report().catch((e) => { console.error(e); process.exit(1); });
}
