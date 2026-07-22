// Issues store — the kanban's single source of truth, in Supabase.
//
// Every issue is one row in the `issues` table: content (title, body, tags,
// branches, sessions, commits, created) AND its board slice (status
// column, rank within column, owner) live together. There is no markdown
// registry anymore — the table IS the registry of which issues exist, shared
// live across worktrees and machines.
//
// Talks to Supabase's PostgREST over plain fetch — no client dependency. The
// project URL + keys come from dash-config.mjs (env in node, Vite build-time
// injection in the browser). Bring your own Supabase project — nothing here is
// hardcoded.
//
// Two bulk ops (reorder, cross-column move) run server-side as Postgres
// functions (set_ranks / move_column) so a whole column renumbers atomically
// in one request, with no rank collisions and no NOT-NULL insert hazard.
//
// Security model: the anon/publishable key only IDENTIFIES the project (the
// `apikey` header). It does not grant access on its own — the `issues` table
// RLS is locked to authenticated sessions whose email is in dash_allowed_emails
// (see supabase/schema.sql). So the bearer token is what matters: the browser
// carries a signed-in user's JWT (auth.js), and node tools carry the service
// key (DASH_SUPABASE_SERVICE_KEY) which bypasses RLS. A bare anon key
// reads/writes nothing. This is what makes the board safe to serve publicly.

// WHERE the project lives and WHO we are when we talk to it belong to
// supabase.mjs — the shared PostgREST helpers (rest/restUrl/RPC) and the one
// auth token that auth.js updates on sign-in, so a signed-in user's JWT reaches
// EVERY store (issues, profiles, storage), not just this one. This module only
// knows about issues.
import { rest, restUrl, RPC } from './supabase.mjs';

// The board's table. A single fixed table here (no test-isolation split) — the
// browser's realtime subscription (realtime.js) and this store must name the same one.
export const TABLE = 'issues';

const REST = restUrl(TABLE);

export const VALID_STATUS = new Set(['maybe', 'future', 'next', 'in-progress', 'done', 'rejected']);

// Columns the list endpoint needs — everything but `body` (kept off the list
// path so it stays cheap as the corpus grows past hundreds). Detail fetches `*`.
const LIST_COLS = 'id,title,tags,branches,sessions,commits,conversations,requires,unlocks,status,rank,owner,created,updated_at,closed_at,port,chat_names,selected_session';

const enc = encodeURIComponent;

// Every issue, board slice included, body excluded. Throws if Supabase is
// unreachable — callers must surface "board unavailable" rather than silently
// rendering an empty kanban (a wrong board is worse than a visible error).
export async function listAll() {
  return (await rest(REST, 'GET', `?select=${LIST_COLS}&order=updated_at.desc`)) || [];
}

// id + body for every issue — just enough for the ⌘K palette to search
// description text. Kept separate from listAll (whose LIST_COLS omits body to
// keep the board's Realtime-refetched cache lean); the palette fetches this
// lazily, only once it's actually opened.
export async function listBodies() {
  return (await rest(REST, 'GET', `?select=id,body&order=updated_at.desc`)) || [];
}

// One issue with its full body. Returns null if it doesn't exist.
export async function get(id) {
  const rows = await rest(REST, 'GET', `?id=eq.${enc(id)}&select=*&limit=1`);
  return (rows && rows[0]) || null;
}

export async function exists(id) {
  const rows = await rest(REST, 'GET', `?id=eq.${enc(id)}&select=id&limit=1`);
  return !!(rows && rows.length);
}

// Insert a new issue. Omitted columns take their table defaults (status:'next',
// empty arrays, body:''). Throws on duplicate id — logging a dup is a mistake,
// not a merge. `issue` must include id + title.
export async function create(issue) {
  if (!issue || !issue.id || !issue.title) return { error: 'create requires id and title' };
  await rest(REST, 'POST', '', [issue], 'return=minimal');
  return { ok: true, id: issue.id };
}

// Patch only the given fields of one issue. The updated_at trigger bumps on any
// update, so the card's "last touched" stays honest. Status, if present, is
// guarded by the column CHECK constraint (and validated by setStatus).
export async function update(id, fields) {
  if (!fields || !Object.keys(fields).length) return { ok: true, id };
  await rest(REST, 'PATCH', `?id=eq.${enc(id)}`, fields, 'return=minimal');
  return { ok: true, id };
}

// Append values to an array field (commits / branches / sessions), de-duped.
// Read-modify-write — fine at single-user write frequency.
export async function appendToArray(id, field, values) {
  if (!['commits', 'branches', 'sessions', 'tags', 'conversations'].includes(field)) {
    return { error: `appendToArray: bad field "${field}"` };
  }
  const row = await get(id);
  if (!row) return { error: `no issue "${id}"` };
  const merged = [...new Set([...(row[field] || []), ...[].concat(values)])];
  return update(id, { [field]: merged });
}

export async function removeFromArray(id, field, values) {
  if (!['commits', 'branches', 'sessions', 'tags', 'conversations'].includes(field)) {
    return { error: `removeFromArray: bad field "${field}"` };
  }
  const row = await get(id);
  if (!row) return { error: `no issue "${id}"` };
  const drop = new Set([].concat(values));
  const kept = (row[field] || []).filter(v => !drop.has(v));
  return update(id, { [field]: kept });
}

// All dev-server ports currently reserved across every issue row (the live
// registry). The lifecycle around it — allocate with an OS probe, free with
// listener teardown — is node-only and lives in ports.mjs.
export async function reservedPorts() {
  const rows = await rest(REST, 'GET', `?select=id,port&port=not.is.null`);
  return new Map((rows || []).map(r => [r.id, Number(r.port)]));
}

export async function setStatus(id, status) {
  if (!VALID_STATUS.has(status)) return { error: `invalid status "${status}"` };
  await update(id, { status });
  return { ok: true, id, status };
}

export async function setOwner(id, owner) {
  await update(id, { owner: owner || null });
  return { ok: true, id, owner: owner || null };
}

// Add or remove dependency edges on an issue, maintaining the INVERSE on the
// other issue's row. `field` is 'requires' | 'unlocks'; the set_dep RPC touches
// both rows in one transaction (a client read-modify-write could half-apply and
// leave the two sides disagreeing). The edge is directed upstream→downstream, so
// `requires` maps to dep→id and `unlocks` to id→dep. `add` false removes.
// Dangling deps are tolerated — the RPC no-ops the missing row's side, leaving
// the id in `id`'s own list to render faintly. Self-reference is refused.
export async function setDep(id, field, deps, add) {
  if (!['requires', 'unlocks'].includes(field)) return { error: `setDep: bad field "${field}"` };
  if (!(await exists(id))) return { error: `no issue "${id}"` };
  const list = [...new Set([].concat(deps).filter(Boolean))];
  if (list.includes(id)) return { error: `an issue can't depend on itself (${id})` };
  for (const dep of list) {
    const [up, down] = field === 'requires' ? [dep, id] : [id, dep];
    await rest(RPC, 'POST', '/set_dep', { p_up: up, p_down: down, p_add: add, p_table: TABLE }, 'return=minimal');
  }
  return { ok: true, id };
}

// Name (or un-name) one of the issue's chats. `chat_names` is a JSONB map that
// rides beside `conversations[]`, keyed by the FULL session uuid — the 8-char
// form the UI shows is a display truncation, not an identity, and two chats
// could collide on it. A blank name DELETES the key rather than storing '', so
// "cleared" and "never named" are the same state and the label falls back to the
// derived default. Read-modify-write on one column.
export async function setChatName(id, sessionId, name) {
  if (!id || !sessionId) return { error: 'setChatName requires id and sessionId' };
  const row = await get(id);
  if (!row) return { error: `no issue "${id}"` };
  const names = { ...readChatNames(row) };
  const clean = typeof name === 'string' ? name.trim() : '';
  if (clean) names[sessionId] = clean;
  else delete names[sessionId];
  await update(id, { chat_names: names });
  return { ok: true, id, chat_names: names };
}

// The row's chat-name map, defended against a null/array/legacy value — every
// reader (shape, store, terminal) goes through this so "no names" is always {}.
export function readChatNames(row) {
  const m = row && row.chat_names;
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}

// Reorder one column: `ids` is the column's final ordering; rank becomes the
// index (0..n). Status untouched — reordering never moves a card's column.
// Runs server-side (set_ranks) so the whole column renumbers atomically.
export async function setRanks(ids) {
  if (!Array.isArray(ids)) return { error: 'ids must be an array' };
  if (ids.length === 0) return { ok: true, updated: 0 };
  await rest(RPC, 'POST', '/set_ranks', { p_ids: ids }, 'return=minimal');
  return { ok: true, updated: ids.length };
}

// Move into a column: `ids` is that column's final ordering (the dragged card
// at its drop slot). One server-side call sets every row's status to the column
// and renumbers ranks 0..n — atomic, collision-free, idempotent.
export async function moveColumn(status, ids) {
  if (!VALID_STATUS.has(status)) return { error: `invalid status "${status}"` };
  if (!Array.isArray(ids) || ids.length === 0) return { error: 'ids must be a non-empty array' };
  await rest(RPC, 'POST', '/move_column', { p_status: status, p_ids: ids }, 'return=minimal');
  return { ok: true, status, updated: ids.length };
}

export async function remove(id) {
  await rest(REST, 'DELETE', `?id=eq.${enc(id)}`, null, 'return=minimal');
  return { ok: true, id };
}
