// Dash auth — email one-time-code, raw fetch against Supabase GoTrue.
//
// Why this exists: the board reads/writes Supabase directly from the browser
// (board-store.js), and on a PUBLIC deploy the committed anon key alone must
// NOT be able to touch the `issues` table. So every browser session signs in
// with email + a 6-digit code; the resulting access token is what RLS checks
// (authenticated + allow-listed email — see the dash_allowed_emails table).
// Node tools (board.mjs, the dev middleware) use the service key instead and
// bypass RLS entirely.
//
// No @supabase/supabase-js: the store is deliberately dependency-free (a fresh
// clone needs no install), so auth is plain fetch too. OTP *code* flow (not a
// magic link) keeps it a single-page interaction — no redirect URLs to
// allow-list, no hash parsing.
//
//   request(email)        POST /auth/v1/otp     → Supabase emails a code
//   verify(email, code)   POST /auth/v1/verify  → { access_token, refresh_token, … }
//   refresh()             POST /auth/v1/token?grant_type=refresh_token
//
// The session is persisted in localStorage and refreshed lazily when the access
// token is within a minute of expiry. setAuthToken() pushes the live token into
// the store so its PostgREST calls carry the user's JWT.

import { URL as SUPA_URL, ANON, setAuthToken } from '../server/supabase.mjs';

const AUTH = `${SUPA_URL}/auth/v1`;
const LS_KEY = 'dash-auth-session';

const listeners = new Set();
let session = load();

function load() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); }
  catch { return null; }
}
function persist(s) {
  session = s;
  if (s) localStorage.setItem(LS_KEY, JSON.stringify(s));
  else localStorage.removeItem(LS_KEY);
  // Push the token into the store so board writes carry the user's JWT.
  setAuthToken(s?.access_token || null);
  for (const fn of listeners) fn(s);
}

// Apply whatever we loaded at module init (token into the store), before any
// board call fires.
setAuthToken(session?.access_token || null);

// Local-dev convenience: when there's no stored session AND a local /api/dash
// backend is answering, mint a dev session from it (service token) so localhost
// preview links don't demand a login on every visit. On Vercel there is no
// /api/dash route, so the fetch 404s and this is a no-op — production stays
// gated. Resolves regardless of outcome so the App can gate render on it.
export async function ensureDevSession() {
  if (session) return session;
  try {
    const res = await fetch('/api/dash/dev-session', { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const s = await res.json();
    if (s?.access_token) { persist(stamp(s)); return session; }
  } catch { /* no local backend — remote stays gated */ }
  return null;
}

async function gotrue(path, body) {
  const res = await fetch(`${AUTH}${path}`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(json?.msg || json?.error_description || json?.error || `auth ${res.status}`);
  }
  return json;
}

// Email a one-time code. create_user:true so a first-time allow-listed teammate
// is provisioned on first sign-in (RLS still gates what they can touch).
export async function requestCode(email) {
  await gotrue('/otp', { email: normalize(email), create_user: true });
  return { ok: true };
}

// Exchange the code for a session, then enforce the allow-list at the door:
// getting a valid code proves you own the email, but only allow-listed emails
// may actually enter. A non-allow-listed sign-in is rolled back immediately so
// they never reach the board (RLS would show them nothing anyway — this just
// makes the rejection explicit instead of a silent empty board).
export async function verifyCode(email, code) {
  const s = await gotrue('/verify', { type: 'email', email: normalize(email), token: code.trim() });
  if (!s?.access_token) throw new Error('no session returned');
  persist(stamp(s));
  if (!(await isAllowed())) {
    persist(null);
    throw new Error('This email isn’t allowed to access Dash.');
  }
  return s;
}

// Ask the database (SECURITY DEFINER rpc) whether the signed-in email is on the
// allow-list. Uses the user's token, so it answers for the current session.
async function isAllowed() {
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/rpc/dash_email_allowed`, {
      method: 'POST',
      headers: { apikey: ANON, Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    return res.ok && (await res.json()) === true;
  } catch { return false; }
}

export function signOut() { persist(null); }

export function currentSession() { return session; }
export function userEmail() { return session?.user?.email || null; }

// Subscribe to session changes (sign-in / sign-out / refresh). Fires once
// immediately with the current value.
export function onAuth(fn) {
  listeners.add(fn);
  fn(session);
  return () => listeners.delete(fn);
}

// A valid access token, refreshing first if it's about to expire. Returns null
// when signed out. Board calls don't need to await this (the store already has
// the token); it's here for the gate to keep the session warm.
export async function ensureFreshToken() {
  if (!session) return null;
  if (session.expires_at && session.expires_at - now() < 60) {
    try {
      const s = await gotrue(`/token?grant_type=refresh_token`, { refresh_token: session.refresh_token });
      if (s?.access_token) persist(stamp(s));
      else persist(null); // refresh rejected → force re-auth
    } catch { persist(null); }
  }
  return session?.access_token || null;
}

// GoTrue returns expires_in (seconds); pin an absolute expiry so refresh logic
// is clock-relative, not request-relative.
function stamp(s) {
  return { ...s, expires_at: s.expires_at || (now() + (s.expires_in || 3600)) };
}
function now() { return Math.floor(Date.now() / 1000); }
function normalize(email) { return String(email || '').trim().toLowerCase(); }
