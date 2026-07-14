// In-browser chat-activity signal. The kanban board and the mounted chat pool
// live in the SAME browser app (both under Shell), so a chat's working/idle
// state never needs a server or DB round-trip to reach a card — it's ephemeral
// UI state that originates and is consumed in one tab. Each mounted ChatPane
// publishes its state here; the board subscribes and dots an idle chat's card
// (mounted but not actively working = "needs your input"). The STORE is
// column-agnostic — it tracks every attached chat regardless of column — but the
// board GATES the dot to the in-progress lane (see ChangesBoard: idle =
// status==='in-progress' && issueActivity(...)==='idle'), so an idle chat on any
// other column is tracked here yet never flagged on the card.
//
// State is keyed by the canonical conversations[] HANDLE — a legacy Claude chat
// is its bare UUID; other agents are `<agent>:<uuid>`. The chat is the thing that
// works or idles, and issue↔chat linking is many-to-many (one chat can carry
// several cards). Each card joins its conversations[] directly against this map,
// so ONE mounted detector fans out to every linked issue without losing agent
// identity. An unmounted chat is absent (no dot).
// Live activity is ephemeral; only a user's dismissal of the current idle
// episode persists across reloads, until that chat starts working again.
//
// (Per-browser by design. If dots ever need to appear on a SECOND device, this
// is the seam to promote onto the dash server's SSE stream — publishers POST,
// the board reads an `activity` event — without touching ChatPane or the card.)

import { useSyncExternalStore } from 'react';

// conversations[] handle → 'working' | 'idle'.
const chats = new Map();
// Chats whose CURRENT idle episode the user has dismissed ("I've seen it").
// A dismissed idle session stops flagging until it works again — the next
// 'working' report clears the dismissal, so when it idles anew the dot returns.
// The dismissal is per-idle-episode, not permanent: sending the chat the input
// it was waiting on makes it work, which naturally un-dismisses.
// Dismissal is a USER INTENT, not a live-session fact, so — unlike `chats`
// (which is correctly ephemeral) — it PERSISTS across reloads: dismissing the
// dot then refreshing keeps it dismissed until the chat next works. Hydrated
// from localStorage on load; every add/remove writes back.
const DISMISS_KEY = 'dash-dismissed-idle';
function loadDismissed() {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]')); }
  catch { return new Set(); }
}
function persistDismissed() {
  try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...dismissed])); } catch { /* private mode / node */ }
}
const dismissed = typeof localStorage !== 'undefined' ? loadDismissed() : new Set();
const listeners = new Set();

// The snapshot useSyncExternalStore reads — rebuilt only on real change so it
// stays referentially stable between changes (required: it caches by identity).
let snapshot = {};

function recompute() {
  // A dismissed idle session surfaces as 'idle-dismissed' in the snapshot so the
  // derivation can tell "idle but acknowledged" from "idle, needs a dot" — and so
  // dismissing/undismissing is a real snapshot change that wakes subscribers.
  const next = {};
  for (const [handle, state] of chats) {
    next[handle] = state === 'idle' && dismissed.has(handle) ? 'idle-dismissed' : state;
  }
  const keys = new Set([...Object.keys(next), ...Object.keys(snapshot)]);
  let changed = false;
  for (const k of keys) if (next[k] !== snapshot[k]) { changed = true; break; }
  if (changed) {
    snapshot = next;
    for (const fn of listeners) fn();
  }
}

// Publish a chat's state. state is 'working' | 'idle'. A fresh work cycle
// ('working') clears any dismissal, so the next idle flags again.
export function reportActivity(handle, state) {
  chats.set(handle, state);
  if (state === 'working' && dismissed.delete(handle)) persistDismissed();
  recompute();
}

// Dismiss a chat's current idle episode — hide its dot until it works again.
export function dismissIdle(handle) {
  if (chats.get(handle) === 'idle' && !dismissed.has(handle)) {
    dismissed.add(handle);
    persistDismissed();
    recompute();
  }
}

// Drop a chat's LIVE contribution (call on ChatPane unmount). The dismissal is
// deliberately left intact — it's a persisted user intent, not live state, so an
// unmount/remount (or a reload) keeps the dot suppressed until the chat works.
export function clearActivity(handle) {
  if (chats.delete(handle)) recompute();
}

function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function getSnapshot() { return snapshot; }

// React hook: the live conversations[] handle → state map. Re-renders only when it changes.
export function useActivity() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

// An issue's derived state: join its conversations[] against the chat map.
// 'working' if ANY linked chat is working (working wins), else 'idle' if any
// linked chat is mounted, else undefined (no mounted chat → no dot).
export function issueActivity(activity, conversations) {
  let state;
  for (const handle of conversations || []) {
    const s = activity[handle];
    if (s === 'working') return 'working';
    if (s === 'idle') state = 'idle';               // a live idle wins → dot shows
    else if (s && state !== 'idle') state = s;      // 'idle-dismissed' → mounted, no dot
  }
  return state;
}

// Dismiss every idle chat backing this issue — the detail's dot X. Only genuine
// idle chats are dismissed; ones already dismissed or working are untouched.
export function dismissIssueIdle(activity, conversations) {
  for (const handle of conversations || []) {
    if (activity[handle] === 'idle') dismissIdle(handle);
  }
}

// Test seam: drive the store from Playwright without a real claude PTY.
if (typeof window !== 'undefined') {
  window.__dashActivity = { reportActivity, clearActivity, dismissIdle, getSnapshot };
}
