// Isomorphic row→kanban-item shaping. ONE mapping of the `issues` row schema to
// the shape the board UI consumes, shared by:
//   - dash-issues.js (node): passes git-derived liveness as the second arg
//   - board-store.js (browser, model-A remote): omits it — no git on Vercel,
//     so cards simply render without the live-worktree dot. That absence IS the
//     correct remote behavior, not a bug.
// Keep this free of node imports (fs/child_process) so the browser bundle can
// import it.

const NO_LIVE = { live: false, live_pid: null, worktree_path: null };

// Shape a raw store row into the kanban item. `live` is the branch-liveness join
// (live/live_pid/worktree_path); it defaults to "not live" for callers with no
// git access. `body` is attached by detail callers, never here.
export function shapeRow(row, live = NO_LIVE) {
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
    port: row.port != null ? Number(row.port) : null,
    created: row.created || null,
    updated: row.updated_at || null,
    closed: row.closed_at || null,   // when it entered done/rejected (sorts the archive cols)
    order: row.rank != null ? Number(row.rank) : null,
    live: live.live,
    live_pid: live.live_pid,
    worktree_path: live.worktree_path,
    branch: branches[0] || null,
    kind: 'issue',
  };
}
