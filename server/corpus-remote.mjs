// corpus-remote.mjs — the bridge to transient corpus artifacts that now live
// canonically in Supabase (see docs/artifact-storage.md, docs/dashboard.md):
//   - rendered gifs/mp4s in the `corpus-gifs` storage bucket
//   - session recordings + scene-sample sidecars in the `corpus-sessions` bucket
//   - per-commit metric snapshots in the `metric_runs` table (dashboard trend)
//
// Plain fetch over PostgREST + the Storage API. Project + keys come from
// dash-config.mjs (env in node, Vite build injection in the browser). Both
// buckets are public-read (anon) and service-write: reads work anywhere with no
// key (browser or node), writes need the service key in the local env.

import { SUPABASE_URL, SUPABASE_ANON, SUPABASE_SERVICE } from './dash-config.mjs';
const URL = SUPABASE_URL;
const ANON = SUPABASE_ANON;
const SERVICE = SUPABASE_SERVICE;
const GIFS_BUCKET = 'corpus-gifs';
const SESSIONS_BUCKET = 'corpus-sessions';

const enc = encodeURIComponent;
const encKey = (key) => String(key).split('/').map(enc).join('/');

const CONTENT_TYPES = {
  gif: 'image/gif', mp4: 'video/mp4', png: 'image/png',
  json: 'application/json', jsonl: 'application/x-ndjson',
};

// --- generic bucket object store --------------------------------------------

// Public URL for an object in `bucket` at `key` (folder/file, possibly nested).
// Each path segment is encoded separately so slashes stay as folder separators.
function publicUrl(bucket, key) {
  return `${URL}/storage/v1/object/public/${bucket}/${encKey(key)}`;
}

// Thrown when an insert-only (upsert:false) write hits an existing key, so
// callers minting random ids can catch it and retry with a fresh id.
export class ObjectExistsError extends Error {
  constructor(bucket, key) { super(`object exists: ${bucket}/${key}`); this.name = 'ObjectExistsError'; this.bucket = bucket; this.key = key; }
}

// Upload one object to `bucket` at `key`. `source` is a Buffer/Uint8Array, a
// string body, or a filesystem path to read (node only). Returns the object's
// public URL. Needs the service key. `upsert` (default true) overwrites; pass
// false for insert-only — a collision throws ObjectExistsError.
async function putObject(bucket, key, source, contentType, { upsert = true } = {}) {
  if (!SERVICE) throw new Error(`putObject needs DASH_SUPABASE_SERVICE_KEY in env (anon key is read-only)`);
  let body = source;
  if (!(Buffer.isBuffer(source) || source instanceof Uint8Array || typeof source === 'string')) {
    const fs = await import('node:fs');
    body = fs.readFileSync(source);
  } else if (typeof source === 'string' && !contentType) {
    // A bare string with no declared type is treated as a filesystem path.
    const fs = await import('node:fs');
    body = fs.readFileSync(source);
  }
  const ext = (key.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  const res = await fetch(`${URL}/storage/v1/object/${bucket}/${encKey(key)}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      'Content-Type': contentType || CONTENT_TYPES[ext] || 'application/octet-stream',
      'x-upsert': upsert ? 'true' : 'false',
      'cache-control': '300',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // The Storage API reports an insert-only collision as HTTP 400 carrying a
    // structured body `{"statusCode":"409","error":"Duplicate",...}`. Parse the
    // JSON and check the fields structurally (no text regex).
    if (!upsert) {
      let body = null;
      try { body = JSON.parse(text); } catch {}
      if (res.status === 409 || body?.statusCode === '409' || body?.error === 'Duplicate') {
        throw new ObjectExistsError(bucket, key);
      }
    }
    throw new Error(`putObject ${bucket}/${key} -> ${res.status} ${text}`);
  }
  return publicUrl(bucket, key);
}

// List one folder of `bucket`. Returns matching file names (no folder rows).
async function listBucketFolder(bucket, prefix, match = /.*/) {
  const res = await fetch(`${URL}/storage/v1/object/list/${bucket}`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix, limit: 1000, sortBy: { column: 'name', order: 'asc' } }),
  });
  if (!res.ok) return [];
  const rows = await res.json();
  // Storage returns files with a non-null id; folder placeholders have id null.
  return rows.filter(r => r && r.id && match.test(r.name)).map(r => r.name);
}

// Delete objects from `bucket` by full key path. Needs the service key.
async function deleteObjects(bucket, keys) {
  if (keys.length === 0) return [];
  if (!SERVICE) throw new Error('deleteObjects needs DASH_SUPABASE_SERVICE_KEY in env');
  const res = await fetch(`${URL}/storage/v1/object/${bucket}`, {
    method: 'DELETE',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: keys }),
  });
  if (!res.ok) throw new Error(`deleteObjects ${bucket} ${res.status} ${await res.text().catch(() => '')}`);
  return keys;
}

// --- gifs (corpus-gifs bucket) ----------------------------------------------

export function gifPublicUrl(experiment, file) {
  return publicUrl(GIFS_BUCKET, `${experiment}/${file}`);
}

// Public URL for a gif object given a full key path (folder/file, possibly
// nested like `issues/<id>/<label>.gif`).
export function objectPublicUrl(key) {
  return publicUrl(GIFS_BUCKET, key);
}

// Upload a single gif/mp4/png to corpus-gifs at `key`. Returns its public URL.
export async function uploadGif(key, source) {
  const url = await putObject(GIFS_BUCKET, key, source);
  invalidateGifCache();
  return url;
}

// List one folder (experiment) of the gif bucket. Returns gif/mp4/png names.
async function listFolder(prefix) {
  return listBucketFolder(GIFS_BUCKET, prefix, /\.(gif|mp4|png)$/i);
}

// All gif objects across experiments, cached briefly. [{ experiment, file }].
let _gifCache = null, _gifAt = 0;
const GIF_TTL_MS = 60_000;
export async function listGifs() {
  if (_gifCache && Date.now() - _gifAt < GIF_TTL_MS) return _gifCache;
  // Top level: folder placeholders (experiments).
  const top = await fetch(`${URL}/storage/v1/object/list/${GIFS_BUCKET}`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: '', limit: 1000 }),
  });
  const out = [];
  if (top.ok) {
    const rows = await top.json();
    const experiments = rows.filter(r => r && r.id == null).map(r => r.name);
    for (const exp of experiments) {
      for (const file of await listFolder(`${exp}/`)) out.push({ experiment: exp, file });
    }
  }
  _gifCache = out;
  _gifAt = Date.now();
  return out;
}

export function invalidateGifCache() { _gifCache = null; }

// Delete every gif whose file starts with `<name>` (the bench and its
// variants). Needs the service key. Returns the deleted keys.
export async function deleteGifs(name) {
  if (!SERVICE) throw new Error('deleteGifs needs DASH_SUPABASE_SERVICE_KEY in env');
  const all = await listGifs();
  const victims = all
    .filter(g => g.file === `${name}.gif` || g.file.startsWith(`${name}-`))
    .map(g => `${g.experiment}/${g.file}`);
  const deleted = await deleteObjects(GIFS_BUCKET, victims);
  invalidateGifCache();
  return deleted;
}

// --- sessions (corpus-sessions bucket) --------------------------------------
//
// A session's object-key STEM is its id: `<id>.json` is the recording,
// `<id>.scene-samples.jsonl` the scene-sample sidecar. ids may carry a folder
// prefix (`tests/<name>` for headless recordings). See docs/artifact-storage.md.

export function sessionPublicUrl(id) { return publicUrl(SESSIONS_BUCKET, `${id}.json`); }

// Save a recording (+ optional scene samples) keyed by id. Node-only (service
// key). `upsert:false` makes the recording write insert-only — a collision
// throws ObjectExistsError so callers minting random ids can retry. Returns
// { id, url, sceneUrl }.
export async function saveSession(id, session, sceneSamples = null, { upsert = true } = {}) {
  const url = await putObject(SESSIONS_BUCKET, `${id}.json`, JSON.stringify(session), 'application/json', { upsert });
  let sceneUrl = null;
  if (Array.isArray(sceneSamples) && sceneSamples.length > 0) {
    const jsonl = sceneSamples.map(s => JSON.stringify(s)).join('\n') + '\n';
    sceneUrl = await putObject(SESSIONS_BUCKET, `${id}.scene-samples.jsonl`, jsonl, 'application/x-ndjson');
  }
  return { id, url, sceneUrl };
}

// Load a session by id. Isomorphic — public bucket, anon read. Returns the
// parsed session object, or null if not found.
export async function loadSession(id) {
  const res = await fetch(sessionPublicUrl(id));
  if (!res.ok) return null;
  return res.json();
}

// Load a session's scene samples by id. Returns an array, or null if absent.
export async function loadSceneSamples(id) {
  const res = await fetch(publicUrl(SESSIONS_BUCKET, `${id}.scene-samples.jsonl`));
  if (!res.ok) return null;
  const text = await res.text();
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t) out.push(JSON.parse(t));
  }
  return out;
}

// List session ids present in the bucket (optionally under a folder prefix).
export async function listSessions(prefix = '') {
  const files = await listBucketFolder(SESSIONS_BUCKET, prefix, /\.json$/i);
  return files.map(f => `${prefix}${f}`.replace(/\.json$/i, ''));
}

// Delete a session (recording + scene sidecar) by id. Needs the service key.
export async function deleteSession(id) {
  return deleteObjects(SESSIONS_BUCKET, [`${id}.json`, `${id}.scene-samples.jsonl`]);
}

// --- metrics (metric_runs table) --------------------------------------------

// Per-commit metric snapshots, oldest→newest (the shape the dashboard
// sparklines already expect from the old local history.jsonl).
export async function statsHistory() {
  const res = await fetch(
    `${URL}/rest/v1/metric_runs?select=*&order=date.asc`,
    { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } },
  );
  if (!res.ok) return [];
  return res.json();
}
