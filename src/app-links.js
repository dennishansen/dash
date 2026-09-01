// Where the MAIN env's App-pane links live.
//
// An issue keeps both of its link facts on its row — `app_path` (the selected
// route) and `app_paths` (the custom ones) — so every machine sees the same
// pane. MAIN has no row: it is this origin, not an issue, and the dash has no
// table of per-user settings. So its two facts are browser preferences, the same
// shape as the App/Code segment next to them. Everything ABOVE this module
// treats both envs identically; only these four functions know the difference.
import { normalizeAppPath } from './app-env.mjs';

const PATH_KEY = 'dash-app-path-main';   // MAIN's selected route
const LINKS_KEY = 'dash-app-links-main'; // MAIN's custom routes, in saved order

export function loadMainPath() {
  try { return normalizeAppPath(localStorage.getItem(PATH_KEY)); }
  catch { return '/'; }
}

export function saveMainPath(path) {
  try { localStorage.setItem(PATH_KEY, normalizeAppPath(path)); } catch { /* private mode: skip */ }
}

export function loadMainLinks() {
  try {
    const raw = JSON.parse(localStorage.getItem(LINKS_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((p) => typeof p === 'string') : [];
  } catch { return []; }
}

export function saveMainLinks(links) {
  try { localStorage.setItem(LINKS_KEY, JSON.stringify(links)); } catch { /* private mode: skip */ }
}
