// The sqlite half of cursor-db, in a worker thread — because node:sqlite is
// SYNCHRONOUS (DatabaseSync/StatementSync), and a synchronous query against
// Cursor's gigabyte-plus store on the supervisor's event loop would freeze
// every PTY keystroke it relays (the terminal-typing-freeze class). The worker
// pays that block on its own thread; the main thread awaits a message.
//
// Read-only by construction: the database is opened with SQLite's readOnly
// flag, so this can never write to a store Cursor owns. The connection is
// opened lazily per message and kept; a schema/lock error resolves to [] —
// the honest degraded state (no Cursor chats) the CLI path also had.
//
// Launched with execArgv ['--experimental-sqlite'] by cursor-db.mjs: the flag
// is what makes node:sqlite importable on every node this repo supports
// (unflagged only from 22.13/23.4), and it is inert where it's already on.
import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

let db = null;
let dbPath = null;

parentPort.on('message', ({ id, path, sql }) => {
  let rows = [];
  try {
    if (!db || dbPath !== path) {
      try { db?.close(); } catch {}
      db = new DatabaseSync(path, { readOnly: true });
      dbPath = path;
    }
    rows = db.prepare(sql).all();
  } catch {
    // Locked, schema drift, or a mid-write journal state — degrade to "no
    // rows" exactly as the CLI path did, and drop the handle so the next
    // query reopens cleanly.
    try { db?.close(); } catch {}
    db = null;
    rows = [];
  }
  parentPort.postMessage({ id, rows });
});
