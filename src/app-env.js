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
