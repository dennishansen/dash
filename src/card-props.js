// Which properties trail a card on the board (and a row in list view), and in
// what order — the "display properties" choice behind the eye button beside the
// filter toggle. It is a VIEW preference, not issue data: one ordered list,
// shared by the menu and every card, persisted per browser like the view mode
// and the collapsed columns. Owner alone is shown by default, and sits LAST —
// a card is already dense, so who holds it is the one property worth a
// permanent glance, and it reads against the card's right edge.
import { useEffect, useState } from 'react';

const KEY = 'dash-card-props';

// The catalogue: every property that reads at a glance on one line (anything
// longer belongs on the issue's own page). This array is only the definition —
// the ORDER properties render in is the stored order below, which the menu lets
// you drag.
export const CARD_PROPS = [
  { key: 'tags', label: 'Tags' },
  { key: 'id', label: 'ID' },
  { key: 'created', label: 'Created' },
  { key: 'updated', label: 'Updated' },
  { key: 'owner', label: 'Owner' },
];
export const DEFAULT_ORDER = CARD_PROPS.map(p => p.key);
export const DEFAULT_SHOWN = ['owner'];

const KEYS = new Set(DEFAULT_ORDER);
const listeners = new Set();

// Order is always the FULL catalogue, so a hidden property keeps its place for
// when it's switched back on. Unknown keys (an older catalogue) drop out;
// missing ones append in catalogue order, so adding a property never strands a
// stored preference.
function normalizeOrder(list) {
  const kept = (Array.isArray(list) ? list : []).filter(k => KEYS.has(k));
  const seen = new Set(kept);
  return [...new Set([...kept, ...DEFAULT_ORDER.filter(k => !seen.has(k))])];
}

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    // The preference used to be a bare array of shown keys, before order was a
    // thing — read it as "these are shown, catalogue order".
    if (Array.isArray(raw)) return { order: DEFAULT_ORDER, shown: new Set(raw.filter(k => KEYS.has(k))) };
    if (raw && typeof raw === 'object') {
      return {
        order: normalizeOrder(raw.order),
        shown: new Set((Array.isArray(raw.shown) ? raw.shown : DEFAULT_SHOWN).filter(k => KEYS.has(k))),
      };
    }
  } catch { /* private mode / corrupt value */ }
  return { order: DEFAULT_ORDER, shown: new Set(DEFAULT_SHOWN) };
}

let state = read();

function commit(next) {
  state = next;
  try { localStorage.setItem(KEY, JSON.stringify({ order: next.order, shown: [...next.shown] })); }
  catch { /* private mode */ }
  for (const fn of listeners) fn(next);
}

export function toggleCardProp(key) {
  const shown = new Set(state.shown);
  shown.has(key) ? shown.delete(key) : shown.add(key);
  commit({ ...state, shown });
}

// Drag-reorder from the menu. `keys` is the full catalogue in its new order.
export function reorderCardProps(keys) {
  commit({ ...state, order: normalizeOrder(keys) });
}

// Subscribe a component to the choice. Every card reads this directly rather
// than being handed it down the column tree, so toggling or reordering repaints
// the whole board without threading a prop through two layers of layout.
export function useCardProps() {
  const [v, setV] = useState(state);
  useEffect(() => {
    listeners.add(setV);
    setV(state);
    return () => listeners.delete(setV);
  }, []);
  return v;
}
