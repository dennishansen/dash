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

// Exported so the browser realtime client (src/realtime.js) opens its websocket
// against the SAME project + key — one source of truth for where `issues` lives.
import { SUPABASE_URL, SUPABASE_ANON, SUPABASE_SERVICE } from './dash-config.mjs';

export const URL = SUPABASE_URL;
export const ANON = SUPABASE_ANON;

const REST = `${URL}/rest/v1/issues`;
const RPC = `${URL}/rest/v1/rpc`;

// PostgREST wants two things: `apikey` (the public project key, always ANON —
// it only identifies the project) and `Authorization: Bearer <jwt>` (the
// identity RLS evaluates). The bearer token varies by caller:
//   - node tools (dev middleware, CLI): the service key when set — it bypasses
//     RLS, so the kanban keeps working server-side under the tightened RLS.
//     Falls back to ANON if no service key.
//   - browser: ANON until a user signs in, then their access token (pushed via
//     setAuthToken from auth.js). The anon key alone can't write once RLS is
//     locked to authenticated + allow-listed emails — that's the whole point.
const SERVICE = SUPABASE_SERVICE;
let authToken = SERVICE || ANON;

// Swap the bearer token (browser sign-in / sign-out). null restores the default.
export function setAuthToken(token) {
  authToken = token || SERVICE || ANON;
}

function headers(prefer) {
  const h = {
    apikey: ANON,
    Authorization: `Bearer ${authToken}`,
    'Content-Type': 'application/json',
  };
  if (prefer) h.Prefer = prefer;
  return h;
}

export const VALID_STATUS = new Set(['maybe', 'future', 'next', 'in-progress', 'done', 'rejected']);

// Columns the list endpoint needs — everything but `body` (kept off the list
// path so it stays cheap as the corpus grows past hundreds). Detail fetches `*`.
const LIST_COLS = 'id,title,tags,branches,sessions,commits,conversations,status,rank,owner,created,updated_at,closed_at,port';

async function rest(url, method, query, body, prefer) {
  const res = await fetch(`${url}${query}`, {
    method,
    headers: headers(prefer),
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`issues-store ${method} ${query} → ${res.status} ${detail}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const enc = encodeURIComponent;

// Every issue, board slice included, body excluded. Throws if Supabase is
// unreachable — callers must surface "board unavailable" rather than silently
// rendering an empty kanban (a wrong board is worse than a visible error).
export async function listAll() {
  return (await rest(REST, 'GET', `?select=${LIST_COLS}&order=updated_at.desc`)) || [];
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

// --- dev-server port allocation ---
//
// Each active issue's worktree gets a stable dev-server port in [5200,5299]
// (never 5173, the main repo's server). The PERSISTED `port` column IS the
// allocation registry: a non-null port on an issue row means that port is
// reserved for it; clearing it (free) releases the port. Allocation is:
//   stable     — once set, an issue keeps its port (allocatePort is a no-op if
//                the row already has one)
//   collision-free — the lowest port not already held by ANY issue row
//   idempotent — re-running for an issue that has a port returns the same port
const PORT_MIN = 5200;
const PORT_MAX = 5299;

// All ports currently reserved across every issue row (the live registry).
async function reservedPorts() {
  const rows = await rest(REST, 'GET', `?select=id,port&port=not.is.null`);
  return new Map((rows || []).map(r => [r.id, Number(r.port)]));
}

// Reserve a port for an issue, idempotently. If the row already holds a port,
// return it unchanged. Otherwise pick the lowest free port in range and persist
// it (the persist IS the reservation). Returns { ok, port } or { error }.
export async function allocatePort(id) {
  const row = await get(id);
  if (!row) return { error: `no issue "${id}"` };
  if (row.port != null) return { ok: true, port: Number(row.port), reused: true };
  const reserved = await reservedPorts();
  const taken = new Set(reserved.values());
  let port = null;
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (!taken.has(p)) { port = p; break; }
  }
  if (port == null) return { error: `no free dev-server port in ${PORT_MIN}-${PORT_MAX}` };
  await update(id, { port });
  return { ok: true, port, reused: false };
}

// Release an issue's reserved port (clear the field). Idempotent — clearing an
// already-null port is a no-op. This is the "free" half of the registry.
export async function freePort(id) {
  const row = await get(id);
  if (!row) return { error: `no issue "${id}"` };
  const had = row.port != null ? Number(row.port) : null;
  if (had != null) await update(id, { port: null });
  return { ok: true, freed: had };
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
