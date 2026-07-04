// Dash issues — shape Supabase `issues` rows for the kanban.
//
// Single source of truth: the Supabase `issues` table (see issues-store.mjs).
// Each row holds content (title, body, tags, sessions, commits) AND its
// board slice (status column, rank, owner). There is no markdown registry — the
// table is the registry of which issues exist, shared live across machines.
//
// This module is the view layer: it fetches rows from the store and joins, at
// read time, branch liveness (live researcher PID, worktree path) for issues
// whose `branches` array names a live local branch. All functions are async.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import {
  listAll, get, create, setRanks, moveColumn, update, VALID_STATUS,
} from './issues-store.mjs';
import { shapeRow } from './issues-shape.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..', '..');

function exists(p) { try { return fs.statSync(p) && true; } catch { return false; } }

// Detect whether a branch has a live researcher process. Mirrors the one in
// dash-api.js. Duplicated here so this module is self-contained.
function detectLiveResearcher(branch) {
  const worktreePath = path.join(REPO, 'worktrees', 'researchers', branch);
  const pidPath = path.join(worktreePath, 'researcher.pid');
  if (!exists(pidPath)) return { live: false, pid: null, worktreePath: null };
  let pid;
  try { pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10); }
  catch { return { live: false, pid: null, worktreePath: null }; }
  if (!Number.isFinite(pid)) return { live: false, pid: null, worktreePath: null };
  try { process.kill(pid, 0); return { live: true, pid, worktreePath }; }
  catch (e) {
    if (e.code === 'EPERM') return { live: true, pid, worktreePath };
    return { live: false, pid, worktreePath };
  }
}

// Branch existence — needed to decide if a `branches[]` entry is alive.
function liveBranchNames() {
  try {
    const out = execSync(`git -C "${REPO}" for-each-ref --format='%(refname:short)' refs/heads/`, { encoding: 'utf8' });
    return new Set(out.split('\n').map(s => s.trim()).filter(Boolean));
  } catch { return new Set(); }
}

// Resolve branch liveness for an issue's `branches` array against the set of
// live local branches. Returns the first live researcher found, if any.
function resolveLive(issueBranches, branches) {
  for (const b of issueBranches) {
    if (!branches.has(b)) continue;
    const r = detectLiveResearcher(b);
    if (r.live) return { live: true, live_pid: r.pid, worktree_path: r.worktreePath };
  }
  return { live: false, live_pid: null, worktree_path: null };
}

// Shape a raw store row into the kanban item, joining git-derived liveness.
// The row→item field mapping itself lives in the isomorphic issues-shape.mjs
// (shared with the browser board-store); here we only compute the liveness.
function shape(row, branches) {
  const issueBranches = Array.isArray(row.branches) ? row.branches : [];
  return shapeRow(row, resolveLive(issueBranches, branches));
}

// Every issue, joined with branch liveness. Live cards first, then created desc.
export async function listIssues() {
  const branches = liveBranchNames();
  const rows = await listAll();
  const items = rows.map(r => shape(r, branches));
  items.sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    return (b.created || '').localeCompare(a.created || '');
  });
  return items;
}

// Reorder one column (rank = index). Status untouched. See issues-store.
export async function reorderChanges(ids) {
  if (!Array.isArray(ids)) return { error: 'ids must be an array' };
  const r = await setRanks(ids);
  return r.error ? r : { ok: true, updated: ids.length };
}

// Cross-column drag: `ids` is the target column's final ordering (dragged card
// at its drop slot). Sets status + renumbers 0..n atomically.
export async function moveChange(status, ids) {
  return moveColumn(status, ids);
}

// Create a blank issue from a column's + button. The id is generated (the user
// hasn't titled it yet — they rename from the detail view they land on). `ids`
// is the column's existing issue ordering; ranking the new id ahead of it puts
// the card at the top of that column, mirroring the reorder/move contract.
export async function createChange(status, ids) {
  if (!VALID_STATUS.has(status)) return { error: `invalid status "${status}"` };
  const id = `i-${crypto.randomBytes(3).toString('hex')}`;
  const r = await create({ id, title: 'New issue', status, created: new Date().toISOString().slice(0, 10) });
  if (r.error) return r;
  const rank = await setRanks([id, ...(Array.isArray(ids) ? ids : [])]);
  if (rank.error) return rank;
  return { ok: true, id };
}

// Inline rename from a kanban card. Title only — status/rank/body untouched.
export async function renameChange(id, title) {
  const t = (title || '').trim();
  if (!id || !t) return { error: 'rename requires id and non-empty title' };
  await update(id, { title: t });
  return { ok: true, id, title: t };
}

// Unified change corpus: every issue IS a change. On top of those we surface any
// LIVE in-flight branch (a running researcher) that no issue references yet — so
// work-in-flight is never invisible. We deliberately do NOT dump historical
// merged/rejected branch refs; those are legacy raw experiments.
export async function listChanges() {
  const changes = await listIssues();
  const claimed = new Set();
  for (const c of changes) for (const b of c.branches || []) claimed.add(b);

  const TRUNK = new Set(['main', 'master']);
  for (const b of liveBranchNames()) {
    if (TRUNK.has(b) || claimed.has(b)) continue;
    const r = detectLiveResearcher(b);
    if (!r.live) continue;
    let subject = null;
    try {
      subject = execSync(`git -C "${REPO}" log -1 --format=%s "main..${b}"`, { encoding: 'utf8' }).trim() || null;
    } catch {}
    const id = b.replace(/^worktree-(agent-)?/, '');
    changes.push({
      id,
      title: subject || b,
      status: 'in-progress',   // a running researcher branch is active work
      owner: null,
      tags: [],
      branches: [b],
      sessions: [],
      commits: [],
      conversations: [],
      created: null,
      updated: null,
      live: true,
      live_pid: r.pid,
      worktree_path: r.worktreePath,
      branch: b,
      kind: 'branch',          // detail view dispatches on this
    });
  }
  changes.sort((a, c) => {
    if (a.live !== c.live) return a.live ? -1 : 1;
    return (c.created || '').localeCompare(a.created || '');
  });
  return changes;
}

// One issue with its body, branch liveness joined.
export async function issueDetail(id) {
  const row = await get(id);
  if (!row) return null;
  const branches = liveBranchNames();
  const item = shape(row, branches);
  return { ...item, body: row.body || '' };
}
