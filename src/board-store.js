// Browser board data layer — model A (remote board on artifact.xyz).
//
// The kanban is a Supabase app: the `issues` table is the single source of
// truth and the committed anon key has read+write. So on Vercel, where there is
// NO /api/dash server, the board talks to Supabase directly from the browser —
// reusing the exact same isomorphic store that board.mjs and the dev middleware
// use (issues-store.mjs). No serverless proxy, no new infra.
//
// What this DELIBERATELY drops vs the local /api/dash/changes path: git-derived
// liveness (the live-worktree dot, branch subject) and the synthetic
// "unclaimed live researcher branch" cards. Those need a local git checkout —
// they're machine-specific and correctly absent remotely. The browser terminal
// is likewise local-only (see capabilities.js).

import {
  listAll, listBodies as listBodiesStore, get, create, update, setRanks, moveColumn, setStatus, remove, VALID_STATUS,
} from '../server/issues-store.mjs';
import { shapeRow } from '../server/issues-shape.mjs';

// Live cards first is a git concept (none here), so the remote order is simply
// created desc — the same secondary sort the local path uses.
function byCreatedDesc(a, b) {
  return (b.created || '').localeCompare(a.created || '');
}

// Every issue, shaped for the kanban (no liveness). Mirrors listChanges minus
// the git-only decorations.
export async function listChanges() {
  const rows = await listAll();
  return rows.map(r => shapeRow(r)).sort(byCreatedDesc);
}

// id → body for every issue, for the ⌘K palette's description search. Read-only
// (no shaping, no mutation) — the palette builds an id→body map from it.
export async function listBodies() {
  return await listBodiesStore();
}

// One issue with its body. Null if it doesn't exist.
export async function changeDetail(id) {
  const row = await get(id);
  if (!row) return null;
  return { ...shapeRow(row), body: row.body || '' };
}

// Create a blank issue at the top of a column. Mirrors dash-issues.createChange:
// generate an id, insert, then rank it ahead of the column's existing ids.
export async function createChange(status, ids) {
  if (!VALID_STATUS.has(status)) return { error: `invalid status "${status}"` };
  const id = `i-${randomHex(3)}`;
  const r = await create({ id, title: 'New issue', status, created: today() });
  if (r.error) return r;
  const rank = await setRanks([id, ...(Array.isArray(ids) ? ids : [])]);
  if (rank.error) return rank;
  return { ok: true, id };
}

// Cross-column drag: `ids` is the target column's final order.
export async function moveChange(status, ids) {
  return moveColumn(status, ids);
}

// Set one issue's status directly (the detail view's status menu). Unlike a
// drag, there's no target-column ordering to renumber — the card just changes
// columns and keeps its rank.
export async function setChangeStatus(id, status) {
  return setStatus(id, status);
}

// Reorder within a column.
export async function reorderChange(ids) {
  return setRanks(ids);
}

// Inline rename.
export async function renameChange(id, title) {
  const t = (title || '').trim();
  if (!id || !t) return { error: 'rename requires id and non-empty title' };
  return update(id, { title: t });
}

// Generic single-field patch (tags add/remove, convo unlink, …). The detail
// view computes the next array value and writes it; we just forward to update.
export async function updateChangeField(id, field, value) {
  return update(id, { [field]: value });
}

// Permanently delete an issue (the detail view's double-opt-in delete). Drops
// the Supabase row outright — there's no soft-delete column, and the rejected
// column already serves the "kept but dead" case, so delete means gone.
export async function deleteChange(id) {
  if (!id) return { error: 'delete requires an id' };
  return remove(id);
}

// Header counts (replaces /api/dash/state's change_count).
export async function stateCounts() {
  const rows = await listAll();
  return { change_count: rows.length };
}

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}
