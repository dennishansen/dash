// Dash auth — the TEAM's door.
//
// Why this exists: the board reads/writes Supabase directly from the browser
// (board-store.js), and on a PUBLIC deploy the committed anon key alone must
// NOT be able to touch the `issues` table. So every browser session signs in
// with email + a 6-digit code; the resulting access token is what RLS checks
// (authenticated + allow-listed email — see the dash_allowed_emails table).
// Node tools (board.mjs, the dev middleware) use the service key instead and
// bypass RLS entirely.
//
// The GoTrue mechanics — request a code, verify it, persist and refresh the
// session — are shared with the app's preview door and live in
// dash/server/supabase-otp.mjs. What is Dash-specific and stays here: the
// storage slot, pushing the live token into the PostgREST store, the
// dash_email_allowed check at sign-in, and the local dev-session shortcut.

import { setAuthToken } from '../server/supabase.mjs';
import { createOtpSession } from '../server/supabase-otp.mjs';

// onChange fires at construction too, so the store carries whatever session was
// in localStorage before any board call goes out.
const door = createOtpSession({
  storageKey: 'dash-auth-session',
  onChange: (s) => setAuthToken(s?.access_token || null),
});

// Local-dev convenience: when there's no stored session AND a local /api/dash
// backend is answering, mint a dev session from it (service token) so localhost
// preview links don't demand a login on every visit. On Vercel there is no
// /api/dash route, so the fetch 404s and this is a no-op — production stays
// gated. Resolves regardless of outcome so the App can gate render on it.
export async function ensureDevSession() {
  if (door.current()) return door.current();
  try {
    const res = await fetch('/api/dash/dev-session', { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const s = await res.json();
    if (s?.access_token) { door.adopt(s); return door.current(); }
  } catch { /* no local backend — remote stays gated */ }
  return null;
}

export const requestCode = (email) => door.requestCode(email);

// Exchange the code for a session, then enforce the allow-list at the door:
// getting a valid code proves you own the email, but only allow-listed emails
// may actually enter. A non-allow-listed sign-in is rolled back immediately so
// they never reach the board (RLS would show them nothing anyway — this just
// makes the rejection explicit instead of a silent empty board).
export async function verifyCode(email, code) {
  const s = await door.verifyCode(email, code);
  if (!(await isAllowed())) {
    door.signOut();
    throw new Error('This email isn’t allowed to access Dash.');
  }
  return s;
}

// Ask the database (SECURITY DEFINER rpc) whether the signed-in email is on the
// allow-list. Uses the user's token, so it answers for the current session.
async function isAllowed() {
  try { return (await door.rpc('dash_email_allowed')) === true; }
  catch { return false; }
}

export const signOut = () => door.signOut();
export const currentSession = () => door.current();
export const userEmail = () => door.email();

// Subscribe to session changes (sign-in / sign-out / refresh). Fires once
// immediately with the current value.
export const onAuth = (fn) => door.subscribe(fn);

// A valid access token, refreshing first if it's about to expire. Returns null
// when signed out. Board calls don't need to await this (the store already has
// the token); it's here for the gate to keep the session warm.
export const ensureFreshToken = () => door.ensureFreshToken();
