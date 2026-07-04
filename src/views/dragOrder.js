// Pure geometry for kanban pointer-drag reordering, extracted so it can be
// unit-tested without a DOM. Given the vertical midpoints of the non-dragged
// cards (in top→bottom order) and the pointer's y, return the index at which
// the dragged card should be inserted among them.
//
//   pointer above every midpoint  → 0        (drop at top)
//   pointer below every midpoint  → length   (drop at bottom)
//   pointer past the first k mids  → k        (drop after those k)
//
// A pointer exactly on a midpoint inserts *before* that card (deterministic, no
// half-pixel flicker).
export function insertionIndex(midpoints, pointerY) {
  let i = 0;
  while (i < midpoints.length && pointerY > midpoints[i]) i++;
  return i;
}
