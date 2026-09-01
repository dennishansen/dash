// The last successful payload per URL, surviving unmount — the reason a view can
// repaint the instant you come back to it instead of flashing a spinner while it
// refetches what it already had. Stale-while-revalidate: paint the cached value
// at once, let the poll behind it refresh, swap when fresh data lands. That's
// what keeps it honest — nothing here is served without a refresh chasing it.
//
// Two properties its callers depend on, which is why this is a store and not a
// Map inlined into the hook:
//
//   Bounded. Whole file contents live in here now, not just small board
//   payloads, so a browsing session would otherwise accumulate every file it
//   ever opened. Past CAP the least-recently-used entry goes.
//
//   Identity-stable. A poll whose payload is unchanged hands back the SAME
//   object it handed back last time, so React sees no new props — without this,
//   an endpoint polled every 3s republishes deep-equal data forever and the code
//   pane rebuilds a Monaco editor over a file that did not change.

import { touch, trim } from './lru.js';

const CAP = 64;
const payloads = new Map(); // url → last accepted payload, in least-recently-used order

export function has(url) { return payloads.has(url); }

// Pure — hooks call this while rendering, and a render that reordered the cache
// would be a side effect in the one place React requires there be none. Fetching
// is what counts as using a url, and a url on screen is a url being polled, so
// `store` below is the only thing that has to move an entry.
export function read(url) { return payloads.get(url); }

// Accept a fetch result and return what should be PAINTED: the incoming value,
// or the one already held when the two are structurally the same.
export function store(url, value) {
  const held = payloads.get(url);
  const kept = touch(payloads, url, held !== undefined && same(held, value) ? held : value);
  trim(payloads, CAP);
  return kept;
}

// Structural equality over JSON values — the only shape that crosses this
// boundary. Arrays compare through Object.keys (indices) like any other object.
export function same(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !same(a[key], b[key])) return false;
  }
  return true;
}

// Test seam: the cache is module state shared by every hook instance, so a test
// that wants a cold start says so rather than reaching into the Map.
export function clear() { payloads.clear(); }

export const CAPACITY = CAP;
