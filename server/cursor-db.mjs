// Read-only access to Cursor's local chat store.
//
// Cursor keeps its chats in SQLite, not in files: one global database
// (`globalStorage/state.vscdb`) holding every conversation, and one small
// database per opened folder (`workspaceStorage/<workspaceId>/`) whose sibling
// `workspace.json` records WHICH folder that is. Three tables/keys matter:
//
//   composerHeaders            one row per conversation → its `workspaceId`
//   cursorDiskKV composerData: the conversation head → title + ordered bubble ids
//   cursorDiskKV bubbleId:     one row per message   → { type, text }
//
// This is an INTERNAL format with no supported export, and it can change on any
// Cursor update. That cost is accepted deliberately (see i-chat-sync) — what
// keeps it honest is that every mapping here is an exact structural lookup, not
// a guess: a conversation belongs to the folder its workspaceId names, and a
// message's role is its `type` field. Nothing is matched fuzzily, so a schema
// change fails loudly (no rows) instead of quietly returning the wrong chats.
//
// WHY node:sqlite IN A WORKER and not the sqlite3 CLI. The CLI cost one
// subprocess per query, and under the old N-dash sweeps that multiplied into
// the 2026-07-30 spawn storm (hundreds of sqlite3 execs/minute pegging
// syspolicyd). node:sqlite removes the subprocess class entirely — but it is
// SYNCHRONOUS, and a sync query against a gigabyte-plus store on the event
// loop that relays PTY keystrokes would trade the storm for typing freezes,
// so the connection lives in a worker thread (cursor-db.worker.mjs) and the
// main thread awaits messages. Still read-only, still json_extract-ing only
// the fields a spoken turn needs.
//
// LAB_CURSOR_DIR overrides the store root so tests run against a synthesized
// database instead of a developer's real Cursor state (same seam as
// LAB_CODEX_SESSIONS_DIR).

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

// Cursor's application-support root — the parent of globalStorage and
// workspaceStorage. Cursor puts it where its host OS puts app data, so the
// candidates are listed rather than branched on: the FIRST one that exists
// wins, and a machine with no Cursor at all matches none and every read below
// reports "nothing here". Listing beats `if (darwin)` because the answer is
// "wherever the store actually is", not "which platform is this".
function cursorRoot() {
  if (process.env.LAB_CURSOR_DIR) return process.env.LAB_CURSOR_DIR;
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Library', 'Application Support', 'Cursor', 'User'), // macOS
    path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Cursor', 'User'), // Linux
    path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User'), // Windows
  ];
  return candidates.find((c) => { try { return fs.statSync(c).isDirectory(); } catch { return false; } })
    ?? candidates[0];
}

const globalDb = () => path.join(cursorRoot(), 'globalStorage', 'state.vscdb');
const workspaceStorage = () => path.join(cursorRoot(), 'workspaceStorage');

// Is Cursor's store present on this machine at all? Every public read short-
// circuits on this, so a machine without Cursor pays one stat and no subprocess.
export function cursorPresent() {
  try { return fs.statSync(globalDb()).isFile(); } catch { return false; }
}

// The global store's path, or null — the "transcript path" a Cursor chat
// resolves to. It is the same file for every Cursor chat (they share one
// database), which is exactly why a Cursor chat can never be *resumed* by path
// the way a claude/codex transcript can.
export function cursorDbPath() {
  return cursorPresent() ? globalDb() : null;
}

// A conversation id, strictly. Every id this module interpolates into SQL comes
// either from Cursor's own tables or from a chat handle, and both are uuids — so
// validating the shape is a complete defence rather than an escaping trick. An
// id that isn't one is refused, never quoted-and-hoped.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isComposerId = (id) => typeof id === 'string' && UUID.test(id);

// The one lazily-started worker. unref'd so it never holds the process open;
// an exit (crash, cancelled runtime) clears the handle and the next query
// starts a fresh one. Requests are correlated by id so overlapping queries
// (the mirror and a chats poll at once) each get their own rows.
let worker = null;
let nextId = 1;
const pending = new Map(); // id → resolve

function ensureWorker() {
  if (worker) return worker;
  const entry = fileURLToPath(new URL('./cursor-db.worker.mjs', import.meta.url));
  // --experimental-sqlite makes node:sqlite importable on every node this repo
  // supports (it ships unflagged only from 22.13/23.4) and is inert where the
  // module is already on by default. The capability probe below is the honest
  // gate — a node too old for the flag fails there, loudly, at boot.
  worker = new Worker(entry, { execArgv: ['--experimental-sqlite'] });
  worker.on('message', ({ id, rows }) => {
    const resolve = pending.get(id);
    if (resolve) { pending.delete(id); resolve(rows); }
    // Idle again → let the process exit. A referenced idle worker wedges every
    // short-lived host (each test file hung 5 minutes on it); an unref'd BUSY
    // worker is the opposite bug — node sees an unsettled await with no live
    // handle and exits mid-query. Ref exactly while requests are in flight.
    if (pending.size === 0) worker?.unref();
  });
  worker.on('error', () => { flushPending(); worker = null; });
  worker.on('exit', () => { flushPending(); worker = null; });
  worker.unref();
  return worker;
}

function flushPending() {
  for (const resolve of pending.values()) resolve([]);
  pending.clear();
}

// One read-only query against the global database, as parsed rows. Any failure
// — no Cursor, a locked database, a schema that no longer has these tables, a
// worker that died — yields []: the dash shows no Cursor chats, which is the
// honest degraded state.
async function query(sql) {
  if (!cursorPresent()) return [];
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    try {
      const w = ensureWorker();
      w.ref(); // busy: hold the process until this query answers
      w.postMessage({ id, path: globalDb(), sql });
    } catch { pending.delete(id); resolve([]); }
  });
}

// Boot-time capability probe: proves node:sqlite actually initializes in the
// worker on THIS node (the supervisor asserts this while becoming ready, so a
// too-old runtime is one clear line at boot, not a silent no-Cursor-chats).
// Uses sqlite itself — an in-memory table, no Cursor store needed.
export async function assertCursorDbCapability() {
  const entry = fileURLToPath(new URL('./cursor-db.worker.mjs', import.meta.url));
  const w = new Worker(entry, { execArgv: ['--experimental-sqlite'] });
  try {
    return await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('cursor-db worker did not answer')), 5000);
      w.on('message', () => { clearTimeout(t); resolve(true); });
      w.on('error', (e) => { clearTimeout(t); reject(new Error(`node:sqlite unavailable on this node (${process.version}): ${e.message}`)); });
      w.postMessage({ id: 0, path: ':memory:', sql: 'select 1 as ok' });
    });
  } finally { await w.terminate(); }
}

// A prefix scan that USES the key index. `key LIKE 'p%'` does not: SQLite's LIKE
// is case-insensitive by default, which disqualifies the index optimisation, and
// the scan then walks all ~46k keys (measured: 2.2s vs 11ms). The upper bound is
// the prefix with its final ':' bumped to ';' — the next byte — so the range is
// exactly the keys under that prefix.
function prefixRange(column, prefix) {
  const last = prefix.slice(-1);
  const upper = prefix.slice(0, -1) + String.fromCharCode(last.charCodeAt(0) + 1);
  return `${column} >= '${prefix}' and ${column} < '${upper}'`;
}

// The absolute folder a Cursor workspace corresponds to, or null. `workspace.json`
// records it as a file:// URI; a workspace with no folder (an empty window) has
// no file at all. `workspaceId` is used as a path segment, so the resolved path
// is checked to still sit under workspaceStorage — a traversal in the id can
// then never read outside Cursor's own store.
export function workspaceFolder(workspaceId) {
  if (!workspaceId) return null;
  const base = workspaceStorage();
  const dir = path.resolve(base, String(workspaceId));
  if (dir !== base && !dir.startsWith(base + path.sep)) return null;
  try {
    const { folder } = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8'));
    if (typeof folder !== 'string' || !folder.startsWith('file://')) return null;
    return decodeURIComponent(new URL(folder).pathname);
  } catch { return null; }
}

// Every conversation Cursor has recorded, with the folder it belongs to and the
// title Cursor gave it: [{ composerId, dir, title, updatedAt }]. Conversations
// whose workspace has no folder (an empty editor window) are dropped — they
// belong to no environment and there is nothing to attach them to. Subagent
// conversations are dropped too: they are a chat's internal fan-out, the same
// thing claude's sidechain lines are, and the claude adapter already excludes
// those from spoken turns.
//
// ONE query for the whole list, title joined in — the alternative (a head read
// per conversation) is one subprocess per chat on every listing, and the title
// is what makes a Cursor chat read as itself rather than as "chat 3".
export async function listComposers() {
  const rows = await query(
    "select h.composerId as composerId, h.workspaceId as workspaceId,"
    + " h.lastUpdatedAt as lastUpdatedAt, h.createdAt as createdAt,"
    + " json_extract(d.value,'$.name') as title"
    + ' from composerHeaders h'
    + " left join cursorDiskKV d on d.key = 'composerData:' || h.composerId"
    + ' where coalesce(h.isSubagent, 0) = 0 and coalesce(h.isArchived, 0) = 0',
  );
  const folders = new Map(); // workspaceId → dir (each workspace.json read once)
  const out = [];
  for (const r of rows) {
    if (!isComposerId(r.composerId)) continue;
    if (!folders.has(r.workspaceId)) folders.set(r.workspaceId, workspaceFolder(r.workspaceId));
    const dir = folders.get(r.workspaceId);
    if (!dir) continue;
    out.push({
      composerId: r.composerId,
      dir,
      title: r.title || null,
      updatedAt: r.lastUpdatedAt || r.createdAt || null,
    });
  }
  return out;
}

// One conversation's head: { title, bubbleIds } in conversation order, or null
// if Cursor has no such conversation. `fullConversationHeadersOnly` is the
// ordered index of its messages — the bubble rows themselves are keyed by id and
// carry no sequence, so this array IS the order.
export async function composerHead(composerId) {
  if (!isComposerId(composerId)) return null;
  const rows = await query(
    "select json_extract(value,'$.name') as title,"
    + " json_extract(value,'$.fullConversationHeadersOnly') as heads"
    + ` from cursorDiskKV where key = 'composerData:${composerId}'`,
  );
  if (!rows.length) return null;
  let heads = [];
  try { heads = JSON.parse(rows[0].heads || '[]'); } catch {}
  return {
    title: rows[0].title || null,
    bubbleIds: (Array.isArray(heads) ? heads : []).map(h => h?.bubbleId).filter(isComposerId),
  };
}

// The messages of one conversation as bubbleId → { type, text, createdAt }. Only
// the three fields that make a spoken turn are extracted; a bubble's full record
// also carries tool results, file diffs and thinking, none of which are mirrored.
export async function composerBubbles(composerId) {
  if (!isComposerId(composerId)) return new Map();
  const rows = await query(
    "select key, json_extract(value,'$.type') as type, json_extract(value,'$.text') as text,"
    + " json_extract(value,'$.createdAt') as createdAt"
    + ` from cursorDiskKV where ${prefixRange('key', `bubbleId:${composerId}:`)}`,
  );
  const out = new Map();
  for (const r of rows) out.set(String(r.key).slice(`bubbleId:${composerId}:`.length), r);
  return out;
}

// When a conversation last changed, as epoch ms — the cheap "has this moved?"
// check the mirror polls with, so an unchanged chat costs one small query rather
// than a full message read. null when Cursor has no such conversation.
export async function composerUpdatedAt(composerId) {
  if (!isComposerId(composerId)) return null;
  const rows = await query(
    `select lastUpdatedAt, createdAt from composerHeaders where composerId = '${composerId}'`,
  );
  if (!rows.length) return null;
  return rows[0].lastUpdatedAt || rows[0].createdAt || null;
}
