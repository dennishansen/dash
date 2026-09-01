// Dash issues — shape Supabase `issues` rows for the kanban.
//
// Single source of truth: the Supabase `issues` table (see issues-store.mjs).
// Each row holds content (title, body, tags, sessions, commits) AND its
// board slice (status column, rank, owner). There is no markdown registry — the
// table is the registry of which issues exist, shared live across machines.
//
// This module is the view layer: it fetches rows from the store and shapes them
// for the board. Pure Supabase reads — no git. (Issues are listed by their
// stored status, so the board never has to scan branches; the synchronous git
// that used to run here on every poll was the dash terminal-freeze root cause.)
// All functions are async.

import {
  listAll, get, placeCards, update, setDep,
} from './issues-store.mjs';
import { shapeRow } from './issues-shape.mjs';

// Every issue, shaped for the board, newest first. Status (the column) comes
// straight from the stored row — no git, no branch scan.
export async function listIssues() {
  const rows = await listAll();
  const items = rows.map(r => shapeRow(r));
  items.sort((a, b) => {
    return (b.created || '').localeCompare(a.created || '');
  });
  return items;
}

// Move cards to a slot: `ids` land in the `status` column right after `after`
// (null = top), and that column renumbers 0..n. Covers both board gestures —
// a within-column reorder is just a move whose status is the column it's
// already in. See issues-store.placeCards for why only the moved ids and the
// anchor travel.
export async function placeChange(ids, status, after) {
  return placeCards(ids, status, after ?? null);
}

// Inline rename from a kanban card. Title only — status/rank/body untouched.
export async function renameChange(id, title) {
  const t = (title || '').trim();
  if (!id || !t) return { error: 'rename requires id and non-empty title' };
  await update(id, { title: t });
  return { ok: true, id, title: t };
}

// Add or remove one dependency edge on an issue (the AI/API editing surface,
// twin of board.mjs' requires/unlocks verbs). `field` is 'requires' | 'unlocks';
// setDep maintains the inverse atomically. `add` false removes.
export async function changeDep(id, field, dep, add) {
  if (!id || !field || !dep) return { error: 'dep requires id, field, and dep' };
  return setDep(id, field, [dep], !!add);
}

// Every issue IS a change. The board lists what's in the issues table by status;
// it no longer scans git for orphan branches (work in flight gets an issue card
// at create / kick-off time, so it's never invisible without one).
export async function listChanges() {
  return listIssues();
}

// One issue with its body.
export async function issueDetail(id) {
  const row = await get(id);
  if (!row) return null;
  return { ...shapeRow(row), body: row.body || '' };
}
