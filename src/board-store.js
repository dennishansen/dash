// Browser board data layer — model A (remote board on artifact.xyz).
//
// The kanban is a Supabase app: the `issues` table is the single source of
// truth and the committed anon key has read+write. So on Vercel, where there is
// NO /api/dash server, the board talks to Supabase directly from the browser —
// reusing the exact same isomorphic store that board.mjs and the dev middleware
// use (issues-store.mjs). No serverless proxy, no new infra.
//
// What this DELIBERATELY drops vs the local /api/dash/changes path: git-derived
// liveness (the live-worktree dot, branch subject). That needs a local git
// checkout — machine-specific and correctly absent remotely. Terminals,
// worktrees and the corpus gallery are likewise local-only (see
// capabilities.js + the guarded views).

import {
  listAll, listBodies as listBodiesStore, get, create, update, placeCards, setStatus, remove, setDep,
} from '../server/issues-store.mjs';
import { VALID_STATUS } from './board-columns.mjs';
import { placedOrder } from './board-sort.js';
import { shapeRow } from '../server/issues-shape.mjs';
import { mutate, read } from './issues-cache.js';
import { userEmail } from './auth.js';

// Every write below is a write-through mutation: issues-cache patches the
// painted views SYNCHRONOUSLY (board, detail, counts show the change at once,
// socket or no socket — i-board-delete-sync), then the REST write confirms
// behind it. Success announces on the issues-change bus (refetch + Realtime to
// other clients); failure rolls the patch back to server truth.

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

// The column's next order as THIS client paints it: derived here, from the
// painted cache's own FULL row list, never handed in by a caller.
//
// That direction matters. A caller holds a VIEW of a column — under a search or
// a tag filter, a subset of it — and a subset renumbered 0..n collides with
// every card it doesn't show. The cache holds all of them, so deriving the paint
// where the paint lives makes a filtered snapshot unrepresentable rather than
// merely discouraged. It is also the same computation from the same inputs the
// server runs, so the optimistic order and the confirmed one agree by
// construction.
//
// The derived order stays local: it is an overlay, and the durable write sends
// only the gesture. Trusting a client's snapshot as truth is what let two people
// racing on one column clobber each other (i-move-column-race).
const paintedOrder = (status, moved, after) => placedOrder(read('changes'), status, moved, after);

// Create a blank issue at the top of a column: generate an id, insert it, then
// place it at the column top (which is also what ranks it — a fresh insert has
// no rank).
export async function createChange(status) {
  if (!VALID_STATUS.has(status)) return { error: `invalid status "${status}"` };
  const id = `i-${randomHex(3)}`;
  // The signed-in creator — immutable provenance. The DB trigger also forces
  // created_by to the JWT email on an authenticated insert, so this can't be
  // spoofed; sending it just keeps the optimistic card correct before refetch.
  const created_by = userEmail();
  const idList = paintedOrder(status, [id], null);
  const row = shapeRow({ id, title: 'New issue', status, created: today(), created_by, rank: 0 });
  return mutate({ type: 'insert', row, ids: idList }, async () => {
    const r = await create({ id, title: 'New issue', status, created: today(), created_by });
    if (r.error) return r;
    const placed = await placeCards([id], status, null); // null anchor = top of the column
    if (placed.error) return placed; // partial write — rollback refetch paints server truth
    return { ok: true, id };
  });
}

// Both board gestures — a cross-column drag and a within-column reorder — are
// one move: `moved` (the dragged card, or a keyboard-nudged run) lands in the
// `status` column right after card `after`, or at the top when `after` is null.
// That is the whole gesture; everything else about it is derived.
export async function placeChange({ status, moved, after }) {
  return mutate({ type: 'rerank', status, ids: paintedOrder(status, moved, after) },
    () => placeCards(moved, status, after));
}

// Set one issue's status directly (the detail view's status menu). Unlike a
// drag, there's no target-column ordering to renumber — the card just changes
// columns and keeps its rank.
export async function setChangeStatus(id, status) {
  return mutate({ type: 'update', id, fields: { status } }, () => setStatus(id, status));
}

// Inline rename.
export async function renameChange(id, title) {
  const t = (title || '').trim();
  if (!id || !t) return { error: 'rename requires id and non-empty title' };
  return mutate({ type: 'update', id, fields: { title: t } }, () => update(id, { title: t }));
}

// Generic patch (tags add/remove, convo unlink, …). The caller computes the next
// value and writes it; we just forward to update. Field names match the shaped
// row (tags, conversations, body), so the merge patches the painted views
// directly. Several fields go in ONE write when they are one edit — selecting a
// brand-new App-pane link sets app_path and app_paths together, and two writes
// would paint (and persist) a half-applied state in between.
export async function updateChangeFields(id, fields) {
  return mutate({ type: 'update', id, fields }, () => update(id, fields));
}

export async function updateChangeField(id, field, value) {
  return updateChangeFields(id, { [field]: value });
}

// Add/remove one dependency on the detail view (the requires/unlocks panel).
// `next` is this issue's own field after the edit — it paints instantly as an
// optimistic overlay. The exec calls setDep, which maintains the INVERSE on the
// other issue's row atomically server-side; that side arrives on the confirm
// refetch (same shape as delete, whose pruned references also land on refetch —
// the optimistic overlay only ever patches the row being edited).
export async function setChangeDep(id, field, dep, add, next) {
  return mutate(
    { type: 'update', id, fields: { [field]: next } },
    () => setDep(id, field, [dep], add),
  );
}

// Permanently delete an issue (the detail view's double-opt-in delete). Drops
// the Supabase row outright — there's no soft-delete column, and the rejected
// column already serves the "kept but dead" case, so delete means gone.
export async function deleteChange(id) {
  if (!id) return { error: 'delete requires an id' };
  return mutate({ type: 'delete', id }, () => remove(id));
}

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}
