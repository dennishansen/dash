// One live chat pane per SESSION, app-wide. Issue↔chat linking is many-to-many
// (one chat legitimately carries work across cards), but the chat pool in
// main.jsx is keyed by ISSUE — so a session linked to two issues would mount two
// ChatPanes, whose two WebSockets fight over the server's one-attached-socket-
// per-session rule (the visible terminal keeps losing its attachment) and whose
// two detectors clobber each other's activity reports (the flashing dot).
//
// This registry makes the SESSION the unit of mounting: every ChatEnvironment that
// wants to show a session registers interest, and exactly one — the OWNER —
// actually mounts the ChatPane (socket + detector). Ownership rules:
//   1. the ACTIVE (visible) pane always wins — opening a card takes the session
//      over from a hidden pane, so the terminal you're looking at is the one
//      attached (the loser unmounts, closing its socket; the server broadcasts
//      to every attached pane, so the handover is seamless — multi-attach means
//      nothing is ever 'superseded');
//   2. otherwise ownership is STICKY — navigating away doesn't shuffle the pane
//      between hidden hosts;
//   3. a released session (owner unmounted / switched chats / unlinked) falls to
//      the earliest remaining registrant, so a session another issue still links
//      stays mounted and its dot detection never stops.
//
// Activity fan-out is NOT handled here — the one mounted detector reports into
// activity-store keyed by session, and each card joins through its own
// conversations[] (see activity-store.issueActivity).

import { useEffect, useSyncExternalStore } from 'react';

// sessionId → Map(paneId → { active, seq }). paneId is the issue id — the pool
// mounts at most one ChatEnvironment per env, so it's unique per registrant.
const regs = new Map();
const listeners = new Set();
let seq = 0;

// sessionId → owning paneId. Recomputed on every registration change; identity
// swaps only on real difference (useSyncExternalStore caches by identity).
let owners = {};

function ownerOf(sessionId, prevOwner) {
  const panes = regs.get(sessionId);
  if (!panes || panes.size === 0) return undefined;
  // 1) An active registrant wins (two actives only exist transiently mid-commit;
  //    the later activation is the user's most recent navigation).
  let active = null;
  for (const [id, r] of panes) {
    if (r.active && (!active || r.seq > panes.get(active).seq)) active = id;
  }
  if (active) return active;
  // 2) Sticky: the current owner keeps the session while still registered.
  if (prevOwner && panes.has(prevOwner)) return prevOwner;
  // 3) Fallback: earliest registrant (first pane that asked for it).
  let first = null;
  for (const [id, r] of panes) {
    if (!first || r.seq < panes.get(first).seq) first = id;
  }
  return first;
}

function recompute() {
  const next = {};
  for (const sessionId of regs.keys()) {
    const o = ownerOf(sessionId, owners[sessionId]);
    if (o !== undefined) next[sessionId] = o;
  }
  const keys = new Set([...Object.keys(next), ...Object.keys(owners)]);
  let changed = false;
  for (const k of keys) if (next[k] !== owners[k]) { changed = true; break; }
  if (changed) {
    owners = next;
    for (const fn of listeners) fn();
  }
}

function register(sessionId, paneId, active) {
  let panes = regs.get(sessionId);
  if (!panes) { panes = new Map(); regs.set(sessionId, panes); }
  // Keep the original seq across active flips so rules 2/3 stay deterministic.
  const prev = panes.get(paneId);
  panes.set(paneId, { active, seq: prev ? prev.seq : ++seq });
  recompute();
}

function unregister(sessionId, paneId) {
  const panes = regs.get(sessionId);
  if (!panes || !panes.delete(paneId)) return;
  if (panes.size === 0) regs.delete(sessionId);
  recompute();
}

function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function getOwners() { return owners; }

// React hook: does `paneId` own `sessionId`? Registers interest for the
// lifetime of the (paneId, sessionId) pair; `active` = this pane is the visible
// one, which is what lets it take the session over. Renders before the register
// effect lands return false — the pane mounts one frame after ownership settles.
//
// Registration lifetime is keyed by the PAIR alone — an `active` flip only
// UPDATES the existing registration (register is idempotent and keeps seq).
// Folding `active` into one effect would unregister/register on every flip,
// which drops the seq and hands the session back to the earliest registrant the
// moment the owner goes inactive — exactly the navigation shuffle rule 2 exists
// to prevent.
export function useSessionOwner(paneId, sessionId, active) {
  useEffect(() => {
    if (!sessionId || !paneId) return undefined;
    return () => unregister(sessionId, paneId);
  }, [sessionId, paneId]);
  useEffect(() => {
    if (!sessionId || !paneId) return undefined;
    register(sessionId, paneId, active);
  }, [sessionId, paneId, active]);
  const snap = useSyncExternalStore(subscribe, getOwners);
  return !!sessionId && snap[sessionId] === paneId;
}

// Debug/test seam.
if (typeof window !== 'undefined') {
  window.__dashSessionPool = { getOwners };
}
