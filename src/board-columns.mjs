// The board's columns, in order — the ONE declaration of what a status is.
//
// A column IS a status: the key stored in `issues.status`, the label the board
// and the ⌘K palette show, the tint the column wears, and whether it's a
// hand-ranked queue or a chronological archive. Everything that enumerates
// statuses reads this table — the store's validation, the kanban, the detail
// status menu, the palette, the CLI — so a column is added in ONE place here
// (plus a migration for the table's CHECK constraint, since Postgres can't read
// this file).
//
// Pure data, zero imports — like board-sort.js / board-filters.js beside it, so
// node CLIs (scripts/board.mjs), the dev middleware, and the browser bundle all
// import the same table.
//
// Order is the board's reading — kanban left-to-right, list top-to-bottom. The
// six ranked/archive columns keep their commitment progression (maybe → …→
// rejected); `new` sits at the END as the catch-all inbox that freshly filed
// work defaults into, parked out of the ranked queue's way until a human pulls
// it in. Nothing enters the queue (`next`) until they do.
export const COLUMNS = [
  { key: 'maybe',       title: 'Maybe',       tone: 'plain' },
  { key: 'future',      title: 'Future',      tone: 'plain' },
  { key: 'next',        title: 'Next',        tone: 'info' },
  { key: 'in-progress', title: 'In Progress', tone: 'active' },
  { key: 'done',        title: 'Done',        tone: 'ok',   archive: true },
  { key: 'rejected',    title: 'Rejected',    tone: 'warn', archive: true },
  { key: 'new',         title: 'New',         tone: 'plain' },
];

// Where a freshly filed issue lands when no column is named — the CLI, the
// store's documented insert default, and the `issues` table's own column
// default (see the new_column migration) all mean THIS. Stated outright
// rather than derived from the order: "first column" and "where new work
// arrives" are two different facts that happen to coincide today.
export const DEFAULT_STATUS = 'new';

// Every status the table's CHECK constraint accepts. Guards every write path.
export const VALID_STATUS = new Set(COLUMNS.map(c => c.key));

// Archives are chronological (newest closed on top), not hand-ranked: they sort
// by close date and refuse drag-reordering. See board-sort.js.
export const ARCHIVE_COLS = new Set(COLUMNS.filter(c => c.archive).map(c => c.key));

const TITLE = Object.fromEntries(COLUMNS.map(c => [c.key, c.title]));

// A status's display label; unknown keys read as themselves rather than blank,
// so a row written by a newer client never renders as an empty pill.
export function statusLabel(key) { return TITLE[key] || key; }
