// corpus-remote.mjs — the bridge to transient corpus artifacts that now live
// canonically in Supabase (see docs/artifact-storage.md, docs/dashboard.md):
//   - rendered gifs/mp4s in the `corpus-gifs` storage bucket
//   - session recordings + scene-sample sidecars in the `corpus-sessions` bucket
//   - per-commit metric snapshots in the `metric_runs` table (dashboard trend)
//
// Plain fetch over PostgREST + the Storage API — the connection and identity
// (host, keys, bearer token) live in supabase.mjs, shared with the issues and
// profiles stores, as do the generic bucket operations. Both corpus buckets are
// public-read (anon): reads work anywhere with no key, browser or node. Writes
// carry whatever identity supabase.mjs is holding — DASH_SUPABASE_SERVICE_KEY in node
// tooling, and in the browser a signed-in teammate's JWT, which the
// corpus-sessions policies accept so a deployed page can store its own recording
// with no privileged process behind it.
//
// This module is what's left once those are shared: which buckets exist, what
// their keys mean, and the corpus-specific read/write helpers over them.

import {
  rest, restUrl, publicUrl, putObject, deleteObjects, listBucketFolder, listBucketFolders,
  listBucketObjects, ObjectExistsError,
} from './supabase.mjs';
import { summarizeSession } from './recording-summary.mjs';

const GIFS_BUCKET = 'corpus-gifs';
export const SESSIONS_BUCKET = 'corpus-sessions';

export { ObjectExistsError };

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
  const out = [];
  // Top level: folder placeholders (experiments).
  for (const exp of await listBucketFolders(GIFS_BUCKET)) {
    for (const file of await listFolder(`${exp}/`)) out.push({ experiment: exp, file });
  }
  _gifCache = out;
  _gifAt = Date.now();
  return out;
}

export function invalidateGifCache() { _gifCache = null; }

// Delete every gif whose file starts with `<name>` (the bench and its
// variants). Needs the service key. Returns the deleted keys.
export async function deleteGifs(name) {
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

// What a PERSON's recording id looks like: four hex characters, the established
// session-id UX (the /bug and /session-read workflows key on typing four of
// them). One pattern, minted by mintSessionId, enforced on write by
// saveNewSession, and read back by listRecordings — so "what a session id is"
// cannot drift between the two ends of the corpus.
export const SESSION_ID_RE = /^[0-9a-f]{4}$/;

// A fresh 4-hex session id. Two random bytes — see SESSION_ID_RE.
export function mintSessionId() {
  const b = new Uint8Array(2);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

// Save a recording (+ optional scene samples) keyed by id, under the caller's
// current identity. `upsert:false` makes the recording write insert-only — a
// collision throws ObjectExistsError so callers minting random ids can retry.
// Returns { id, url, sceneUrl }.
export async function saveSession(id, session, sceneSamples = null, { upsert = true } = {}) {
  const url = await putObject(SESSIONS_BUCKET, `${id}.json`, JSON.stringify(session), 'application/json', { upsert });
  let sceneUrl = null;
  if (Array.isArray(sceneSamples) && sceneSamples.length > 0) {
    const jsonl = sceneSamples.map(s => JSON.stringify(s)).join('\n') + '\n';
    sceneUrl = await putObject(SESSIONS_BUCKET, `${id}.scene-samples.jsonl`, jsonl, 'application/x-ndjson');
  }
  return { id, url, sceneUrl };
}

// Save a NEW recording under the id its recorder already minted and copied.
//
// The id is minted client-side so the "code to copy" is known the instant
// recording stops, with no round-trip (docs/artifact-storage.md) — which means
// the store's job is to honour it if it can and to say so when it cannot. The
// write is INSERT-only: a blind upsert on a random 4-hex id would eventually
// clobber somebody else's recording in silence. A collision mints a fresh id and
// comes back `reassigned`, so the caller can re-copy the code that persisted.
//
// One implementation for both writers — the browser saving under a teammate's
// own JWT, and the dev server saving under the service key on a page that has
// no identity. The rule about ids belongs to the corpus, not to either of them.
export async function saveNewSession(id, session, sceneSamples = null) {
  const wanted = SESSION_ID_RE.test(id || '') ? id : null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const next = attempt === 0 && wanted ? wanted : mintSessionId();
    try {
      const saved = await saveSession(next, { ...session, id: next }, sceneSamples, { upsert: false });
      return { ...saved, reassigned: Boolean(wanted) && next !== wanted };
    } catch (err) {
      if (err instanceof ObjectExistsError) continue;   // taken — try a fresh id
      throw err;
    }
  }
  throw new Error('could not mint a free session id after 6 attempts');
}

// Load a session by id. Isomorphic — public bucket, anon read. Returns the
// parsed session object, or null if not found.
//
// `fresh` bypasses the CDN's five-minute copy. It matters for a key that is
// written more than once — a recording's shell at start and the whole of it at
// stop, or a `tests/<name>` fixture re-recorded — where the cached read is the
// PREVIOUS write, and merging onto it would throw the current one away.
export async function loadSession(id, { fresh = false } = {}) {
  const url = fresh ? `${sessionPublicUrl(id)}?fresh=${Date.now()}` : sessionPublicUrl(id);
  const res = await fetch(url, fresh ? { cache: 'no-store' } : undefined);
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

// Delete a session (recording + scene sidecar + any streamed parts) by id.
// Needs the service key. A recording streams into a `parts/<id>/` folder as it
// is made (corpus-recording.mjs), so a delete that removed only the two
// top-level objects would strand the frames and audio it left behind — which,
// for a recording that was never stopped, is the whole of it. The parts are
// listed (a live prefix, so any that landed are found) and removed with them.
export async function deleteSession(id) {
  const keys = [`${id}.json`, `${id}.scene-samples.jsonl`];
  const parts = await listBucketObjects(SESSIONS_BUCKET, `parts/${id}/`, { limit: 5000 }).catch(() => []);
  for (const kind of ['frames', 'audio']) {
    const rows = await listBucketObjects(SESSIONS_BUCKET, `parts/${id}/${kind}/`, { limit: 5000 }).catch(() => []);
    for (const r of rows) if (r?.id) keys.push(`parts/${id}/${kind}/${r.name}`);
  }
  if (parts.some((r) => r?.id && r.name === 'voice.json')) keys.push(`parts/${id}/voice.json`);
  return deleteObjects(SESSIONS_BUCKET, keys);
}

// --- browsing recordings ----------------------------------------------------
//
// `listSessions` answers "which ids exist" and is the wrong question for a
// person: 140 recordings named by four hex digits, in alphabetical order, is a
// list you cannot read. Browsing needs the one fact the recording's own JSON
// does not carry — WHEN it landed — and that lives on the storage row, sortable
// server-side. So "the 40 most recent" is one anonymous request, not a full
// listing plus a fetch of every session to find its clock.
//
// The KEY is the classification, and nothing here infers one from a name. A key
// has TWO parts and the rule uses both (docs/artifact-storage.md):
//
//   'tests/<anything>'  machine output — a headless run's replay fixture
//   '<4 hex>'           a person's own recording, Shift+` in a browser
//
// The prefix alone is not enough, and the reason is worth stating: until every
// checkout on a machine carries the writer that puts headless recordings under
// `tests/`, an older one keeps dropping `agent-<id>` at the top level. Reading
// only the prefix would file those under "a person recorded this" and bury the
// handful of real sessions. The id SHAPE is the other half of the same written
// contract — saveNewSession refuses to store a person's recording under anything
// else — so honouring both parts is reading the rule, not guessing at it.
//
// Both namespaces browse the same way; which one you are looking at is the
// caller's choice, not a filter over a mixed list.

export const RECORDING_NAMESPACES = {
  session: { prefix: '', accepts: (stem) => SESSION_ID_RE.test(stem) },
  test: { prefix: 'tests/', accepts: () => true },
};
const SCENE_SUFFIX = '.scene-samples.jsonl';

// The `limit` most recently WRITTEN recordings in `namespace`, newest first.
// `[{ id, writtenAt }]`.
//
// Written, not created, and the difference is the whole answer for one of the
// two namespaces: `tests/<name>` means "the latest recording of this test" and
// is overwritten in place, so its `created_at` is the day that test was first
// recorded — often months before the recording actually in the bucket. Sorted
// by `created_at`, the twelve fixtures rewritten TODAY did not appear on the
// first page at all. `updated_at` is when the bytes now stored were stored,
// which is the honest clock for both namespaces (a browser recording's late
// voice transcript amends it a few seconds after the insert, which is still the
// moment that recording finished being written).
export async function listRecordings({ namespace = 'session', limit = 40 } = {}) {
  const space = RECORDING_NAMESPACES[namespace];
  // An unknown namespace silently falling back to the top level would answer a
  // question nobody asked with somebody else's recordings.
  if (!space) throw new Error(`unknown recording namespace "${namespace}"`);
  const { prefix, accepts } = space;

  // ONE request per attempt, never offset paging. A recording is one or two
  // OBJECTS — `<id>.json` and an optional `<id>.scene-samples.jsonl` — and the
  // listing spends rows on folder placeholders besides, so a window of `limit`
  // rows holds fewer than `limit` recordings. The obvious fix is to page with an
  // offset, and it is wrong: this bucket is LIVE, and a recording landing
  // between two pages shifts every later offset by one — the last row of page N
  // reappears as the first row of page N+1 (duplicate id, duplicate React key)
  // and one recording is skipped entirely. Widening the window instead keeps
  // every answer a single self-consistent snapshot. Two rows per recording is
  // the exact upper bound, so the first attempt is enough unless the namespace
  // is mostly folders — or, at the top level, mostly keys that belong elsewhere.
  const seen = new Map();
  for (let window = Math.max(4, limit * 2 + 8); ; window *= 2) {
    const rows = await listBucketObjects(SESSIONS_BUCKET, prefix, {
      limit: window, sortBy: { column: 'updated_at', order: 'desc' },
    });
    seen.clear();
    for (const row of rows) {
      if (!row?.id) continue;                                    // folder placeholder
      if (row.name.endsWith(SCENE_SUFFIX)) continue;             // a recording's sidecar
      if (!row.name.endsWith('.json')) continue;
      const stem = row.name.slice(0, -'.json'.length);
      if (!accepts(stem)) continue;                              // not this namespace's shape
      const id = `${prefix}${stem}`;
      if (!seen.has(id)) seen.set(id, { id, writtenAt: row.updated_at || row.created_at || null });
    }
    // Enough, or the listing ended before the window did — either way this
    // snapshot is the whole answer.
    if (seen.size >= limit || rows.length < window) break;
  }
  return [...seen.values()].slice(0, limit);
}

// --- rendered videos (corpus-gifs, `recordings/` folder) ---------------------
//
// A recording's video is a rendered artifact, so it lives with the other
// rendered artifacts — and its OBJECT KEY is the whole bookkeeping:
//
//     recordings/<id>.<sha>.mp4
//
// Existence means "rendered"; the sha means "by this code". No job table, no
// status column, nothing to fall out of sync with the bucket — the artifact is
// its own record, which is the same trick `tests/<name>` already plays. One
// listing of the folder answers, for every recording at once, whether it has a
// video and what it was rendered at.
//
// The sha matters because the render is NOT faithful: render-session replays a
// recording through whatever code is checked out now, deliberately (it is what
// makes solver-lab before/after work). So a video shows what today's build does
// with those inputs, which is a different question from what the person saw. The
// recording carries the sha it RAN on (`state.context.codeVersion`); the key
// carries the sha it was RENDERED at; the detail page compares them and says so
// when they differ. See i-faithful-recordings.

const VIDEO_FOLDER = 'recordings';
const VIDEO_KEY_RE = /^([^/]+)\.([0-9a-f]{7,40}(?:-dirty)?)\.mp4$/;

export function recordingVideoKey(id, renderedAt) {
  return `${VIDEO_FOLDER}/${id}.${renderedAt}.mp4`;
}

// Every rendered video, as `id → { url, renderedAt }`. One listing, anonymous,
// works on the deploy exactly as on the box — the render happens in one place
// and everybody watches.
export async function listRecordingVideos() {
  const rows = await listBucketObjects(GIFS_BUCKET, `${VIDEO_FOLDER}/`, {
    limit: 1000, sortBy: { column: 'updated_at', order: 'desc' },
  }).catch(() => []);
  const out = new Map();
  for (const row of rows) {
    const m = row?.id && VIDEO_KEY_RE.exec(row.name);
    if (!m) continue;
    // Newest-written first, so the first key seen for an id is the current one;
    // an older render of the same recording is history, not the answer.
    if (!out.has(m[1])) {
      out.set(m[1], { url: publicUrl(GIFS_BUCKET, `${VIDEO_FOLDER}/${row.name}`), renderedAt: m[2] });
    }
  }
  return out;
}

// One recording's video, or null. Narrowed to THIS recording's keys — a detail
// page asks about one id and must not read (or worse, miss the answer past the
// end of) the whole folder.
export async function recordingVideo(id) {
  const rows = await listBucketObjects(GIFS_BUCKET, `${VIDEO_FOLDER}/`, {
    search: id, limit: 20, sortBy: { column: 'updated_at', order: 'desc' },
  }).catch(() => []);
  for (const row of rows) {
    const m = row?.id && VIDEO_KEY_RE.exec(row.name);
    if (m && m[1] === id) {
      return { url: publicUrl(GIFS_BUCKET, `${VIDEO_FOLDER}/${row.name}`), renderedAt: m[2] };
    }
  }
  return null;
}

// One recording's card — when, how long, how many frames, what was said, what
// was drawn. The facts live INSIDE the recording (there is no index beside the
// bucket), so a card costs one object fetch; callers ask for cards as rows come
// into view and keep the summary rather than the body.
export async function loadRecordingSummary(id) {
  return summarizeSession(id, await loadSession(id));
}

// --- metrics (metric_runs table) --------------------------------------------

// Per-commit metric snapshots, oldest→newest (the shape the dashboard
// sparklines already expect from the old local history.jsonl).
export async function statsHistory() {
  try {
    return (await rest(restUrl('metric_runs'), 'GET', '?select=*&order=date.asc')) || [];
  } catch {
    return [];
  }
}
