// Client-side issues store — the single painted truth for every issues view
// (board list, issue detail), with WRITE-THROUGH mutations.
//
// Model: per key, the store holds a BASE (the last accepted fetch result) and
// an ordered journal of OVERLAYS (this client's not-yet-confirmed mutations).
// The painted value is always base + overlays, recomputed synchronously
// whenever either side changes. That makes every path deterministic without
// the network:
//   • a write paints instantly (overlay added, recompute),
//   • a failed write rolls back instantly (overlay dropped, recompute),
//   • a fetch can never resurrect pre-write state (overlays re-apply on top),
//   • a SLOW fetch can never clobber a newer one (per-key watermark: responses
//     landing out of order are dropped — fetch ordering is owned here, not by
//     whichever hook happened to fetch).
//
// Overlays retire per key once a fetch that STARTED after their write settled
// lands — from then on the server data carries the write. Writes themselves
// run through one serialized queue, so two edits to the same row commit in
// invocation order and their overlays replay in that same order — last edit
// wins on screen AND on the server.
//
// Ordering uses a Lamport-style counter (clock()) instead of wall time — every
// fetch records the tick it STARTED at, mutations record the tick they SETTLED
// at, and the two are comparable without trusting Date.now monotonicity.
//
// Keys mirror the views: 'changes' (shaped row list), `change:<id>` (one row +
// body). Header counts derive from 'changes' — no separate count key to drift.

import { emitIssuesChange } from './realtime.js';

const bases = new Map();    // key → last accepted fetch value
const baseAt = new Map();   // key → clock() the accepted fetch STARTED at
const painted = new Map();  // key → base + overlays (what views render)
const subs = new Map();     // key → Set<fn(value)>
const journal = new Map();  // key → ordered [entry]; entry = { mutation, settledAt }

let counter = 0;
export function clock() { return ++counter; }

export function read(key) { return painted.get(key); }
export function has(key) { return painted.has(key); }

// Subscribe to one key's painted value. fn fires on every recompute.
export function subscribe(key, fn) {
  if (!subs.has(key)) subs.set(key, new Set());
  subs.get(key).add(fn);
  return () => {
    const s = subs.get(key);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) subs.delete(key);
  };
}

function recompute(key) {
  if (!bases.has(key)) return; // nothing fetched yet — views still loading
  let v = bases.get(key);
  for (const e of journal.get(key) || []) v = applyMutation(v, e.mutation, key);
  painted.set(key, v);
  for (const fn of subs.get(key) || []) fn(v);
}

// Store a fetch result. `startedAt` is the clock() reading taken when the
// fetch began. Out-of-order responses (older than the accepted watermark) are
// dropped; overlays whose write settled before this fetch began retire — the
// response provably carries them.
export function storeFetch(key, value, startedAt) {
  if (startedAt < (baseAt.get(key) ?? -Infinity)) return; // stale response
  bases.set(key, value);
  baseAt.set(key, startedAt);
  const entries = journal.get(key);
  if (entries) {
    const keep = entries.filter(e => !(e.settledAt && e.settledAt <= startedAt));
    if (keep.length) journal.set(key, keep); else journal.delete(key);
  }
  recompute(key);
}

// Mutations — the four write shapes the dash performs:
//   { type: 'insert', row, ids? }          new shaped row; ids = column order to rank
//   { type: 'update', id, fields }         merge shaped fields into one row
//   { type: 'delete', id }                 drop the row
//   { type: 'rerank', ids, status? }       ids = final order (rank 0..n); status
//                                          stamps every id (cross-column move)
function affectedKeys(m) {
  switch (m.type) {
    case 'insert': return ['changes'];
    case 'update': return ['changes', `change:${m.id}`];
    // delete deliberately does NOT patch the detail key: the deleter is
    // navigating away in the same event, and nulling their still-mounted view
    // paints a "not found" flash before the (transition-priority) navigation
    // commits. A REMOTE delete still nulls the detail through its refetch.
    case 'delete': return ['changes'];
    case 'rerank': return ['changes', ...m.ids.map(id => `change:${id}`)];
    default: return [];
  }
}

// Status-transition extras, mirroring the server's closed_at trigger exactly:
// stamp on the transition INTO done/rejected, clear on leaving, untouched
// within the same column.
const ARCHIVE = new Set(['done', 'rejected']);
const statusPatch = (row, status) => (
  status === row.status ? { status }
    : ARCHIVE.has(status) ? { status, closed: new Date().toISOString() }
      : { status, closed: null }
);

const rankPatch = (row, ids, status) => {
  const i = ids.indexOf(row.id);
  if (i < 0) return row;
  return { ...row, ...(status ? statusPatch(row, status) : {}), order: i };
};

// Pure: one mutation applied to one key's value. Exported for unit tests.
export function applyMutation(value, m, key) {
  if (value == null) return value;
  if (key === 'changes') {
    switch (m.type) {
      case 'insert': {
        const rows = [...value.filter(r => r.id !== m.row.id), m.row];
        return m.ids ? rows.map(r => rankPatch(r, m.ids)) : rows;
      }
      case 'update': return value.map(r => (r.id === m.id
        ? { ...r, ...m.fields, ...(m.fields.status ? statusPatch(r, m.fields.status) : {}) }
        : r));
      case 'delete': return value.filter(r => r.id !== m.id);
      case 'rerank': return value.map(r => rankPatch(r, m.ids, m.status));
      default: return value;
    }
  }
  if (key.startsWith('change:')) {
    const id = key.slice('change:'.length);
    if (m.type === 'update' && m.id === id) {
      return { ...value, ...m.fields, ...(m.fields.status ? statusPatch(value, m.fields.status) : {}) };
    }
    if (m.type === 'rerank') return rankPatch(value, m.ids, m.status);
    return value;
  }
  return value;
}

// One queue for every write: conflicting mutations commit server-side in
// invocation order, matching the order their overlays replay in. Writes are
// rare (human-paced), so global serialization costs nothing and removes the
// whole class of A-then-B-paints-A inversions.
let writeChain = Promise.resolve();

// Apply a mutation optimistically, run the write (serialized), confirm or roll
// back. Returns exec's result ({ ok } | { error }) — callers keep banner logic.
export async function mutate(mutation, exec) {
  // Journal only keys someone is painting or watching — an uncached, orphan
  // detail key would otherwise accumulate entries until an unlikely fetch.
  const keys = affectedKeys(mutation).filter(k => bases.has(k) || subs.has(k));
  const entry = { mutation, settledAt: null };
  for (const k of keys) {
    if (!journal.has(k)) journal.set(k, []);
    journal.get(k).push(entry);
    recompute(k);
  }
  const drop = () => {
    for (const k of keys) {
      const left = (journal.get(k) || []).filter(e => e !== entry);
      if (left.length) journal.set(k, left); else journal.delete(k);
      recompute(k); // synchronous rollback — no network needed to un-paint
    }
  };
  const run = writeChain.then(async () => {
    try { return await exec(); }
    catch (e) { return { error: String(e?.message || e) }; }
  });
  writeChain = run.then(() => {}); // chain regardless of outcome
  const result = await run;
  if (result && result.error) {
    drop();
    // Refetch for server truth too — a PARTIAL write (e.g. insert committed,
    // ranking failed) leaves the server holding state the base doesn't.
    emitIssuesChange('ROLLBACK', null);
    return result;
  }
  entry.settledAt = clock();
  // Confirm refetch for this client (trailing-edge coalesced in useIssues);
  // other clients hear the write over Realtime.
  emitIssuesChange(mutation.type.toUpperCase(), { id: mutation.id ?? mutation.row?.id ?? null });
  return result;
}
