// One source of truth for "the running app's URL for env X". The MAIN env is the
// canvas at this origin (`/`); an issue env is that worktree's app, reached
// through the lazy-start `/open` redirect (a same-origin path that 302s to the
// worktree's vite port — so pointing an iframe at it gets BOTH the dev-server
// start AND the hop to the live port for free). The app panel's iframe and its
// navbar host label both resolve the app through here so they can never drift.
export const MAIN_ENV = 'main';

// The URL that loads env's running app. Same-origin, so it works directly as the
// app panel's iframe src.
export function appUrlForEnv(env) {
  return env === MAIN_ENV ? '/' : `/api/dash/terminal/${encodeURIComponent(env)}/open`;
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
// `/dash/#/tests` is legitimate); the server merges its cache-bust correctly.
export function normalizeAppPath(path) {
  const p = (path ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!p || p === '/') return '/';
  return `/${p.replace(/^[/\\]+/, '')}`;
}
