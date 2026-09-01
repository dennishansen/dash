// A Map used as a least-recently-used store. Map iterates in insertion order, so
// re-inserting an entry on every use makes that order the USE order: the oldest
// use sits at the front, the freshest at the end, and trimming means walking
// forward until the map fits.
//
// Two stores on the code path want exactly this and nothing more — the payload
// cache behind the fetch hook, and the Monaco model registry — so the policy
// lives once. They differ only in what "still in use" means and what it costs to
// let go, which is what the two callbacks are for: a model showing on screen is
// not the cache's to dispose, and a model that IS dropped has to be disposed
// rather than merely forgotten.

export function touch(map, key, value) {
  map.delete(key);
  map.set(key, value);
  return value;
}

export function trim(map, cap, { inUse = () => false, release = () => {} } = {}) {
  for (const [key, value] of map) {
    if (map.size <= cap) break;
    if (inUse(value)) continue;
    map.delete(key);
    release(value);
  }
}
