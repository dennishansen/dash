// What every live chat on this machine is doing — read from the SUPERVISOR,
// rendered by every client.
//
// This used to be an in-browser signal: whichever pane owned a chat sampled its
// terminal and published here. That made the dot a function of UI lifecycle —
// mount, unmount, ownership handoff each restarted a detector, so a freshly
// loaded board blinked through unknown states, and two viewers of the same
// board could disagree about the same chat. The supervisor owns the PTYs and
// already reads every byte they emit, so it now runs the detection once
// (server/chat-activity.mjs) and publishes it; this module is a subscriber, and
// the board and the detail render what the server says.
//
// State arrives keyed by the chat's bare SESSION UUID — the one name a chat has
// on the client, shared with the live-terminal map and the issue's
// `selected_session`. The agent/role tokens in a conversations[] handle
// (`codex:<uuid>`, `reviewer:codex:<uuid>`) are SERVER routing metadata — which
// CLI resumes the chat, in what role — and carry no identity.
// The chat is the thing that works or idles, and issue↔chat linking is
// many-to-many (one chat can carry several cards). A card reads the state of the
// ONE chat it has SELECTED, so a second work chat or a reviewer never speaks for
// it and every surface showing that issue agrees. A chat with no live PTY is
// absent (no dot).
//
// WHEN THE SERVER CANNOT ANSWER there is deliberately no client-side detector to
// fall back to — a second detector is the very thing this move removed. A board
// with no local dash (the Vercel deploy) never gets an answer and shows no
// dots, which is correct there: no PTYs exist to need input. A dropped or
// refused stream keeps the last snapshot (the PTYs did not change because our
// socket did) and is reopened on a backoff until it answers, re-syncing with a
// fresh full snapshot; a cold load during an outage shows no dots until the
// supervisor answers — and SAYS so when the reason is a supervisor too old to
// have this route (see the reconnect loop, and control-plane.js).

import { useSyncExternalStore } from 'react';
import { reportRoute } from './control-plane.js';

// session uuid → { state: 'working' | 'idle', since: <ms> } as last published.
const chats = new Map();
// Chats whose CURRENT idle episode the user has dismissed ("I've seen it"),
// stored as session → the `since` stamp of the episode dismissed.
//
// Dismissal is a USER INTENT, not a live-session fact, so — unlike `chats`,
// which is server truth — it lives here and PERSISTS across reloads. Keying it
// to the EPISODE rather than the session is what makes it honest without a
// witness: the server stamps a new `since` the moment the chat works again, so
// a dismissal expires by itself even if every tab was closed while it happened.
// (The old store could only expire a dismissal by OBSERVING a 'working' report,
// so a chat that worked and re-idled behind your back stayed silently dismissed.)
const DISMISS_KEY = 'dash-dismissed-idle';
function loadDismissed() {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISS_KEY) || '{}');
    // The pre-server shape was an array of session ids with no episode stamp.
    // There is nothing to migrate it to — an unstamped dismissal cannot be told
    // from a stale one — so it lapses, costing at most one dot's reappearance.
    return raw && !Array.isArray(raw) && typeof raw === 'object' ? new Map(Object.entries(raw)) : new Map();
  } catch { return new Map(); }
}
function persistDismissed() {
  try { localStorage.setItem(DISMISS_KEY, JSON.stringify(Object.fromEntries(dismissed))); } catch { /* private mode / node */ }
}
const dismissed = typeof localStorage !== 'undefined' ? loadDismissed() : new Map();
const listeners = new Set();

// The snapshot useSyncExternalStore reads — rebuilt only on real change so it
// stays referentially stable between changes (required: it caches by identity).
let snapshot = {};

function recompute() {
  // A dismissed idle session surfaces as 'idle-dismissed' so the derivation can
  // tell "idle but acknowledged" from "idle, needs a dot" — and so dismissing is
  // a real snapshot change that wakes subscribers.
  const next = {};
  for (const [session, { state, since }] of chats) {
    next[session] = state === 'idle' && dismissed.get(session) === since ? 'idle-dismissed' : state;
  }
  const keys = new Set([...Object.keys(next), ...Object.keys(snapshot)]);
  let changed = false;
  for (const k of keys) if (next[k] !== snapshot[k]) { changed = true; break; }
  if (changed) {
    snapshot = next;
    for (const fn of listeners) fn();
  }
}

// The last few hundred frames this client applied, with arrival times. A dot
// that disagrees with the server is either a frame that never came or a frame
// that came and was wrong, and only a record of what ARRIVED can tell those
// apart — the store is otherwise a pure function of frames nobody kept.
const journal = [];
const JOURNAL_MAX = 300;

// Apply one server frame: a full `snapshot` (on connect and every reconnect) or
// a single-session `update` (state null = the chat ended).
export function applyFrame(frame) {
  if (!frame) return;
  journal.push({ t: Date.now(), frame });
  if (journal.length > JOURNAL_MAX) journal.shift();
  if (frame.type === 'snapshot') {
    chats.clear();
    for (const [session, v] of Object.entries(frame.sessions || {})) chats.set(session, v);
    // A dismissal for an episode the server no longer reports can never match
    // again — prune it here rather than let localStorage grow forever. Only a
    // full snapshot may prune: it is the only frame that knows the whole truth.
    let pruned = false;
    for (const session of [...dismissed.keys()]) {
      if (dismissed.get(session) !== chats.get(session)?.since) { dismissed.delete(session); pruned = true; }
    }
    if (pruned) persistDismissed();
  } else if (frame.state) {
    chats.set(frame.session, { state: frame.state, since: frame.since });
  } else {
    chats.delete(frame.session);
  }
  recompute();
}

// Dismiss a chat's current idle episode — hide its dot until it works again.
export function dismissIdle(session) {
  const cur = chats.get(session);
  if (cur?.state === 'idle' && dismissed.get(session) !== cur.since) {
    dismissed.set(session, cur.since);
    persistDismissed();
    recompute();
  }
}

// ONE stream per tab, opened on first read and never closed. There is no
// ref-counting to do: the board mounts at app start and stays mounted, so a
// count would only ever oscillate around one — and a close/reopen would cost a
// re-snapshot, which is the flash this whole change exists to remove.
//
// RECONNECTION IS OURS, not EventSource's. Its built-in retry only covers a
// dropped connection; a response it refuses — a 503 from a supervisor still
// booting, a 401 from an exposed edge before the token cookie lands, the HTML
// 404 a board-only deployment answers with — fails the connection for good.
// Every one of those is recoverable except the last, and none of them is worth
// a dash that shows no dots until somebody reloads the page. So the socket is
// reopened on a backoff that never gives up (same shape as the Realtime socket
// in realtime.js): on an origin with no dash that costs one request a minute
// and nothing else, and on an origin with one it heals by itself.
//
// RETRYING FOREVER IS RIGHT; DOING IT SILENTLY WAS NOT. EventSource reports a
// failure but never its STATUS, so every one of those causes arrived here as
// the same undifferentiated error and the board went on painting no dots —
// which is also exactly what it paints when no chat needs input. That is how a
// supervisor running a build from before this route existed cost every board on
// the machine its dots for a day with nothing anywhere saying why
// (i-needs-input-indicator-gone). So a failed connection is now DIAGNOSED: one
// plain GET of the same route, whose status separates "this build has no such
// route" from every recoverable thing. Only a 404 is definitive; the reconnect
// loop is unchanged, and answering again clears the notice with no reload.
const ROUTE = '/api/dash/terminal/activity';
const POWERS = 'needs-input dots';
async function diagnose() {
  let status;
  try { status = (await fetch(ROUTE, { headers: { accept: 'application/json' } })).status; }
  catch { return; } // the network, not the build — says nothing about either
  if (status === 404) reportRoute(ROUTE, false, POWERS);
  else if (status >= 200 && status < 300) reportRoute(ROUTE, true);
  // 401, 429, 503 — a supervisor that HAS the route and is having a moment.
}

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 60000;
let started = false;
let settle;
// Resolves once the server has spoken for the first time. Tests wait on it
// before injecting frames of their own, so a late-arriving first snapshot
// can't wipe what they just set up.
const spoken = new Promise((r) => { settle = r; });
function ensureStream() {
  if (started || typeof window === 'undefined' || typeof EventSource === 'undefined') return spoken;
  started = true;
  let delay = RECONNECT_MIN_MS;
  const connect = () => {
    const es = new EventSource('/api/dash/terminal/activity/stream');
    const reopen = () => {
      try { es.close(); } catch { /* already closed */ }
      diagnose();
      setTimeout(connect, delay);
      delay = Math.min(RECONNECT_MAX_MS, delay * 2);
    };
    es.addEventListener('snapshot', (e) => {
      delay = RECONNECT_MIN_MS; // a stream that answered is a healthy one
      reportRoute(ROUTE, true); // …and the route it answered on is not missing
      try { applyFrame({ type: 'snapshot', sessions: JSON.parse(e.data) }); } catch { /* malformed frame */ }
      settle(true);
    });
    es.addEventListener('update', (e) => {
      try { applyFrame(JSON.parse(e.data)); } catch { /* malformed frame */ }
    });
    es.onerror = () => {
      // CONNECTING means EventSource is already retrying this one itself; only
      // a CLOSED socket is ours to reopen.
      if (es.readyState === 2 /* CLOSED */) reopen();
    };
  };
  connect();
  return spoken;
}

function subscribe(fn) { ensureStream(); listeners.add(fn); return () => listeners.delete(fn); }
function getSnapshot() { return snapshot; }

// The derived map, without a React tree — for the pure derivation tests.
export function getSnapshotForTest() { return snapshot; }

// React hook: the live session uuid → state map. Re-renders only when it changes.
export function useActivity() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

// An issue's state is the state of the ONE chat it has selected — the chat you'd
// resume if you opened the card. Not a fold over every linked chat: an issue can
// carry several (a second work chat, a reviewer), and those must never speak for
// the card, or the board and the detail can disagree about the same issue.
// Undefined when nothing is selected or that chat has no live PTY → no dot.
export function issueActivity(activity, issue) {
  const session = selectedChat(issue);
  return session ? activity[session] : undefined;
}

// Dismiss this issue's idle episode — the detail's dot X. Only the selected chat
// can be flagged, so only it can be dismissed.
export function dismissIssueIdle(activity, issue) {
  const session = selectedChat(issue);
  if (session && activity[session] === 'idle') dismissIdle(session);
}

// The one chat a card speaks for, from its issue row.
function selectedChat(issue) {
  return issue?.selected_session || null;
}

// Test seam: drive the store with server-shaped frames, without a PTY.
// `ready()` waits out the first server snapshot — inject after it, or the
// snapshot lands on top of you.
if (typeof window !== 'undefined') {
  window.__dashActivity = { applyFrame, dismissIdle, getSnapshot, ready: ensureStream, frames: () => journal };
}
