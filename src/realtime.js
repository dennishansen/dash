// Browser-side Supabase Realtime subscription — the kanban's instant-refresh
// path, LOCAL and REMOTE alike.
//
// The board already reads its DATA directly from Supabase in the browser
// (board-store.js), so there's no reason its REALTIME should detour through a
// server. This subscribes to `public.issues` postgres changes directly over a
// websocket, the same way the board reads rows directly over REST — one path
// that works identically on localhost and on a static Vercel deploy where there
// is NO /api/dash server to relay from. It replaces the old local-only SSE
// relay (the deleted issues-realtime.mjs + /api/dash/changes/stream).
//
// ONE socket per tab, fanned out. The board stays mounted across routes and the
// detail view mounts on top of it, so naively each `subscribeIssues` caller
// would open its own websocket. Instead they share a single ref-counted
// connection (mirroring the node relay's process-wide singleton): the first
// subscriber opens it, the last to leave closes it, and every postgres change
// fans out to all listeners.
//
// Protocol: Supabase Realtime speaks Phoenix channels over a websocket. We
// hand-roll the join + heartbeat (vsn 1.0.0 object frames) on the browser's
// native WebSocket — no @supabase/* client, matching the dependency-free house
// style of issues-store/auth.
//
// Auth is the whole point of doing this client-side: the socket authenticates
// with the SIGNED-IN USER's JWT (auth.js), never the bare anon key. Realtime
// evaluates the `issues` RLS policy for postgres_changes against that token, so
// an allow-listed user receives every insert/update/delete while a signed-out
// anon socket receives nothing — exactly the gate the REST path already enforces.
// Locally the dev session's token IS the service key (bypasses RLS), so it
// likewise receives everything. Signed out ⇒ no token ⇒ no socket (the board
// shows the sign-in gate anyway).

import { URL as SUPA_URL, ANON } from '../server/supabase.mjs';
import { TABLE } from '../server/issues-store.mjs';
import { currentSession, onAuth } from './auth.js';

const TOPIC = 'realtime:issues';
const HEARTBEAT_MS = 30000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

// Decode one Realtime frame into a normalized verdict. Pure + exported so frame
// handling is unit-testable without a live socket (see realtime.test.mjs).
// Returns one of:
//   { kind: 'change', event, record }  — a postgres INSERT/UPDATE/DELETE
//   { kind: 'joined' }                 — phx_join acknowledged ok
//   { kind: 'error', detail }          — join/channel error
//   { kind: 'other' }                  — heartbeat reply, presence, system, etc.
export function decodeFrame(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return { kind: 'other' }; }
  const { topic, event, payload } = msg || {};
  if (event === 'postgres_changes') {
    const data = payload?.data || {};
    return { kind: 'change', event: data.type || 'UPDATE', record: data.record || data.old_record || null };
  }
  // phx_reply on the channel topic is the join ack; on the `phoenix` topic it's
  // just a heartbeat echo — keep those out of the `joined` path (topic-scoped).
  if (event === 'phx_reply' && topic === TOPIC) {
    if (payload?.status === 'ok') return { kind: 'joined' };
    return { kind: 'error', detail: payload?.response || 'phx_reply error' };
  }
  if (event === 'phx_error') return { kind: 'error', detail: payload || 'phx_error' };
  return { kind: 'other' };
}

// The websocket URL. apikey is always ANON — it only IDENTIFIES the project; the
// per-user identity rides in the join frame's access_token.
export function buildSocketUrl() {
  return `${SUPA_URL.replace(/^http/, 'ws')}/realtime/v1/websocket`
    + `?apikey=${encodeURIComponent(ANON)}&vsn=1.0.0`;
}

// The phx_join frame that subscribes to every change on public.issues, carrying
// the user's JWT as access_token so Realtime evaluates RLS against it.
export function buildJoinFrame(ref, token) {
  return JSON.stringify({
    topic: TOPIC,
    event: 'phx_join',
    payload: {
      config: { postgres_changes: [{ event: '*', schema: 'public', table: TABLE }] },
      access_token: token,
    },
    ref: String(ref),
  });
}

// Every current subscriber. Module-level (not per-connection) because change
// signals have more than one source: socket frames AND this client's own writes
// (emitIssuesChange) — a local write must reach the views even while the socket
// is down, reconnecting, or rejected.
const listeners = new Set();

// Local write echo. board-store calls this after every successful browser-side
// write, so the writer's own views refetch deterministically instead of waiting
// on the write's realtime echo (which never arrives over a dead socket). The
// socket path covers OTHER clients; this covers the one that typed.
export function emitIssuesChange(event, record = null) {
  for (const fn of listeners) fn({ event, record });
}

// The one shared connection. Null when no one is subscribed.
let conn = null;

function createConnection() {
  let ws = null;
  let ref = 0;
  let heartbeat = null;
  let reconnectMs = RECONNECT_MIN_MS;
  let reconnectTimer = null;
  let stopped = false;
  let token = currentSession()?.access_token || null;

  function clearTimers() {
    clearInterval(heartbeat); heartbeat = null;
    clearTimeout(reconnectTimer); reconnectTimer = null;
  }

  function dropSocket() {
    if (ws) {
      // Drop handlers first so the close we trigger doesn't schedule a reconnect.
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(); } catch {}
      ws = null;
    }
  }

  function teardown() {
    clearTimers();
    dropSocket();
  }

  function connect() {
    if (stopped || !token) return;
    teardown();
    ws = new WebSocket(buildSocketUrl());

    ws.onopen = () => {
      ws.send(buildJoinFrame(++ref, token));
      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++ref) }));
        }
      }, HEARTBEAT_MS);
    };

    ws.onmessage = (e) => {
      const v = decodeFrame(typeof e.data === 'string' ? e.data : '');
      if (v.kind === 'joined') {
        // Backoff resets on a SUCCESSFUL channel join, not on raw socket open —
        // a TCP connection that accepts then drops (or whose join is rejected)
        // must not look healthy and reset the backoff to 1s.
        reconnectMs = RECONNECT_MIN_MS;
        // Changes that happened while disconnected were never delivered, so a
        // (re)join is itself a change signal: everyone refetches to resync.
        emitIssuesChange('RESYNC');
      } else if (v.kind === 'change') {
        for (const fn of listeners) fn({ event: v.event, record: v.record });
      } else if (v.kind === 'error') {
        // Joined-but-unsubscribed is a dead socket: force a reconnect (with the
        // current, un-reset backoff) rather than sit open receiving nothing.
        scheduleReconnect();
      }
    };

    ws.onclose = scheduleReconnect;
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  function scheduleReconnect() {
    clearTimers();
    dropSocket();
    if (stopped || !token) return;
    reconnectTimer = setTimeout(connect, reconnectMs);
    reconnectMs = Math.min(reconnectMs * 2, RECONNECT_MAX_MS);
  }

  // Reconnect with the new token on any auth change; tear down on sign-out.
  // onAuth fires once immediately with the current session — that first call is
  // what opens the socket (no separate initial connect()).
  const offAuth = onAuth((s) => {
    const next = s?.access_token || null;
    if (next === token && ws) return; // unchanged, already live
    token = next;
    if (token) connect();
    else teardown();
  });

  return {
    add(fn) { listeners.add(fn); },
    remove(fn) {
      listeners.delete(fn);
      if (listeners.size === 0) { stopped = true; offAuth(); teardown(); conn = null; }
    },
  };
}

// Subscribe to live issues changes. `onChange({ event, record })` runs for every
// postgres mutation, over a socket shared with all other subscribers. Returns an
// unsubscribe function; the socket closes when the last subscriber leaves.
export function subscribeIssues(onChange) {
  if (!conn) conn = createConnection();
  const c = conn;
  c.add(onChange);
  return function unsubscribe() { c.remove(onChange); };
}
