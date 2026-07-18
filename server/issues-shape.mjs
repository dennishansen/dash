// Isomorphic row→kanban-item shaping. ONE mapping of the `issues` row schema to
// the shape the board UI consumes, shared by dash-issues.js (node) and
// board-store.js (browser). Pure: cards render purely from stored fields — the
// board no longer joins any git-derived branch liveness (that scan was the dash
// terminal-freeze cause). Keep this free of node imports so the browser bundle
// can import it. `body` is attached by detail callers, never here.
export function shapeRow(row) {
  const branches = Array.isArray(row.branches) ? row.branches : [];
  return {
    id: row.id,
    title: row.title || row.id,
    status: row.status,
    owner: row.owner ?? null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    branches,
    sessions: Array.isArray(row.sessions) ? row.sessions : [],
    commits: Array.isArray(row.commits) ? row.commits : [],
    conversations: Array.isArray(row.conversations) ? row.conversations : [],
    requires: Array.isArray(row.requires) ? row.requires : [],
    unlocks: Array.isArray(row.unlocks) ? row.unlocks : [],
    port: row.port != null ? Number(row.port) : null,
    // The App-pane target path (null = '/', the canvas). Stored beside `port`;
    // the /open redirect lands the iframe on localhost:<port><app_path>.
    app_path: row.app_path ?? null,
    created: row.created || null,
    updated: row.updated_at || null,
    closed: row.closed_at || null,   // when it entered done/rejected (sorts the archive cols)
    order: row.rank != null ? Number(row.rank) : null,
    branch: branches[0] || null,
    kind: 'issue',
  };
}
