// The Dash's route contract — the ONE list that says "these paths are Dash
// documents (serve the app shell), everything else under /dash/ is an asset."
//
// It exists because the Dash uses real path URLs (BrowserRouter, basename /dash)
// instead of hash routing, so a cold load or reload of `/dash/issues` has to be
// served the Dash entry, not the canvas. This module is the ONE runtime importer
// of the segment list — the shared dev/preview history fallback
// (`dash/server/history-fallback.mjs`, composed by both Vite hosts) calls
// isDashDocumentPath to rewrite these paths to the Dash entry before Vite's SPA
// fallback can serve the canvas. TWO other places must mirror the same segments
// by hand (they can't import a JS module) — when you add or rename a route, update
// all three:
//   • the client router (dash/src/main.jsx) — one <Route> per segment (imports
//     only DASH_BASENAME here, not the list; the JSX routes are the source of
//     truth for what actually renders);
//   • the production rewrite (vercel.json) — its `source` alternation must list
//     the same segments so a cold /dash/<seg> deep-link resolves on the host.
//
// Deterministic on purpose (no Accept-header / extension guessing): only these
// known segments — plus the bare basename — are Dash documents. `/dash/src`,
// `/dash/assets`, `/dash/@vite`, `/dash/gifs` fall through to real asset serving.
export const DASH_BASENAME = '/dash';
export const DASH_ROUTE_SEGMENTS = ['issues', 'tests', 'recordings', 'metrics'];

// Is `pathname` (query already stripped) a Dash document rather than an asset?
// True for `/dash`, `/dash/`, and `/dash/<seg>[/...]` where seg is a known route.
export function isDashDocumentPath(pathname) {
  if (pathname === DASH_BASENAME) return true;                 // /dash
  if (!pathname.startsWith(DASH_BASENAME + '/')) return false; // not under /dash/
  const rest = pathname.slice(DASH_BASENAME.length + 1);       // after "/dash/"
  if (rest === '') return true;                                // /dash/
  return DASH_ROUTE_SEGMENTS.includes(rest.split('/')[0]);     // /dash/<seg>/...
}
