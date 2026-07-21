// Profiles store — who the people on the board are.
//
// Two things, deliberately separate:
//
//   `dash_people` (READ)  — the team. The allow-list left-joined to profiles, so
//                           membership has exactly one authority: revoke someone
//                           and they leave the owner picker in the same instant.
//   `dash_profiles` (WRITE) — what a person looks like. Display name + avatar,
//                           keyed by the SAME email auth issues and the
//                           allow-list gates on. Decoration; it grants nothing.
//
// That key is the design: `issues.owner` holds an email (with a foreign key to
// the allow-list), so owner → person is an exact lookup rather than a name
// match, and renaming yourself repaints every card without touching one issue.
// Everything on a profile is optional — a teammate who has never opened their
// profile still renders as their email's local part on a coloured initial.
//
// Isomorphic like issues-store: node tools (board.mjs, the dev middleware) and
// the browser bundle both import it, over the shared connection in supabase.mjs.

import {
  rest, restUrl, publicUrl, putObject, deleteObjects, sha256Hex, ObjectExistsError,
} from './supabase.mjs';

const ENV = (typeof process !== 'undefined' && process.env) || {};

// WHICH tables — the same isolation axis as issues/issues_test. Dash tests write
// real profile rows, so without a clone a fixture person's name and picture
// would land on the live board. Selected by ARTIFACT_PROFILES_TABLE in node; in
// the browser the dev server bakes its selection into the bundle via the
// __ARTIFACT_PROFILES_TABLE__ define (vite.config.js). The allow-list is NOT
// cloned — membership is real either way, so tests decorate real teammates.
export const TABLE = ENV.ARTIFACT_PROFILES_TABLE
  || (typeof __ARTIFACT_PROFILES_TABLE__ !== 'undefined' ? __ARTIFACT_PROFILES_TABLE__ : null)
  || 'dash_profiles';
// The roster view that reads each profiles table — an exact pair, not a derived
// name, so an unknown table fails loudly here instead of querying a view that
// doesn't exist.
const PEOPLE_VIEWS = { dash_profiles: 'dash_people', dash_profiles_test: 'dash_people_test' };
export const PEOPLE_VIEW = PEOPLE_VIEWS[TABLE];
if (!PEOPLE_VIEW) {
  throw new Error(`profiles-store: no roster view for table "${TABLE}" (expected one of ${Object.keys(PEOPLE_VIEWS).join(', ')})`);
}

const REST = restUrl(TABLE);
const PEOPLE = restUrl(PEOPLE_VIEW);
const AVATARS_BUCKET = 'dash-avatars';
const enc = encodeURIComponent;

// Emails are compared and stored lowercase everywhere — the RLS policies, the
// storage folder hash, and `issues.owner` all key on this exact form, so there
// is one spelling of a person and no case-folding guesswork at the join.
export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// The whole team, decoration included. The board fetches this ONCE and joins
// locally — an avatar on a card must never be its own request.
export async function listPeople() {
  return (await rest(PEOPLE, 'GET', '?select=email,display_name,avatar_key,avatar_scope,updated_at&order=email.asc')) || [];
}

export async function get(email) {
  const rows = await rest(REST, 'GET', `?email=eq.${enc(normalizeEmail(email))}&select=*&limit=1`);
  return (rows && rows[0]) || null;
}

// Create-or-update one profile. RLS lets a person write only their own row, so
// this is an upsert on the primary key rather than a create/patch pair: "I have
// never saved a profile" and "I am changing my profile" are the same gesture.
export async function upsert(email, fields) {
  const key = normalizeEmail(email);
  if (!key) return { error: 'upsert requires an email' };
  const row = { email: key, ...fields };
  await rest(REST, 'POST', '', [row], 'resolution=merge-duplicates,return=minimal');
  return { ok: true, email: key };
}

// The one shape an avatar key may have: `<scope uuid>/<32 hex>.<ext>`. Exactly
// one slash and no dots but the extension, so a traversal segment
// (`mine/../theirs/x.png`) cannot be expressed at all. The database enforces the
// identical shape in a CHECK and in the storage policy — this copy is the
// render-time guard, so a key that somehow got past them still can't compose a
// URL pointing outside its own folder.
const AVATAR_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{32}\.(png|jpg|webp|gif)$/;

// A person's storage folder is their `avatar_scope` — a random id on the profile
// row, NOT anything derived from their email. Two reasons: an email hash is
// guessable by anyone who guesses the email, and a folder derived from a mutable
// column breaks the moment that column moves (renaming a teammate cascades their
// email, which would strand every key they own).
export function avatarScope(profile) {
  return (profile && typeof profile.avatar_scope === 'string') ? profile.avatar_scope : null;
}

// Which image types an avatar may be, and the extension each one gets. An exact
// map, not sniffing: a type outside it is refused rather than guessed at. The
// bucket enforces the same list server-side (and the 2 MB cap) — this is here so
// the person gets a sentence instead of a 400.
export const AVATAR_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

// Refuse an image we know the bucket will reject, with the reason. Returns null
// when it's fine. `type`/`size` come straight off a File in the browser.
export function avatarRejection(type, size) {
  if (!AVATAR_TYPES[type]) return `That file is ${type || 'an unknown type'} — pick a PNG, JPEG, WebP, or GIF.`;
  if (size > AVATAR_MAX_BYTES) return `That image is ${(size / 1048576).toFixed(1)} MB — the limit is 2 MB.`;
  return null;
}

// Make sure this person has a profile row, and answer with it. A teammate who
// was allow-listed but has never opened their profile shows in the roster
// (the view left-joins) with no row and therefore no avatar scope — so an upload
// has to create the row before it has anywhere to put the picture.
export async function ensureProfile(email) {
  const key = normalizeEmail(email);
  const existing = await get(key);
  if (existing) return existing;
  const created = await upsert(key, {});
  if (created.error) return null;
  return get(key);
}

// Upload one person's avatar and return its object KEY,
// `<avatar_scope>/<sha256(bytes)>.<ext>`: content-addressed, so re-uploading the
// same picture is idempotent and a NEW picture always lands on a new key — no
// cache-busting query strings, and at most one object per distinct image.
// Carries the caller's identity (a signed-in JWT in the browser, the service key
// in node), which is what makes this work from the page at all.
//
// Insert-only, deliberately: the bucket grants no read policy (the public
// download path needs none, and a read policy would also permit LISTING the
// whole bucket), and an upsert needs to read what it's replacing. A collision on
// a content-addressed key means the identical bytes are already there — which is
// the desired end state, so it counts as success.
export async function uploadAvatar(email, bytes, type) {
  const ext = AVATAR_TYPES[type];
  if (!ext) return { error: `unsupported image type "${type}"` };
  const profile = await ensureProfile(email);
  const scope = avatarScope(profile);
  if (!scope) return { error: 'no profile row to hold this picture' };
  const key = `${scope}/${(await sha256Hex(bytes)).slice(0, 32)}.${ext}`;
  if (!AVATAR_KEY.test(key)) return { error: 'refusing to write a non-canonical avatar key' };
  try {
    await putObject(AVATARS_BUCKET, key, bytes, type, { upsert: false });
  } catch (e) {
    if (!(e instanceof ObjectExistsError)) throw e;
  }
  return { ok: true, key, scope };
}

// Point a profile at a picture (or at none). The ONLY way avatar_key is ever
// written, and it writes ONLY that: the scope belongs to the database (assigned
// on insert, frozen on update by trigger), so a client never states it — a
// payload that could carry a scope is a payload that could claim a teammate's
// folder.
//
// A PATCH rather than an upsert, deliberately. An upsert evaluates the row CHECK
// against its INSERT tuple before conflict resolution, so a key checked against
// a freshly generated scope is refused on a row that already exists and already
// agrees. Ensuring the row first and patching it checks the key against the
// scope actually stored.
export async function setAvatar(email, key) {
  const person = await ensureProfile(email);
  if (!person) return { error: `no profile row for ${email}` };
  if (key === null) return update(email, { avatar_key: null });
  if (!AVATAR_KEY.test(key)) return { error: `not a canonical avatar key: "${key}"` };
  if (key.split('/')[0] !== avatarScope(person)) {
    return { error: 'refusing to point a profile at another folder' };
  }
  return update(email, { avatar_key: key });
}

// Patch fields of an EXISTING row. Distinct from upsert: no insert tuple, so
// row constraints see the stored values for anything the payload omits.
async function update(email, fields) {
  const key = normalizeEmail(email);
  await rest(REST, 'PATCH', `?email=eq.${enc(key)}`, fields, 'return=minimal');
  return { ok: true, email: key };
}

// Drop an avatar object. Called when a picture is replaced or cleared, so a
// public object never outlives the profile that pointed at it. Best-effort: the
// row is the truth, and a failed delete must not block the change.
export async function deleteAvatar(key) {
  if (!key) return { ok: true };
  try { await deleteObjects(AVATARS_BUCKET, [key]); } catch { return { ok: false }; }
  return { ok: true };
}

// The row stores a KEY, never a URL — so a profile can only ever point into our
// own bucket, and no teammate can turn every board render into a request against
// a server they control. The URL is composed here, at render time, and only from
// a canonically shaped key: no key, no picture, rather than a URL that might
// resolve somewhere it shouldn't.
export function avatarUrl(profile) {
  const key = profile && typeof profile.avatar_key === 'string' ? profile.avatar_key : '';
  return AVATAR_KEY.test(key) ? publicUrl(AVATARS_BUCKET, key) : null;
}

// Remove a profile row. Only the test harness needs this (a person is removed
// from the allow-list, not from the roster), and only the service key can — the
// table has no delete policy.
export async function remove(email) {
  await rest(REST, 'DELETE', `?email=eq.${enc(normalizeEmail(email))}`, null, 'return=minimal');
  return { ok: true, email: normalizeEmail(email) };
}

// --- display -----------------------------------------------------------------
//
// Pure, so every surface (cards, rows, the owner property, the sidebar) renders
// a person the same way, and so the rules are testable without a browser.

// What to call this person: their display name, else the email's local part.
// Never the raw email — that's an address, not a name.
export function displayName(profile, email) {
  const name = profile && typeof profile.display_name === 'string' ? profile.display_name.trim() : '';
  if (name) return name;
  const key = normalizeEmail(email || profile?.email);
  const at = key.indexOf('@');
  return at > 0 ? key.slice(0, at) : key;
}

// The single letter shown when there's no picture.
export function initial(profile, email) {
  return (displayName(profile, email).charAt(0) || '?').toUpperCase();
}

// Six muted tones, picked by FNV-1a over the email. Same person, same colour, on
// every machine and every reload — deterministic, never random, and keyed on the
// email rather than the display name (which changes, and would change the
// colour with it). FNV rather than a digit sum because a sum puts similar
// addresses on the same tone, and the whole job of the colour is telling two
// people apart at a glance.
const AVATAR_TONES = 6;
export function tone(email) {
  const key = normalizeEmail(email);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % AVATAR_TONES;
}
