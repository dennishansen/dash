// In-browser chat-activity signal. The kanban board and the mounted chat pool
// live in the SAME browser app (both under Shell), so a chat's working/idle
// state never needs a server or DB round-trip to reach a card — it's ephemeral
// UI state that originates and is consumed in one tab. Each mounted ChatPane
// publishes its state here; the board subscribes and dots an idle chat's card
// (mounted but not actively working = "needs your input"). The STORE is
// column-agnostic — it tracks every attached chat regardless of column — but the
// board GATES the dot to the in-progress lane (see ChangesBoard: idle =
// status==='in-progress' && activity==='idle'), so an idle chat on any other
// column is tracked here yet never flagged on the card.
//
// State is keyed by issue id (a card is per-issue). An issue with several
// mounted chats reads as 'working' if ANY chat is working, else 'idle'; an issue
// with no mounted chat is absent from the map (no dot). Unmounting a chat clears
// its contribution. Nothing is persisted — a page reload starts empty, which is
// correct: "mounted" is a live-session notion, not a stored one.
//
// (Per-browser by design. If dots ever need to appear on a SECOND device, this
// is the seam to promote onto the dash server's SSE stream — publishers POST,
// the board reads an `activity` event — without touching ChatPane or the card.)

import { useSyncExternalStore } from 'react';

// sessionId → { issueId, state }. Per-session so multiple chats on one issue
// aggregate correctly and each can be cleared independently on unmount.
const sessions = new Map();
const listeners = new Set();

// issueId → 'working' | 'idle', derived from the live sessions. Recomputed on
// every change so the snapshot useSyncExternalStore reads is referentially
// stable between actual changes (required: it caches by identity).
let snapshot = {};

function recompute() {
  const next = {};
  for (const { issueId, state } of sessions.values()) {
    if (!issueId) continue;
    if (next[issueId] === 'working') continue;     // working wins over idle
    next[issueId] = state === 'working' ? 'working' : 'idle';
  }
  // Only swap identity when the derived map actually differs, so subscribers
  // don't re-render on no-op republishes (the detection loop is chatty).
  const keys = new Set([...Object.keys(next), ...Object.keys(snapshot)]);
  let changed = false;
  for (const k of keys) if (next[k] !== snapshot[k]) { changed = true; break; }
  if (changed) {
    snapshot = next;
    for (const fn of listeners) fn();
  }
}

// Publish a chat's state. state is 'working' | 'idle'.
export function reportActivity(sessionId, issueId, state) {
  sessions.set(sessionId, { issueId, state });
  recompute();
}

// Drop a chat's contribution (call on ChatPane unmount).
export function clearActivity(sessionId) {
  if (sessions.delete(sessionId)) recompute();
}

function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function getSnapshot() { return snapshot; }

// React hook: the live issueId → state map. Re-renders only when it changes.
export function useActivity() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

// Test seam: drive the store from Playwright without a real claude PTY.
if (typeof window !== 'undefined') {
  window.__dashActivity = { reportActivity, clearActivity, getSnapshot };
}
