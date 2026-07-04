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

// Column order: explicit rank (set by drag) wins, unranked fall to the bottom —
// live cards first among ties, then created desc, then id (the total-order
// guard). Shared by the display sort and by the create path, which ranks a new
// card against the FULL column (not the filtered view).
export function columnCompare(a, z) {
  const ao = a.order == null ? Infinity : a.order;
  const zo = z.order == null ? Infinity : z.order;
  if (ao !== zo) return ao - zo;
  if (!!a.live !== !!z.live) return a.live ? -1 : 1;
  const byRecency = recencyKey(z).localeCompare(recencyKey(a));
  if (byRecency) return byRecency;
  return a.id.localeCompare(z.id);
}

// Done / Rejected are chronological archives, not hand-ranked queues: newest on
// top, by when the card was CLOSED (entered the column) — a stable timestamp
// that, unlike updated_at, doesn't churn when a done issue is edited. Falls back
// to updated/created for any pre-backfill row lacking a closed date, then id.
export function archiveCompare(a, z) {
  const byClosed = (z.closed || z.updated || z.created || '').localeCompare(a.closed || a.updated || a.created || '');
  if (byClosed) return byClosed;
  return a.id.localeCompare(z.id);
}

export const ARCHIVE_COLS = new Set(['done', 'rejected']);
