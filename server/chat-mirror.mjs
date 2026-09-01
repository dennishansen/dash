// The mirrored chat corpus — every chat's spoken turns, readable by the whole
// team from any machine (i-chat-sync).
//
// A chat's transcript lives on the machine that produced it and always will:
// that is where the agent runs. What this store holds is a COPY of the record —
// two tables, `dash_chats` (what a chat is) and `dash_chat_turns` (what was
// said) — pushed up by the owner's own dash and read by everyone. Nobody ever
// connects to anybody's machine.
//
// The push is one-directional and the tables carry no write policy for a signed-
// in reader (see the migration), so "read-only for non-owners" is structural
// rather than a rule the UI remembers to follow.
//
// Isomorphic, exactly like issues-store: node writes through it (the mirror
// sweep, under the service key) and the BROWSER reads through it (the transcript
// pane, ⌘K search) — which is what lets a teammate read a chat from a deploy
// with no local dash at all. `process` doesn't exist in the browser, so env is
// read through a guarded shim.

import { rest, restUrl, RPC } from './supabase.mjs';
import { RUN_ID, queryFor, rowFor, rowsFor } from './run-scope.mjs';

const ENV = (typeof process !== 'undefined' && process.env) || {};

// WHICH corpus this store reads/writes — the isolation axis, same seam as
// DASH_ISSUES_TABLE. Production is `dash_chats`; the dash test harness
// selects the clone so fixture transcripts never turn up in a real search.
export const CHATS_TABLE = ENV.DASH_CHATS_TABLE
  || (typeof __DASH_CHATS_TABLE__ !== 'undefined' ? __DASH_CHATS_TABLE__ : null)
  || 'dash_chats';
queryFor(CHATS_TABLE); // retired shared clones and unowned run stores fail here
if (!['dash_chats', 'dash_test_chats'].includes(CHATS_TABLE)) {
  throw new Error(`chat-mirror: unsupported corpus table "${CHATS_TABLE}"`);
}

// The turns table and the search function are named FROM the chats table rather
// than configured separately: they are one corpus, and three independent
// settings is three ways for a test run to write half its data into production.
const RUN_SCOPED = CHATS_TABLE === 'dash_test_chats';
export const TURNS_TABLE = RUN_SCOPED ? 'dash_test_chat_turns' : 'dash_chat_turns';
export const SEARCH_FN = RUN_SCOPED ? 'dash_test_search_chats' : 'dash_search_chats';

const CHATS = restUrl(CHATS_TABLE);
const TURNS = restUrl(TURNS_TABLE);
const enc = encodeURIComponent;

const CHAT_COLS = 'session_id,env,agent,owner,host,title,cursor,turns,first_turn_at,last_turn_at,updated_at,created_at';

// --- read --------------------------------------------------------------------

// Every mirrored chat for one environment (an issue id, or 'main'), most
// recently active first. This is the READABLE chat list, as distinct from the
// runnable one the local dash reports: a chat appears here whether or not the
// machine asking has ever seen it.
export async function mirroredChats(env) {
  if (!env) return [];
  return (await rest(CHATS, 'GET',
    queryFor(CHATS_TABLE, `env=eq.${enc(env)}&select=${CHAT_COLS}&order=last_turn_at.desc.nullslast`))) || [];
}

// One mirrored chat's header, or null.
export async function mirroredChat(sessionId) {
  if (!sessionId) return null;
  const rows = await rest(CHATS, 'GET',
    queryFor(CHATS_TABLE, `session_id=eq.${enc(sessionId)}&select=${CHAT_COLS}&limit=1`));
  return (rows && rows[0]) || null;
}

// A mirrored chat's spoken turns in order. `after` is a previous read's last
// idx — pass it to fetch only what has arrived since, which is what makes a live
// chat readable as it grows instead of refetched whole.
export async function mirroredTurns(sessionId, after = -1) {
  if (!sessionId) return [];
  const gt = Number.isFinite(after) ? `&idx=gt.${Math.floor(after)}` : '';
  return (await rest(TURNS, 'GET', queryFor(TURNS_TABLE,
    `session_id=eq.${enc(sessionId)}${gt}&select=idx,role,text,ts&order=idx.asc`))) || [];
}

// Search every mirrored turn on the team. Returns matching turns with the chat
// and environment each came from, newest first. Runs as a database function
// because a useful result is a turn PLUS its context, and because the corpus
// must never be shipped to the browser to be filtered there.
//
// Under two characters this returns nothing rather than everything: a one-letter
// substring matches most of the corpus, which is a slow way to say "no".
export async function searchChats(query, limit = 40) {
  const q = (query || '').trim();
  if (q.length < 2) return [];
  const body = RUN_SCOPED ? { p_run_id: RUN_ID, q, lim: limit } : { q, lim: limit };
  return (await rest(`${RPC}/${SEARCH_FN}`, 'POST', '', body)) || [];
}

// --- write (the owner's machine only) ---------------------------------------

// Record what a chat IS, or update it. Called by the mirror sweep before it
// pushes turns, so a chat is listable the moment it is known — even one that has
// not said anything yet. Merge-on-conflict rather than insert-or-update-branch:
// the sweep is idempotent by design and re-running it must be a no-op.
export async function upsertChat(chat) {
  const row = {
    session_id: chat.sessionId,
    env: chat.env,
    agent: chat.agent,
    owner: chat.owner ?? null,
    host: chat.host ?? null,
    title: chat.title ?? null,
  };
  const conflict = RUN_SCOPED ? 'run_id,session_id' : 'session_id';
  await rest(CHATS, 'POST', `?on_conflict=${conflict}`, [rowFor(CHATS_TABLE, row)],
    'resolution=merge-duplicates,return=minimal');
  return row;
}

// Register a chat's EXISTENCE the moment it is created, so the corpus — the one
// source every dropdown derives from — lists it immediately and realtime pushes
// it to every open board, rather than waiting a sweep interval. Insert-or-
// ignore, never merge: creation knows less than the sweep or a rename does
// (no title, no turn counts), so an existing row must never be stomped by it.
export async function registerChat(chat) {
  const conflict = RUN_SCOPED ? 'run_id,session_id' : 'session_id';
  await rest(CHATS, 'POST', `?on_conflict=${conflict}`, [rowFor(CHATS_TABLE, {
    session_id: chat.sessionId,
    env: chat.env,
    agent: chat.agent,
    owner: chat.owner ?? null,
    host: chat.host ?? null,
  })], 'resolution=ignore-duplicates,return=minimal');
}

// Append turns and advance the chat's cursor, as one push.
//
// Turn rows are keyed by (session_id, idx) where idx is the turn's position in
// the SOURCE transcript, so this is idempotent: a push replayed from a stale
// cursor rewrites identical rows instead of duplicating them. That is why a
// failed push needs no repair — the next sweep simply pushes again.
//
// The cursor is advanced ONLY after the turns land. A crash between the two
// leaves the cursor behind reality, which costs one re-read; the reverse order
// would lose turns permanently.
export async function pushTurns(sessionId, turns, { cursor } = {}) {
  if (turns.length) {
    const rows = turns.map(t => ({
      session_id: sessionId,
      idx: t.i,
      role: t.role,
      text: t.text,
      ts: t.timestamp || null,
    }));
    const conflict = RUN_SCOPED ? 'run_id,session_id,idx' : 'session_id,idx';
    await rest(TURNS, 'POST', `?on_conflict=${conflict}`, rowsFor(TURNS_TABLE, rows),
      'resolution=merge-duplicates,return=minimal');
  }
  // Counts and timestamps are derived from the turns table rather than tracked
  // by the pusher: a number the pusher increments drifts the first time a push
  // is replayed, and this cannot. Read as rows, not as a SQL aggregate — this
  // project has PostgREST aggregates disabled (PGRST123) — so it is one request
  // returning two small columns per turn, which stays cheaper than the two
  // extra round-trips a min/max-by-ordering would cost.
  const stats = await rest(TURNS, 'GET', queryFor(TURNS_TABLE,
    `session_id=eq.${enc(sessionId)}&select=idx,ts&order=idx.asc`)) || [];
  const stamped = stats.filter(t => t.ts);
  // Only the four fields THIS function is the writer of. Identity, placement and
  // title belong to upsertChat — one writer per field, so a push can never
  // half-describe a chat it merely appended to.
  const patch = {
    cursor: Math.max(0, Math.floor(cursor ?? 0)),
    turns: stats.length,
    first_turn_at: stamped.length ? stamped[0].ts : null,
    last_turn_at: stamped.length ? stamped[stamped.length - 1].ts : null,
  };
  await rest(CHATS, 'PATCH', queryFor(CHATS_TABLE, `session_id=eq.${enc(sessionId)}`), patch, 'return=minimal');
  return { pushed: turns.length, ...patch };
}

// The mirror's position in every chat this machine is responsible for, as
// sessionId → cursor. ONE request rather than one per chat: the sweep runs on a
// timer over every chat the machine owns, and a per-chat cursor read would make
// the common "nothing changed" tick cost a round-trip each.
export async function cursorsFor(sessionIds) {
  const ids = [...new Set(sessionIds)].filter(Boolean);
  if (!ids.length) return new Map();
  const list = ids.map(id => `"${id}"`).join(',');
  const rows = await rest(CHATS, 'GET',
    queryFor(CHATS_TABLE, `session_id=in.(${enc(list)})&select=session_id,cursor`)) || [];
  return new Map(rows.map(r => [r.session_id, r.cursor | 0]));
}
