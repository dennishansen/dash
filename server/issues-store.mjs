// Issues store — the kanban's single source of truth, in Supabase.
//
// Every issue is one row in the `issues` table: content (title, body, tags,
// branches, sessions, created) AND its board slice (status column, rank within
// column, owner) live together. There is no markdown registry anymore — the
// table IS the registry of which issues exist, shared live across worktrees and
// machines.
//
// What the row DOESN'T store: anything git can answer from the branch. The
// issue's commits used to be a `commits` column appended by hand, which meant it
// was right only when someone remembered — so it is now derived from the branch
// recorded in `branches[0]` (see dash-api's issue-commits read) and cannot drift.
//
// Talks to Supabase's PostgREST over plain fetch — no client dependency, so a
// fresh clone needs no install step. WHERE the project lives and WHO we are when
// we talk to it belong to supabase.mjs, shared with the profiles store and the
// corpus buckets; this module only knows about issues.
//
// Board ordering runs server-side as a Postgres function (place_cards): the
// caller names the cards it moved and the card they should follow, and the
// server derives the rest of the column from its own rows and renumbers it
// atomically in one request. No rank collisions, and no client snapshot that
// could undo a collaborator's concurrent edit.
//
// Security model: the `issues` table RLS is locked to authenticated sessions
// whose email is in dash_allowed_emails (see the gate_issues_to_allowed_emails
// migration), so what grants access is the bearer token, not the committed anon
// key — see supabase.mjs. A bare anon key reads/writes nothing. This is what
// makes the board safe to serve from a public deploy (artifact.xyz).
//
// Isomorphic: this module runs both in node (board.mjs, dash-api middleware)
// and in the browser (dash client, model-A remote board). `process` doesn't
// exist in the browser, so read env through a guarded shim.
import { rest, restUrl, RPC } from './supabase.mjs';
import { RUN_ID, isRunTable, queryFor, rowFor, stripRunId } from './run-scope.mjs';
import { ARCHIVE_COLS, VALID_STATUS } from '../src/board-columns.mjs';
import { nextChatOrdinal } from '../src/chat-list.js';
export { nextChatOrdinal }; // pure rule lives in chat-list; re-exported for the store's consumers (test-store)
// The ONE column-ordering authority, shared with the board's display sort — so
// "the end of the column" means the same thing here as it does on screen.
import { columnCompare } from '../src/board-sort.js';

const ENV = (typeof process !== 'undefined' && process.env) || {};

// WHICH table this store reads/writes — the isolation axis. Production is
// `issues`; the dash test harness selects run-keyed `dash_test_issues` so test
// traffic never touches the live board (i-dash-test-isolation). Selected by
// DASH_ISSUES_TABLE in node; in the browser the dev server bakes its own
// selection into the bundle via the __DASH_ISSUES_TABLE__ define
// (vite.config.js), so UI + realtime + middleware always agree.
// The one production board. Named rather than spelled inline because code that
// acts on MACHINE-GLOBAL state (the reaper kills real processes) has to be able
// to ask "am I actually on the real board?" against a single definition.
export const PROD_TABLE = 'issues';
export const TABLE = ENV.DASH_ISSUES_TABLE
  || (typeof __DASH_ISSUES_TABLE__ !== 'undefined' ? __DASH_ISSUES_TABLE__ : null)
  || PROD_TABLE;

const REST = restUrl(TABLE);
const RUN_SCOPED = isRunTable(TABLE);
queryFor(TABLE); // fail at module load, before an unscoped test request can run

// Columns the list endpoint needs — everything but `body` (kept off the list
// path so it stays cheap as the corpus grows past hundreds). Detail fetches `*`.
// created_at rides along so a card can show a reliable "created" (the legacy
// `created` date column is often null); it is one small timestamp per row.
const LIST_COLS = 'id,title,tags,branches,sessions,conversations,requires,unlocks,status,rank,owner,created_by,created,created_at,updated_at,closed_at,port,app_path,app_paths,chat_meta,selected_session';

const enc = encodeURIComponent;

// Every issue, board slice included, body excluded. Throws if Supabase is
// unreachable — callers must surface "board unavailable" rather than silently
// rendering an empty kanban (a wrong board is worse than a visible error).
export async function listAll() {
  return (await rest(REST, 'GET', queryFor(TABLE, `select=${LIST_COLS}&order=updated_at.desc`))) || [];
}

// id + body for every issue — just enough for the ⌘K palette to search
// description text. Kept separate from listAll (whose LIST_COLS omits body to
// keep the board's Realtime-refetched cache lean); the palette fetches this
// lazily, only once it's actually opened.
export async function listBodies() {
  return (await rest(REST, 'GET', queryFor(TABLE, `select=id,body&order=updated_at.desc`))) || [];
}

// One issue with its full body. Returns null if it doesn't exist.
export async function get(id) {
  const rows = await rest(REST, 'GET', queryFor(TABLE, `id=eq.${enc(id)}&select=*&limit=1`));
  return stripRunId((rows && rows[0]) || null);
}

export async function exists(id) {
  const rows = await rest(REST, 'GET', queryFor(TABLE, `id=eq.${enc(id)}&select=id&limit=1`));
  return !!(rows && rows.length);
}

// Insert a new issue. Omitted columns take their table defaults (status:
// DEFAULT_STATUS — the New inbox — empty arrays, body:''). Throws on
// duplicate id — logging a dup is a mistake, not a merge. `issue` must include
// id + title.
export async function create(issue) {
  if (!issue || !issue.id || !issue.title) return { error: 'create requires id and title' };
  await rest(REST, 'POST', '', [rowFor(TABLE, issue)], 'return=minimal');
  return { ok: true, id: issue.id };
}

// Patch only the given fields of one issue. The updated_at trigger bumps on any
// update, so the card's "last touched" stays honest. Status, if present, is
// guarded by the column CHECK constraint (and validated by setStatus).
export async function update(id, fields) {
  if (!fields || !Object.keys(fields).length) return { ok: true, id };
  await rest(REST, 'PATCH', queryFor(TABLE, `id=eq.${enc(id)}`), fields, 'return=minimal');
  return { ok: true, id };
}

// Append values to an array field (branches / sessions / tags / conversations),
// de-duped.
// Read-modify-write — fine at single-user write frequency.
export async function appendToArray(id, field, values) {
  if (!['branches', 'sessions', 'tags', 'conversations'].includes(field)) {
    return { error: `appendToArray: bad field "${field}"` };
  }
  const row = await get(id);
  if (!row) return { error: `no issue "${id}"` };
  const merged = [...new Set([...(row[field] || []), ...[].concat(values)])];
  return update(id, { [field]: merged });
}

export async function removeFromArray(id, field, values) {
  if (!['branches', 'sessions', 'tags', 'conversations'].includes(field)) {
    return { error: `removeFromArray: bad field "${field}"` };
  }
  const row = await get(id);
  if (!row) return { error: `no issue "${id}"` };
  const drop = new Set([].concat(values));
  const kept = (row[field] || []).filter(v => !drop.has(v));
  return update(id, { [field]: kept });
}

// Add or remove dependency edges from `id`'s point of view, maintaining the
// INVERSE (requires ⟺ unlocks) atomically. Unlike the array appends above —
// single-row read-modify-writes — a dependency edge touches TWO rows, so it
// can't be a client patch without risking a half-applied, self-contradicting
// pair. It runs server-side (set_dep RPC, like place_cards): one call per dep,
// each an atomic both-sides write.
//   field 'requires': `id` depends on `dep` (dep upstream) → edge dep→id
//   field 'unlocks':  `id` enables `dep` (dep downstream)  → edge id→dep
// Self-reference is refused and the dep list de-duped here (the RPC also guards
// self-ref). Dangling deps are tolerated — the RPC no-ops the missing row's
// side, leaving the id in `id`'s own list to render faintly.
export async function setDep(id, field, deps, add) {
  if (!['requires', 'unlocks'].includes(field)) return { error: `setDep: bad field "${field}"` };
  if (!(await exists(id))) return { error: `no issue "${id}"` };
  const list = [...new Set([].concat(deps).filter(Boolean))];
  if (list.includes(id)) return { error: `an issue can't depend on itself (${id})` };
  for (const dep of list) {
    const [up, down] = field === 'requires' ? [dep, id] : [id, dep];
    if (RUN_SCOPED) {
      await rest(RPC, 'POST', '/dash_test_set_dep',
        { p_run_id: RUN_ID, p_up: up, p_down: down, p_add: add }, 'return=minimal');
    } else {
      await rest(RPC, 'POST', '/set_dep',
        { p_up: up, p_down: down, p_add: add, p_table: TABLE }, 'return=minimal');
    }
  }
  return { ok: true, id };
}

// All dev-server ports currently reserved across every issue row (the live
// registry). The lifecycle around it — allocate with an OS probe, free with
// listener teardown — is node-only and lives in ports.mjs.
export async function reservedPorts() {
  const rows = await rest(REST, 'GET', queryFor(TABLE, 'select=id,port&port=not.is.null'));
  return new Map((rows || []).map(r => [r.id, Number(r.port)]));
}

// Move a card to a column programmatically — `board.mjs start/done/reject`, a
// chat attaching to a `next` issue, a kicked-off issue opening.
//
// A card moved by a PROGRAM expressed no position, and it must not inherit one:
// its old rank is a number that meant something in the column it left, so
// carrying it over drops the card at an arbitrary height in the new column —
// usually the top, shoving itself past work a human deliberately ordered. It
// lands at the END instead: arriving is the newest thing that happened to this
// column, and everything already ranked keeps its place above it.
//
// Archives (done/rejected) sort by close date, not by rank, so there is nothing
// to place there and the plain write is the honest one.
//
// placeCards is the primitive rather than a hand-written rank because it
// renumbers the column 0..n server-side and atomically — hand-setting a rank is
// how two cards end up sharing one (kanban-card-swap-rank-tie). Its own
// contract also makes the failure mode the right one here: if the anchor moved
// away underneath us, the card lands at the end of the column anyway.
export async function setStatus(id, status) {
  if (!VALID_STATUS.has(status)) return { error: `invalid status "${status}"` };
  if (ARCHIVE_COLS.has(status)) {
    await update(id, { status });
    return { ok: true, id, status };
  }
  const column = (await listAll())
    .filter(r => r.status === status && r.id !== id)
    .map(r => ({ id: r.id, order: r.rank != null ? Number(r.rank) : null, created: r.created }))
    .sort(columnCompare);
  const last = column.length ? column[column.length - 1].id : null;
  const r = await placeCards([id], status, last);
  if (r?.error) return r;
  return { ok: true, id, status, placedAfter: last };
}

export async function setOwner(id, owner) {
  await update(id, { owner: owner || null });
  return { ok: true, id, owner: owner || null };
}

// Record THE branch for an issue. `branches[0]` is the issue's branch everywhere
// that matters (shapeRow exposes it as `branch`), so this puts `name` first and
// keeps any other entries after it rather than discarding a human's extra note.
// Idempotent: re-recording the same branch is a no-op write-wise.
//
// This is the link that makes a readable branch name safe. Branch names no
// longer encode the issue id, so nothing may INFER the branch from the id — it
// is read from here or it is not known.
export async function setIssueBranch(id, name) {
  if (!id || !name) return { error: 'setIssueBranch requires id and branch name' };
  const row = await get(id);
  if (!row) return { error: `no issue "${id}"` };
  const rest = (Array.isArray(row.branches) ? row.branches : []).filter(b => b && b !== name);
  const branches = [name, ...rest];
  if (row.branches?.length === branches.length && row.branches[0] === name) {
    return { ok: true, id, branches, changed: false };
  }
  await update(id, { branches });
  return { ok: true, id, branches, changed: true };
}

// --- per-chat metadata (`chat_meta`) ---
//
// A JSONB map riding beside `conversations[]`, keyed by the FULL session uuid —
// the 8-char form the UI shows is a display truncation, not an identity, and two
// chats could collide on it. One entry per chat holds everything the row knows
// about it:
//
//   { "<uuid>": { name: "solver notes", ordinal: 2, owner: "a@b.com", host: "dennis-mbp" } }
//
// `name` is user-editable decoration. `ordinal`/`owner`/`host` are stamped once,
// when the chat is created, and are the facts it is BORN with: which chat of
// this environment's it is, and whose computer it lives on. Ownership is what
// lets a teammate's chat appear in everyone's list and explain itself instead of
// looking broken; the number is what the chat is CALLED until someone names it.
// The number is recorded rather than counted off the list because a list
// reorders and a name must not — it used to be the chat's row index, so it
// renumbered itself the moment the mirror sweep dated it (i-chat-stored-names).
// They are in one map because the chat list reads them together on every build;
// separate columns would be separate reads and chances to disagree.

// The row's chat-meta map, defended against a null/array/legacy value — every
// reader (shape, store, terminal) goes through this so "nothing recorded" is
// always {}, and each entry is always an object.
export function readChatMeta(row) {
  const m = row && row.chat_meta;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return {};
  const out = {};
  for (const [k, v] of Object.entries(m)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = v;
  }
  return out;
}

// Write one chat's entry, merging `fields` over what's there. An entry that ends
// up with nothing in it is DELETED rather than left as `{}`, so "cleared" and
// "never recorded" stay the same state. Read-modify-write on one column, like
// appendToArray.
async function patchChatMeta(id, sessionId, fields) {
  const row = await get(id);
  if (!row) return { error: `no issue "${id}"` };
  const meta = { ...readChatMeta(row) };
  const next = { ...(meta[sessionId] || {}) };
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || v === '') delete next[k];
    else next[k] = v;
  }
  if (Object.keys(next).length) meta[sessionId] = next;
  else delete meta[sessionId];
  await update(id, { chat_meta: meta });
  return { ok: true, id, chat_meta: meta };
}

// Name (or un-name) one of the issue's chats. A blank name clears the field, so
// the label falls back to the number the chat was born with.
export async function setChatName(id, sessionId, name) {
  if (!id || !sessionId) return { error: 'setChatName requires id and sessionId' };
  return patchChatMeta(id, sessionId, { name: typeof name === 'string' ? name.trim() : '' });
}

// Forget a chat entirely — name, number and ownership stamp together. The
// metadata belongs to the LINK, so unlinking a chat drops all of it rather than
// leaving a half-entry behind.
export async function clearChatMeta(id, sessionId) {
  if (!id || !sessionId) return { error: 'clearChatMeta requires id and sessionId' };
  return patchChatMeta(id, sessionId, { name: '', owner: '', host: '', ordinal: null });
}

// The number a NEW chat takes in an environment that already holds `peers` chats
// and has handed out the numbers in `meta`: one past the highest of both.

// Add a chat to an issue: its LINK and the facts it is born with — its number in
// this environment, and whose computer it lives on — as ONE read-modify-write.
//
// One write, not two, because they are one event. Appending the handle and then
// stamping the metadata left a window in which the chat existed with no number
// and no owner, and the stamp was the half that could fail; a chat that is listed
// but unnamed is exactly the state this issue removed. `conversations` and
// `chat_meta` are columns of the same row, so there was never a reason to touch
// it twice.
//
// The stamp is WRITE-ONCE, PER FIELD: an existing value is never overwritten. The
// machine a chat was created on is a historical fact — a second dash server
// re-linking the row later must not re-stamp it as its own and quietly steal the
// attribution — and a number that can change is the bug this replaced.
//
// Read-modify-write, like appendToArray, whose concurrency assumption it inherits.
export async function addChat(id, handle, sessionId, { owner, host } = {}) {
  if (!id || !handle || !sessionId) return { error: 'addChat requires id, handle and sessionId' };
  const row = await get(id);
  if (!row) return { error: `no issue "${id}"` };
  const links = (Array.isArray(row.conversations) ? row.conversations : []).filter((h) => typeof h === 'string');
  const meta = { ...readChatMeta(row) };
  const existing = { ...(meta[sessionId] || {}) };
  if (!existing.owner && !existing.host) {
    if (owner) existing.owner = owner;
    if (host) existing.host = host;
  }
  // Peers are the env's OTHER chats — a re-link of a chat already listed must not
  // count it as its own peer.
  if (!Number.isInteger(existing.ordinal)) {
    existing.ordinal = nextChatOrdinal(meta, links.filter((h) => !h.endsWith(sessionId)).length);
  }
  meta[sessionId] = existing;
  await update(id, { conversations: [...new Set([...links, handle])], chat_meta: meta });
  return { ok: true, id, chat_meta: meta };
}

// Give every already-linked chat the number it has been displaying, taken from
// the row's link order — the one-time backfill for chats that predate stored
// numbers (i-chat-stored-names). Idempotent and additive: a chat that already
// has a number keeps it, and the rest fill the gaps around it in link order, so
// nothing visibly renumbers on the way in. Returns how many it stamped.
export async function backfillChatOrdinals(id) {
  const row = await get(id);
  if (!row) return { error: `no issue "${id}"` };
  const links = (Array.isArray(row.conversations) ? row.conversations : []).filter((h) => typeof h === 'string');
  const meta = { ...readChatMeta(row) };
  const sessionOf = (h) => h.slice(h.lastIndexOf(':') + 1);
  const taken = new Set(Object.values(meta).map((m) => m && m.ordinal).filter(Number.isInteger));
  let next = 1;
  let stamped = 0;
  for (const handle of links) {
    const sid = sessionOf(handle);
    if (Number.isInteger(meta[sid] && meta[sid].ordinal)) continue;
    while (taken.has(next)) next += 1;
    meta[sid] = { ...(meta[sid] || {}), ordinal: next };
    taken.add(next);
    stamped += 1;
  }
  if (stamped) await update(id, { chat_meta: meta });
  return { ok: true, id, stamped };
}

// Put cards in a column, at a position. `ids` are the cards being moved (in
// their intended relative order — a drag moves one, a keyboard nudge moves a
// run), `status` is the column they land in, and `afterId` is the card they
// should follow — null means the top. One server-side call (place_cards) sets
// their status and renumbers the column's ranks 0..n atomically.
//
// Only the moved cards and the anchor travel. Everything else about the column
// the SERVER reads from its own current rows, so a collaborator's concurrent
// move or insert is neither undone nor collided with (i-move-column-race) — a
// card the mover never saw keeps its place, a card that left stays gone. If the
// anchor itself moved away mid-drag the run lands at the end of the column.
export async function placeCards(ids, status, afterId = null) {
  if (!VALID_STATUS.has(status)) return { error: `invalid status "${status}"` };
  if (!Array.isArray(ids) || ids.length === 0) return { error: 'ids must be a non-empty array' };
  if (RUN_SCOPED) {
    await rest(RPC, 'POST', '/dash_test_place_cards',
      { p_run_id: RUN_ID, p_ids: ids, p_status: status, p_after: afterId || null }, 'return=minimal');
  } else {
    await rest(RPC, 'POST', '/place_cards',
      { p_ids: ids, p_status: status, p_after: afterId || null, p_table: TABLE }, 'return=minimal');
  }
  return { ok: true, status, placed: ids.length };
}

export async function remove(id) {
  await rest(REST, 'DELETE', queryFor(TABLE, `id=eq.${enc(id)}`), null, 'return=minimal');
  return { ok: true, id };
}
