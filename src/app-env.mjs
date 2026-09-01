// One source of truth for "the running app's URL for env X". The MAIN env is the
// canvas at this origin (`/`); an issue env is that worktree's app, reached
// through the lazy-start `/open` redirect (a same-origin path that 302s to the
// worktree's vite port — so pointing an iframe at it gets BOTH the dev-server
// start AND the hop to the live port for free). The app panel's iframe and its
// navbar host label both resolve the app through here so they can never drift.
export const MAIN_ENV = 'main';

// The URL that loads env's running app on `appPath`. Same-origin, so it works
// directly as the app panel's iframe src. An issue env resolves its route
// SERVER-side — /open reads the stored app_path off the row and redirects onto
// it — so the path is not in the URL there; MAIN is this origin, so its route is
// simply the path itself.
export function appUrlForEnv(env, appPath = '/') {
  return env === MAIN_ENV ? normalizeAppPath(appPath) : `/api/dash/terminal/${encodeURIComponent(env)}/open`;
}

// The routes every dev server in this repo serves, so they need no storage: the
// canvas and the dash. Every env's link list starts here.
export const BASE_APP_PATHS = ['/', '/dash/'];

// An env's full ordered link list: the base set, then its saved custom routes,
// then the selected route if it is neither. Normalized and deduped, so a custom
// entry can never shadow a base one — and the selected route is ALWAYS in the
// list, which is what makes "step to the next link" total rather than a lookup
// that can miss.
export function appLinkList(custom, selected) {
  const out = [];
  const seen = new Set();
  for (const raw of [...BASE_APP_PATHS, ...(Array.isArray(custom) ? custom : []), selected]) {
    if (raw == null) continue;
    const p = normalizeAppPath(raw);
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

// Is this route one of the base three? Base links are the floor of every list —
// they can be selected but not removed.
export function isBaseAppPath(path) {
  return BASE_APP_PATHS.includes(normalizeAppPath(path));
}

// The port shown on the link. Main shows this origin's port (the canvas);
// an issue shows its reserved worktree port (passed in from the board cache).
export function appPortForEnv(env, port) {
  return env === MAIN_ENV ? window.location.port : port;
}

// Interpret a stored app-view path into the route the iframe should land on.
// One rule, shared by the /open redirect (server), board.mjs (CLI), and the
// App-pane path control (browser), so the three can never disagree on what a
// stored value means.
//
// Two guarantees that keep it a same-origin PATH, never a way off-host:
//   • collapse ALL leading slashes AND backslashes to exactly one `/` — so a
//     stored `//host`, `/\host`, or `\\host` resolves to `/host` on our origin,
//     never protocol-relative (the WHATWG URL parser treats `\` as `/`).
//   • strip C0 control chars and DEL — a raw CR/LF in a value that lands in a
//     302 `Location` header would be response-splitting; nothing routable needs
//     them. (The server ALSO rebuilds the redirect through the URL API, which
//     percent-encodes anything left — belt and suspenders.)
// null / '' / '/' all mean the canvas root. Query/hash are preserved (a stored
// `/dash/issues?tag=x` is legitimate); the server merges its cache-bust correctly.
export function normalizeAppPath(path) {
  const p = (path ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!p || p === '/') return '/';
  return `/${p.replace(/^[/\\]+/, '')}`;
}
