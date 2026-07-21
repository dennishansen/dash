// supabase.mjs — WHERE the project is and WHO we are when we talk to it.
//
// Three stores sit on one Supabase project: `issues` (the board), `dash_profiles`
// (people), and — if you use them — storage buckets (avatars). They used to each
// carry their own copy of the host, the anon key, and the service-key fallback —
// so the identity a signed-in browser pushes in (setAuthToken) reached the issues
// store and nothing else. Storage writes were hard-wired to the service key,
// which no browser has, making a browser upload impossible by construction. One
// identity, defined once here, is what makes a profile picture uploadable from
// the page and a profile row writable under the same JWT the board already uses.
//
// Plain fetch, no @supabase/* client — a fresh clone needs no install step, and
// this module is isomorphic (node tools AND the browser bundle import it), so it
// must never touch node APIs at module scope. Which project + which keys is read
// in ONE place — dash-config.mjs (process.env in node, Vite build defines in the
// browser). There are NO hardcoded fallbacks: bring your own Supabase.

import { SUPABASE_URL, SUPABASE_ANON, SUPABASE_SERVICE } from './dash-config.mjs';

export const URL = SUPABASE_URL;
export const ANON = SUPABASE_ANON;

// What grants access is the BEARER token, and it varies by caller:
//   - node tools (bin/dash.mjs, dev middleware, CI): the service key, which
//     bypasses RLS entirely. NODE ONLY — never shipped to the browser.
//   - browser: ANON until a user signs in, then their access token (pushed here
//     by auth.js). A bare anon key reads and writes nothing once RLS is locked
//     to authenticated + allow-listed emails — that's what makes the board safe
//     to serve from a public deploy.
export const SERVICE = SUPABASE_SERVICE;
let authToken = SERVICE || ANON;

// Swap the bearer token (browser sign-in / sign-out). null restores the default.
export function setAuthToken(token) {
  authToken = token || SERVICE || ANON;
}

// True when the current identity is more than the bare public key — i.e. a
// service key or a signed-in user. Writes that RLS will certainly refuse fail
// here with a useful message instead of a bare 403.
function isAuthenticated() {
  return authToken !== ANON;
}

export function headers(extra) {
  return {
    apikey: ANON,
    Authorization: `Bearer ${authToken}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

// --- PostgREST ---------------------------------------------------------------

// One REST call against `base` (a full table/rpc URL) with `query` appended.
// Throws on any non-2xx — callers must surface "unavailable" rather than
// silently rendering empty data.
export async function rest(base, method, query, body, prefer) {
  const res = await fetch(`${base}${query}`, {
    method,
    headers: headers(prefer ? { Prefer: prefer } : undefined),
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`supabase ${method} ${base}${query} → ${res.status} ${detail}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export const restUrl = (table) => `${URL}/rest/v1/${table}`;
export const RPC = `${URL}/rest/v1/rpc`;

// --- Storage -----------------------------------------------------------------

const enc = encodeURIComponent;
// Each path segment is encoded separately so slashes stay folder separators.
const encKey = (key) => String(key).split('/').map(enc).join('/');

// Public URL for an object in `bucket` at `key` (folder/file, possibly nested).
export function publicUrl(bucket, key) {
  return `${URL}/storage/v1/object/public/${bucket}/${encKey(key)}`;
}

const CONTENT_TYPES = {
  gif: 'image/gif', mp4: 'video/mp4', png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  json: 'application/json', jsonl: 'application/x-ndjson',
};

// Thrown when an insert-only (upsert:false) write hits an existing key, so
// callers minting random ids can catch it and retry with a fresh id.
export class ObjectExistsError extends Error {
  constructor(bucket, key) { super(`object exists: ${bucket}/${key}`); this.name = 'ObjectExistsError'; this.bucket = bucket; this.key = key; }
}

// Upload one object to `bucket` at `key`. `source` is a Buffer/Uint8Array/Blob,
// a string body (with an explicit contentType), or a filesystem path to read
// (node only). Returns the object's public URL. Writes carry the CURRENT
// identity — the service key in node, the signed-in user's JWT in the browser —
// so a bucket whose policy allows self-writes is uploadable from the page.
// `upsert` (default true) overwrites; pass false for insert-only.
export async function putObject(bucket, key, source, contentType, { upsert = true } = {}) {
  if (!isAuthenticated()) {
    throw new Error(`putObject needs a service key (node) or a signed-in session (browser) — the anon key is read-only`);
  }
  let body = source;
  // A bare string with no declared type is a filesystem path (node only).
  if (typeof source === 'string' && !contentType) {
    const fs = await import('node:fs');
    body = fs.readFileSync(source);
  } else if (!(typeof source === 'string' || source instanceof Uint8Array
    || (typeof Blob !== 'undefined' && source instanceof Blob)
    || (typeof Buffer !== 'undefined' && Buffer.isBuffer(source)))) {
    const fs = await import('node:fs');
    body = fs.readFileSync(source);
  }
  const ext = (key.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  const res = await fetch(`${URL}/storage/v1/object/${bucket}/${encKey(key)}`, {
    method: 'POST',
    headers: headers({
      'Content-Type': contentType || CONTENT_TYPES[ext] || 'application/octet-stream',
      'x-upsert': upsert ? 'true' : 'false',
      'cache-control': '300',
    }),
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // The Storage API reports an insert-only collision as HTTP 400 carrying a
    // structured body `{"statusCode":"409","error":"Duplicate",...}`. Parse the
    // JSON and check the fields structurally (no text regex).
    if (!upsert) {
      let parsed = null;
      try { parsed = JSON.parse(text); } catch {}
      if (res.status === 409 || parsed?.statusCode === '409' || parsed?.error === 'Duplicate') {
        throw new ObjectExistsError(bucket, key);
      }
    }
    throw new Error(`putObject ${bucket}/${key} -> ${res.status} ${text}`);
  }
  return publicUrl(bucket, key);
}

// List one folder of `bucket`. Returns matching file names (no folder rows).
export async function listBucketFolder(bucket, prefix, match = /.*/) {
  const res = await fetch(`${URL}/storage/v1/object/list/${bucket}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ prefix, limit: 1000, sortBy: { column: 'name', order: 'asc' } }),
  });
  if (!res.ok) return [];
  const rows = await res.json();
  // Storage returns files with a non-null id; folder placeholders have id null.
  return rows.filter(r => r && r.id && match.test(r.name)).map(r => r.name);
}

// Top-level folder names of `bucket` (the placeholder rows, id null).
export async function listBucketFolders(bucket) {
  const res = await fetch(`${URL}/storage/v1/object/list/${bucket}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ prefix: '', limit: 1000 }),
  });
  if (!res.ok) return [];
  return (await res.json()).filter(r => r && r.id == null).map(r => r.name);
}

// Delete objects from `bucket` by full key path.
export async function deleteObjects(bucket, keys) {
  if (keys.length === 0) return [];
  if (!isAuthenticated()) throw new Error('deleteObjects needs a service key or a signed-in session');
  const res = await fetch(`${URL}/storage/v1/object/${bucket}`, {
    method: 'DELETE',
    headers: headers(),
    body: JSON.stringify({ prefixes: keys }),
  });
  if (!res.ok) throw new Error(`deleteObjects ${bucket} ${res.status} ${await res.text().catch(() => '')}`);
  return keys;
}

// SHA-256 of a UTF-8 string as lowercase hex. Isomorphic: WebCrypto in the
// browser, node:crypto elsewhere. Used to key avatar folders by person without
// putting the email itself in a publicly listable path.
export async function sha256Hex(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}
