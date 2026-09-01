// Email one-time-code sessions against Supabase GoTrue — the shared half of
// every door this project has.
//
// Two surfaces sign people in. The Dash (dash/src/auth.js) admits the TEAM,
// checked against dash_allowed_emails. The Artifact app (src/access/access.js)
// admits approved PREVIEW USERS, checked against app_access. They gate on
// different lists and hold separate sessions on purpose — being let into the
// product must not hand anyone the issues board, and one door breaking must not
// break the other. But the GoTrue machinery underneath is identical: email a
// code, exchange it for a session, persist it, refresh it before it expires.
// That machinery lives here once, keyed by the storage slot its caller owns, so
// the two doors cannot drift apart.
//
// Plain fetch, no @supabase/* client — same reason as supabase.mjs next door: a
// fresh clone needs no install step. Browser-only (localStorage); node tools use
// the service key and never sign in.

import { URL as SUPA_URL, ANON } from './supabase.mjs';

const AUTH = `${SUPA_URL}/auth/v1`;

// GoTrue returns expires_in (seconds); pin an absolute expiry so refresh logic
// is clock-relative, not request-relative.
function stamp(s) {
  return { ...s, expires_at: s.expires_at || (now() + (s.expires_in || 3600)) };
}
function now() { return Math.floor(Date.now() / 1000); }
function normalize(email) { return String(email || '').trim().toLowerCase(); }

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

// One door's session. `storageKey` is the localStorage slot it owns; `onChange`
// fires on every transition INCLUDING construction, so a caller that has to
// mirror the token somewhere else (the Dash pushes it into its PostgREST store)
// is correct before it makes its first request.
export function createOtpSession({ storageKey, onChange = null }) {
  const listeners = new Set();
  let session = read();

  function read() {
    try { return JSON.parse(localStorage.getItem(storageKey) || 'null'); }
    catch { return null; }
  }

  function persist(next) {
    session = next;
    if (next) localStorage.setItem(storageKey, JSON.stringify(next));
    else localStorage.removeItem(storageKey);
    onChange?.(next);
    for (const fn of listeners) fn(next);
  }

  onChange?.(session);

  return {
    current: () => session,
    email: () => session?.user?.email || null,
    token: () => session?.access_token || null,

    // Fires once immediately with the current value, then on every change.
    subscribe(fn) {
      listeners.add(fn);
      fn(session);
      return () => listeners.delete(fn);
    },

    // Email a code. create_user:true so a first-time arrival is provisioned on
    // first sign-in — owning the address is all this proves; the caller's own
    // list is what decides whether they may enter.
    async requestCode(email) {
      await gotrue('/otp', { email: normalize(email), create_user: true });
      return { ok: true };
    },

    // Exchange the code for a session and hold it. The caller checks its list
    // NEXT and calls signOut() to roll back a session that may not enter.
    async verifyCode(email, code) {
      const s = await gotrue('/verify', { type: 'email', email: normalize(email), token: String(code).trim() });
      if (!s?.access_token) throw new Error('no session returned');
      persist(stamp(s));
      return s;
    },

    // Install a session minted elsewhere (the Dash's local dev-session route).
    adopt(next) { persist(next ? stamp(next) : null); },

    signOut() { persist(null); },

    // A valid access token, refreshing first if it's about to expire. Returns
    // null when signed out or when the refresh is rejected — either way the
    // session is cleared, so the gate re-renders instead of hanging on a token
    // the server no longer honors.
    async ensureFreshToken() {
      if (!session) return null;
      if (session.expires_at && session.expires_at - now() < 60) {
        try {
          const s = await gotrue('/token?grant_type=refresh_token', { refresh_token: session.refresh_token });
          if (s?.access_token) persist(stamp(s));
          else persist(null);
        } catch { persist(null); }
      }
      return session?.access_token || null;
    },

    // One PostgREST rpc carrying this door's identity — the user's token once
    // signed in, the bare anon key before that (which is what makes an
    // anon-callable rpc like request_app_access reachable from the door).
    async rpc(name, body = {}) {
      const res = await fetch(`${SUPA_URL}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: {
          apikey: ANON,
          Authorization: `Bearer ${session?.access_token || ANON}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { /* not json */ }
        throw new Error(parsed?.message || `rpc ${name} → ${res.status}`);
      }
      return text ? JSON.parse(text) : null;
    },
  };
}
