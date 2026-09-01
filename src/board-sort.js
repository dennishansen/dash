// Pure kanban ordering — no React, so it's unit-testable in node (see
// dash/board-sort.test.mjs) and shared by the display sort and the create/
// reorder paths in ChangesBoard.
//
// Both comparators are TOTAL orders: they end in an `id` tiebreak so two cards
// that are otherwise equal never compare 0. Without it, a tie leaves the pair's
// relative order to JS sort's input order (i.e. whatever PostgREST returned that
// fetch), so the cards swap on every refetch/renumber. This bit the only
// in-progress pair sharing a `created` date once a chat-driven status change
// collided their ranks (see issue kanban-card-swap-rank-tie).

export function recencyKey(i) { return i.created || ''; }

// Column order: explicit rank (set by drag) wins, unranked fall to the bottom,
// then created desc, then id (the total-order guard). Shared by the display sort
// and by the create path, which ranks a new card against the FULL column (not
// the filtered view).
export function columnCompare(a, z) {
  const ao = a.order == null ? Infinity : a.order;
  const zo = z.order == null ? Infinity : z.order;
  if (ao !== zo) return ao - zo;
  const byRecency = recencyKey(z).localeCompare(recencyKey(a));
  if (byRecency) return byRecency;
  return a.id.localeCompare(z.id);
}

// Done / Rejected are chronological archives, not hand-ranked queues: newest on
// top, by when the card was CLOSED (entered the column) — a stable timestamp
// that, unlike updated_at, doesn't churn when a done issue is edited. Falls back
// to updated/created for any pre-backfill row lacking a closed date, then id.
// WHICH columns are archives is a property of the column itself, declared with
// the rest of them in board-columns.mjs (ARCHIVE_COLS).
export function archiveCompare(a, z) {
  const byClosed = (z.closed || z.updated || z.created || '').localeCompare(a.closed || a.updated || a.created || '');
  if (byClosed) return byClosed;
  return a.id.localeCompare(z.id);
}

// The column's order AFTER a move, projected the way the server will actually
// perform it. `rows` is the FULL issue list, `status` the column being placed
// into, `moved` the cards travelling (in their intended relative order) and
// `after` the card they land behind — null meaning the top.
//
// This mirrors place_cards, which renumbers a column 0..n from its OWN rows: the
// only things that travel to the server are the moved cards and the anchor, so
// the only faithful local paint is the same computation over the same full
// column. Including the anchor-vanished case — an anchor no longer in the column
// puts the run at the end, which is what the server does when it can't find it
// either.
//
// Deriving the order from the full list is what lets the board be REORDERED
// UNDER A FILTER. The anchor is a visible card — whichever one the user sees the
// run landing below — but the order it renumbers is the whole column, hidden
// cards and all. Callers pass the gesture, never a snapshot, so a view showing a
// subset of its column cannot renumber that subset against the cards it hides.
export function placedOrder(rows, status, moved, after) {
  const travelling = new Set(moved);
  const rest = (rows || [])
    .filter(r => r.kind === 'issue' && r.status === status && !travelling.has(r.id))
    .sort(columnCompare)
    .map(r => r.id);
  // The three anchor cases, exactly as `placed_order` writes them:
  //   null, or an anchor that is itself moving  → the top (`p_after = any(p_ids)`)
  //   an anchor still in the column             → directly after it
  //   an anchor no longer in the column         → the end (it left underneath us)
  // indexOf -1 → 0 → falsy → rest.length covers the third.
  const at = (after == null || travelling.has(after)) ? 0 : (rest.indexOf(after) + 1 || rest.length);
  return [...rest.slice(0, at), ...moved, ...rest.slice(at)];
}
