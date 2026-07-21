// People, in the browser — the roster every surface joins against.
//
// One fetch per session, held in a module-level map, read by every card through
// useSyncExternalStore (the same shape as activity-store). That's the whole
// point: an avatar on a kanban card must never be its own request, and there are
// hundreds of cards. The board, the detail, and the sidebar all read this one
// map; nothing below it knows how a profile is stored.
//
// The roster loads itself on sign-in (onAuth fires immediately with the current
// session) and clears on sign-out, so no view has to remember to prime it. A
// profile write refreshes the map and repaints in the same breath.

import React, { useState, useRef, useEffect, useSyncExternalStore } from 'react';
import * as store from '../server/profiles-store.mjs';
import { normalizeEmail, displayName, initial, tone, avatarRejection, avatarUrl } from '../server/profiles-store.mjs';
import { onAuth, userEmail } from './auth.js';

// Re-exported so every UI surface imports people-rendering from ONE place (this
// client layer) instead of half of them reaching past it into the store.
export { normalizeEmail, displayName, initial, tone, AVATAR_TYPES } from '../server/profiles-store.mjs';

// email → person row (allow-listed teammate + their profile decoration). The
// snapshot is a plain object rebuilt only on real change, so it stays
// referentially stable between changes (useSyncExternalStore caches by identity).
let snapshot = {};
const listeners = new Set();

function publish(next) {
  snapshot = next;
  for (const fn of listeners) fn();
}
function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function getSnapshot() { return snapshot; }

// Every known person, keyed by email. Empty until the roster loads (signed out,
// or the first fetch in flight) — every consumer renders sensibly from the email
// alone, so there is no loading state to thread through.
export function useProfiles() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

// The signed-in person's own row (or null). Re-renders when either the roster or
// the session changes.
export function useMyProfile() {
  const profiles = useProfiles();
  const [email, setEmail] = useState(() => userEmail());
  useEffect(() => onAuth(s => setEmail(s?.user?.email || null)), []);
  const key = normalizeEmail(email);
  return { email: key || null, profile: key ? profiles[key] || null : null };
}

// Which identity the roster belongs to. A fetch that started under a previous
// session must NOT land on top of the next one — signing out (or switching
// accounts) mid-flight would otherwise repopulate the board with the previous
// person's team. Every refresh records the epoch it began in and drops its own
// result if the epoch has moved on.
let epoch = 0;
let inFlight = null;
export async function refreshProfiles() {
  if (!inFlight) {
    const startedAt = epoch;
    const run = (async () => {
      try {
        const rows = await store.listPeople();
        if (startedAt !== epoch) return;      // identity changed under us
        const next = {};
        for (const r of rows) next[normalizeEmail(r.email)] = r;
        publish(next);
      } catch { /* roster unavailable — surfaces render from emails alone */ }
      // Only ever clear OUR OWN slot: a fetch retired by an identity change
      // lands after the next one has already started, and blindly nulling here
      // would drop the live fetch's slot and let a third caller duplicate it.
      finally { if (inFlight === run) inFlight = null; }
    })();
    inFlight = run;
  }
  return inFlight;
}

// Load on sign-in, clear on sign-out. onAuth fires once immediately with the
// current session, so this IS the initial load — no view primes the roster.
let identity = null;
onAuth((session) => {
  const email = normalizeEmail(session?.user?.email) || null;
  if (email === identity) return;           // token refresh, same person
  identity = email;
  epoch++;                                  // retires anything already in flight
  inFlight = null;
  if (email) refreshProfiles();
  else publish({});
});

// --- writes ------------------------------------------------------------------

// Save the signed-in person's display name. Empty clears it (back to the derived
// default), so "cleared" and "never set" are one state.
export async function saveDisplayName(email, name) {
  const clean = String(name || '').trim();
  const r = await store.upsert(email, { display_name: clean || null });
  await refreshProfiles();
  return r;
}

// Upload a new profile picture and point the row at it. Returns { error } for a
// picture the bucket would refuse, so the caller can say why in a sentence. The
// picture being replaced is deleted after the row moves on — a public object
// must never outlive the profile that pointed at it.
export async function saveAvatar(email, file) {
  const refusal = avatarRejection(file.type, file.size);
  if (refusal) return { error: refusal };
  // The key being replaced comes from the ROW, not the painted cache: the cache
  // can be a refresh behind, and deleting the wrong object is worse than
  // deleting none. Only after the row points somewhere else is the old object
  // safe to drop.
  const previous = (await store.get(email))?.avatar_key || null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const up = await store.uploadAvatar(email, bytes, file.type);
  if (up.error) return up;
  const r = await store.setAvatar(email, up.key);
  await refreshProfiles();
  if (!r.error && previous && previous !== up.key) await store.deleteAvatar(previous);
  return r;
}

export async function clearAvatar(email) {
  const previous = (await store.get(email))?.avatar_key || null;
  const r = await store.setAvatar(email, null);
  await refreshProfiles();
  if (!r.error && previous) await store.deleteAvatar(previous);
  return r;
}

// --- rendering ---------------------------------------------------------------

// One person, as small as a card can carry: their picture, or their initial on a
// tone derived from the email (deterministic — same person, same colour, every
// machine and every reload). Renders NOTHING without an email: an unowned issue
// shows no avatar rather than inventing a placeholder person.
export function Avatar({ email, size = 18, className = '', showTooltip = true }) {
  const profiles = useProfiles();
  const key = normalizeEmail(email);
  const [broken, setBroken] = useState(false);
  if (!key) return null;
  const profile = profiles[key] || null;
  const name = displayName(profile, key);
  const url = broken ? null : avatarUrl(profile);
  const style = { width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.46)) };
  return (
    <span
      className={`avatar${url ? ' avatar--photo' : ''} ${className}`.trim()}
      style={style}
      data-tone={url ? undefined : tone(key)}
      title={showTooltip ? name : undefined}
      aria-label={name}
    >
      {url
        // A dead URL (bucket object removed) falls back to the initial rather
        // than a broken-image glyph.
        ? <img src={url} alt="" onError={() => setBroken(true)} />
        : initial(profile, key)}
    </span>
  );
}

// Avatar + name, the way a person reads in a property row or the sidebar.
export function PersonLabel({ email, size = 18 }) {
  const profiles = useProfiles();
  const key = normalizeEmail(email);
  if (!key) return null;
  return (
    <>
      <Avatar email={key} size={size} showTooltip={false} />
      <span className="person-name">{displayName(profiles[key] || null, key)}</span>
    </>
  );
}

// The roster as a sorted list — the owner picker's options, and anywhere else
// "who is on this board" is a question.
export function usePeople() {
  const profiles = useProfiles();
  return Object.values(profiles)
    .map(p => ({ email: normalizeEmail(p.email), name: displayName(p, p.email), profile: p }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Click-outside + Escape close for the small popovers below (profile editor,
// owner picker). One hook so both behave identically.
export function useDismiss(open, close) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!ref.current?.contains(e.target)) close(); };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open, close]);
  return ref;
}
