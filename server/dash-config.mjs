// Supabase configuration — the ONE place "which project + which keys" is read.
//
// This module is isomorphic: it runs in node (the CLI, the dev middleware) AND
// in the browser bundle (the board reads/writes Supabase directly). The two
// environments expose config differently, so we read from both, in order:
//
//   1. process.env                  — node (CLI, dev server, tests)
//   2. Vite-injected build defines  — browser (see vite.config.js `define`)
//
// There are NO hardcoded fallbacks. "Bring your own Supabase" is real: if you
// don't set the env vars, the values are empty and the app tells you so instead
// of silently talking to someone else's project.
//
// Env vars (see .env.example):
//   DASH_SUPABASE_URL          project URL, e.g. https://xxxx.supabase.co
//   DASH_SUPABASE_ANON_KEY     public anon/publishable key (identifies project)
//   DASH_SUPABASE_SERVICE_KEY  service-role key — NODE ONLY, never shipped to
//                              the browser. Bypasses RLS for server-side writes.

// Node env, guarded (no `process` in the browser).
const NODE_ENV = (typeof process !== 'undefined' && process.env) || {};

// Vite replaces these identifiers at build time with the string literals from
// `define` in vite.config.js. In node they are never defined, so the `typeof`
// guard yields undefined instead of a ReferenceError. In the browser build Vite
// substitutes the configured project values (service key deliberately omitted).
const BUILD_URL =
  typeof __DASH_SUPABASE_URL__ !== 'undefined' ? __DASH_SUPABASE_URL__ : '';
const BUILD_ANON =
  typeof __DASH_SUPABASE_ANON_KEY__ !== 'undefined' ? __DASH_SUPABASE_ANON_KEY__ : '';

export const SUPABASE_URL = NODE_ENV.DASH_SUPABASE_URL || BUILD_URL || '';
export const SUPABASE_ANON = NODE_ENV.DASH_SUPABASE_ANON_KEY || BUILD_ANON || '';

// Service key is node-only. It is NEVER injected into the browser build (the
// vite.config `define` deliberately omits it), so this resolves to null in the
// browser — exactly right: the browser must use the signed-in user's JWT, never
// a service key.
export const SUPABASE_SERVICE = NODE_ENV.DASH_SUPABASE_SERVICE_KEY || null;

// A loud, shared guard so a misconfigured project fails with a clear message.
export function assertConfigured() {
  if (!SUPABASE_URL || !SUPABASE_ANON) {
    throw new Error(
      'Dash is not configured: set DASH_SUPABASE_URL and DASH_SUPABASE_ANON_KEY ' +
      '(see .env.example). Bring your own Supabase project.',
    );
  }
}
