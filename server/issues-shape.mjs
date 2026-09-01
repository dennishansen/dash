// Isomorphic row→kanban-item shaping. ONE mapping of the `issues` row schema to
// the shape the board UI consumes, shared by dash-issues.js (node) and
// board-store.js (browser). Pure: cards render purely from stored fields — the
// board no longer joins any git-derived branch liveness (that scan was the dash
// terminal-freeze cause). Keep this free of node imports so the browser bundle
// can import it. `body` is attached by detail callers, never here.
import { readChatMeta } from './issues-store.mjs';

export function shapeRow(row) {
  const branches = Array.isArray(row.branches) ? row.branches : [];
  return {
    id: row.id,
    title: row.title || row.id,
    status: row.status,
    owner: row.owner ?? null,
    // Who filed the issue — immutable historical provenance, ALWAYS a human
    // (git identity for CLI creates, the signed-in email for browser creates).
    // No FK, unlike owner: a frozen snapshot that survives the creator leaving
    // the team. Null on pre-column rows (never backfilled by guess).
    created_by: row.created_by ?? null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    branches,
    sessions: Array.isArray(row.sessions) ? row.sessions : [],
    conversations: Array.isArray(row.conversations) ? row.conversations : [],
    // Per-chat metadata (name + whose computer it lives on), keyed by full
    // session uuid. Rides beside conversations[]; {} = nothing recorded yet.
    chat_meta: readChatMeta(row),
    requires: Array.isArray(row.requires) ? row.requires : [],
    unlocks: Array.isArray(row.unlocks) ? row.unlocks : [],
    port: row.port != null ? Number(row.port) : null,
    // The App-pane target path (null = '/', the canvas). Stored beside `port`;
    // the /open redirect lands the iframe on localhost:<port><app_path>. It is
    // the SELECTED route — one of the pane's links, like selected_session is one
    // of the chats.
    app_path: row.app_path ?? null,
    // The extra routes saved for this issue's App pane, beyond the base set every
    // dev server serves. The address bar's dropdown and ⌃/⌄ steppers move
    // between base ∪ these.
    app_paths: Array.isArray(row.app_paths) ? row.app_paths : [],
    // The EXPLICIT chat to open for this issue (null = never selected). Source of
    // truth for the switcher's auto-open and the board's attach-only-selected
    // seed; written on switch / non-reviewer chat create, never by a reviewer.
    selected_session: row.selected_session ?? null,
    created: row.created || null,
    // The DB insert timestamp — the reliable "when created" (the legacy `created`
    // date column above is often null). Surfaced as a read-only detail property
    // and as an optional card property, so LIST_COLS carries it too.
    created_at: row.created_at || null,
    updated: row.updated_at || null,
    closed: row.closed_at || null,   // when it entered done/rejected (sorts the archive cols)
    order: row.rank != null ? Number(row.rank) : null,
    branch: branches[0] || null,
    kind: 'issue',
  };
}
