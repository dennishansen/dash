// Dash API — read-only endpoints under /api/dash/*
//
// Serves the Dash UI sidecar at /dash/. All endpoints parse files/git in real
// time; no caching, no DB. Freshness comes from disk on every read.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { run } from './proc.mjs';
import { gifPublicUrl, listGifs, deleteGifs, invalidateGifCache, statsHistory, loadSession } from './corpus-remote.mjs';
import { listIssues, issueDetail, listChanges, placeChange, renameChange, changeDep } from './dash-issues.js';
import { CodeBrowserError, environmentFile, environmentSnapshot } from './code-browser.mjs';
import { resetWorkspace, undoReset } from './code-reset.mjs';
import { parseHandle, chatStatusAny } from './agents.mjs';
import { searchIssues } from '../src/issue-search.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..', '..');

// One git config value, off the event loop (run(), never execSync — a sync child
// here freezes every attached terminal). Returns null when unset or git is
// unavailable. `key` is always a fixed literal, so there's nothing to inject.
async function gitConfig(key) {
  const r = await run('git', ['config', key]);
  return r.status === 0 ? (r.stdout.trim() || null) : null;
}

// Seed a person's display name from git, once. Only ever fills an EMPTY name —
// never clobbers one the person set by hand — and the profile table's foreign
// key to the allow-list means a non-teammate email simply can't get a row (the
// upsert throws, caught here). So this is a no-op for anyone but an allow-listed
// teammate who hasn't named themselves yet.
async function seedProfileName(email, name) {
  try {
    const { get, upsert } = await import('./profiles-store.mjs');
    const row = await get(email);
    if (row?.display_name) return;
    await upsert(email, { display_name: name.trim() });
  } catch { /* not a teammate, or the roster is unreachable — the session still works */ }
}

const CORPUS_DIR = path.join(REPO, 'tests', 'solver-corpus');
const BASELINE = path.join(REPO, 'tests', 'solver-metrics-baseline.json');

// --- helpers ---

// Run git from REPO — no shell, so format strings with special chars like
// '%(refname)' don't get interpreted as subshells. `args` is an array of git
// args, e.g. ['log', '--oneline', '-5']. ASYNC (spawn, never spawnSync): every
// caller here is on a request path, and a synchronous git blocks the one event
// loop that also relays terminal keystrokes — the terminal-freeze cause.
// Resolves '' on any failure.
async function git(args) {
  if (typeof args === 'string') args = args.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(s => s.replace(/^"|"$/g, '')) || [];
  const r = await run('git', ['-C', REPO, ...args]);
  return r.status === 0 ? r.stdout : '';
}

async function readJSON(p, fallback = null) {
  try { return JSON.parse(await fs.promises.readFile(p, 'utf8')); } catch { return fallback; }
}

async function readText(p, fallback = '') {
  try { return await fs.promises.readFile(p, 'utf8'); } catch { return fallback; }
}

async function exists(p) {
  try { await fs.promises.access(p); return true; } catch { return false; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Tiny in-process memoization with TTL. For list views a 10s TTL is fine. The UI can force a
// refresh by calling /api/dash/changes?nocache=1 or using the refresh
// button which sets cache-busting query params.
//
// Stored on globalThis so vite HMR reloading the module doesn't drop it.
if (!globalThis.__labCache) globalThis.__labCache = new Map();
const cache = globalThis.__labCache;
// Exported so writes made OUTSIDE this module's routes — terminal.js' chat
// rename/unlink, which touch columns the board list carries — can drop the memo
// too, instead of leaving the feed stale for the rest of its TTL.
export function invalidateCache() { cache.clear(); }
// Every producer awaits I/O now (async git/fs), so the memo is async-only.
// Rejections are not cached — a failed fetch shouldn't poison the TTL window.
async function memoAsync(key, ttlMs, fn) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && hit.expiry > now) return hit.value;
  const value = await fn();
  cache.set(key, { value, expiry: now + ttlMs });
  return value;
}

// --- corpus / tests ---

async function listCorpus() {
  const items = [];
  let files;
  try { files = (await fs.promises.readdir(CORPUS_DIR)).filter(f => f.endsWith('.manifest.json')); }
  catch { return items; }
  const baseline = await readJSON(BASELINE);
  // Gifs live in the bucket now (CI is the canonical corpus renderer); fetch
  // the listing once and prefix-match locally instead of a per-bench disk scan.
  const gifs = await listGifs();
  const hasGifFor = (name) => gifs.some(g => g.file === `${name}.gif` || g.file.startsWith(`${name}-`));
  for (const f of files) {
    const name = f.replace(/\.manifest\.json$/, '');
    const manifest = await readJSON(path.join(CORPUS_DIR, f), {});
    const sessionFile = path.join(CORPUS_DIR, `${name}.json`);
    const hasSession = await exists(sessionFile);
    const metrics = baseline?.gestures?.[name]?.metrics || null;
    const hasGif = hasGifFor(name);
    items.push({
      name,
      description: manifest.description || null,
      tracked: manifest.tracked || null,
      hard_gates: manifest.hard || null,
      advisory_gates: manifest.advisory || null,
      perceptual_note: manifest.perceptual_note || null,
      active: manifest.active !== false,
      has_session: hasSession,
      has_manifest: true,
      has_gif: hasGif,
      metrics,
    });
  }
  items.sort((a, b) => {
    const am = a.name.match(/^bench-(\d+)/);
    const bm = b.name.match(/^bench-(\d+)/);
    if (am && bm) return parseInt(am[1], 10) - parseInt(bm[1], 10);
    if (am) return -1;
    if (bm) return 1;
    return a.name.localeCompare(b.name);
  });
  return items;
}

// Create a proposed (inactive) test from a recording fetched by id from the
// Supabase corpus (corpus-sessions). The session is written as-is into the
// committed corpus so replay runs the same byte-exact frames. A minimal
// manifest is generated with active:false so it lands in the Proposed section
// and isn't gated by the harness. See docs/artifact-storage.md.

// Rendering is CI-owned (docs/dashboard.md): a test created here is
// written to the corpus locally and its gif materialises after commit+push,
// when the render-corpus workflow runs. No local render path.

// Pick the [<id>.x, <id>.y] pair of the entity closest to the first
// pointerdown world coord. Falls back to all scalar keys if no
// pointerdown is found or no x/y pair matches — better to over-track
// than to track nothing and produce empty metrics.
function pickTrackedScalars(session) {
  const scalars = session.state?.scalars || {};
  const allKeys = Object.keys(scalars);
  const firstDown = session.frames?.find(f => f && f.event === 'pointerdown');
  if (!firstDown || !Array.isArray(firstDown.world)) return allKeys;
  const [wx, wy] = firstDown.world;
  let bestId = null;
  let bestDist = Infinity;
  for (const k of allKeys) {
    if (!k.endsWith('.x')) continue;
    const id = k.slice(0, -2);
    const yk = `${id}.y`;
    if (!(yk in scalars)) continue;
    const dx = scalars[k] - wx;
    const dy = scalars[yk] - wy;
    const d = dx * dx + dy * dy;
    if (d < bestDist) { bestDist = d; bestId = id; }
  }
  return bestId ? [`${bestId}.x`, `${bestId}.y`] : allKeys;
}

async function createTestFromSession({ sessionId, testName }) {
  if (!sessionId || typeof sessionId !== 'string') {
    return { error: 'sessionId required' };
  }
  const safeId = sessionId.replace(/\.json$/, '');
  // ids may carry a folder prefix (tests/<name>); allow slashes.
  if (!/^[A-Za-z0-9_\-\/]+$/.test(safeId)) {
    return { error: 'invalid sessionId — expected [A-Za-z0-9_-/]' };
  }
  const session = await loadSession(safeId);
  if (!session) {
    return { error: `session '${safeId}' not found in the Supabase corpus` };
  }
  if (!session.state || !Array.isArray(session.frames)) {
    return { error: 'session is missing state/frames — not a recording' };
  }
  // Reject sessions the harness can't replay — multiplayer/spectate
  // recordings have remote-pointer events that replay.js explicitly
  // throws on. Catch them at create time so the user gets immediate
  // feedback rather than a delayed error in the async render job.
  for (const f of session.frames) {
    if (f && typeof f.event === 'string' && f.event.startsWith('remote-')) {
      return { error: `session contains remote-pointer events (multiplayer recording); replay can't handle these. Re-record in local mode.` };
    }
  }
  // Verify the state hydrates. hydrateState throws on schema mismatches
  // or unsupported shapes — same code path the harness uses, so passing
  // here means the test will at least start replaying.
  try {
    const replayUrl = new URL('file://' + path.join(REPO, 'tests/solver-harness/replay.js')).href;
    const { hydrateState } = await import(replayUrl);
    hydrateState(session.state);
  } catch (e) {
    return { error: `session state failed to hydrate: ${e.message}` };
  }
  const rawName = (testName && String(testName).trim()) || `proposed-session-${safeId}`;
  const baseName = rawName.replace(/\.(manifest\.)?json$/, '').replace(/[^A-Za-z0-9_\-]/g, '-');
  if (!baseName) return { error: 'invalid testName' };
  // Resolve collisions by suffixing -1, -2, …
  let finalName = baseName;
  let n = 1;
  while (
    (await exists(path.join(CORPUS_DIR, `${finalName}.json`))) ||
    (await exists(path.join(CORPUS_DIR, `${finalName}.manifest.json`)))
  ) {
    finalName = `${baseName}-${n++}`;
  }
  // Pick the dragged scalar (the point closest to the first pointerdown)
  // rather than tracking every scalar. The harness's tracking_*, jerk,
  // and amplification metrics aggregate over `tracked.scalars`, so a
  // grab-bag of every scalar would average over points that aren't even
  // moving. That's how every other corpus manifest is shaped.
  const trackedScalars = pickTrackedScalars(session);
  const manifest = {
    version: 1,
    description: `Created from session ${safeId} (${session.frames.length} frames).`,
    session: `${finalName}.json`,
    tracked: {
      scalars: trackedScalars,
      cursorAxis: '$mouse.x',
    },
    ignore: { prefixFrames: 0, suffixFrames: 0 },
    hard: {
      hard_residual_max: { lte: 0.01 },
      p99_solve_ms: { lte: 16 },
    },
    advisory: {
      tracking_max_err_px: { goal_lte: 1 },
      stuck_fraction: { goal_lte: 0.05 },
      jerk_max: { goal_lte: 10 },
    },
    active: false,
  };
  try {
    await fs.promises.mkdir(CORPUS_DIR, { recursive: true });
    await fs.promises.writeFile(path.join(CORPUS_DIR, `${finalName}.json`), JSON.stringify(session));
    await fs.promises.writeFile(
      path.join(CORPUS_DIR, `${finalName}.manifest.json`),
      JSON.stringify(manifest, null, 2) + '\n',
    );
  } catch (e) {
    return { error: `write failed: ${e.message}` };
  }
  invalidateCache();
  // The test files are written; its gif is rendered REMOTELY (CI renders the
  // corpus on merge). No local render runs on the dash server.
  return { ok: true, name: finalName };
}

// Delete a corpus test: removes <name>.json + <name>.manifest.json, both
// substrate gifs, and the entry in the metrics baseline. Refuses to
// delete while a render job is in flight or queued for this name —
// otherwise files would land back on disk after we cleaned up.
async function deleteCorpusTest(name) {
  if (!name || typeof name !== 'string') return { error: 'name required' };
  if (!/^[A-Za-z0-9_\-]+$/.test(name)) return { error: 'invalid name' };
  const manifestPath = path.join(CORPUS_DIR, `${name}.manifest.json`);
  const sessionPath = path.join(CORPUS_DIR, `${name}.json`);
  if (!(await exists(manifestPath)) && !(await exists(sessionPath))) {
    return { error: 'test not found' };
  }
  const removed = [];
  for (const p of [manifestPath, sessionPath]) {
    if (await exists(p)) { await fs.promises.unlink(p); removed.push(path.basename(p)); }
  }
  // Gifs live in the bucket now — delete them there (needs the local service
  // key). If absent, skip gracefully rather than failing the whole delete.
  try {
    removed.push(...await deleteGifs(name));
  } catch (e) {
    removed.push(`gif-delete-skipped (${e.message})`);
  }
  // Drop baseline entry so the test doesn't reappear with stale metrics.
  const b = await readJSON(BASELINE);
  if (b?.gestures && name in b.gestures) {
    delete b.gestures[name];
    await fs.promises.writeFile(BASELINE, JSON.stringify(b, null, 2) + '\n');
    removed.push('baseline-entry');
  }
  invalidateCache();
  return { ok: true, removed };
}

async function corpusDetail(name) {
  const list = await listCorpus();
  const entry = list.find(e => e.name === name);
  if (!entry) return null;
  const session = await readJSON(path.join(CORPUS_DIR, `${name}.json`));
  const sessionMeta = session ? {
    frame_count: session.frames?.length || session.events?.length || null,
    code_version: session.context?.codeVersion || null,
    grid_mode: session.context?.gridMode ?? null,
    solver_mode: session.context?.solverMode || null,
  } : null;
  // Gifs from the bucket: the bench's own gif plus any variants, linked by
  // their public URL so the UI fetches them straight from storage.
  const gifs = (await listGifs())
    .filter(g => g.file === `${name}.gif` || g.file.startsWith(`${name}-`))
    .map(g => ({ experiment: g.experiment, file: g.file, url: gifPublicUrl(g.experiment, g.file) }));
  return { ...entry, session_meta: sessionMeta, gifs };
}


async function topLevelState() {
  // This is the polled /state endpoint (every 60s) — everything awaits so the
  // event loop that relays terminal keystrokes stays free while it gathers.
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const head = (await git(['log', '--oneline', '-1', 'HEAD'])).trim();
  const baseline = await readJSON(BASELINE);
  const branches = (await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])).split('\n').filter(Boolean);
  // Any non-trunk branch is outstanding work: merged branches get deleted,
  // rejected get a tag, so branch existence alone is the signal.
  const TRUNK = new Set(['main', 'master']);
  const pendingCount = branches.filter(b => !TRUNK.has(b)).length;
  return {
    branch,
    head,
    baseline_updated: baseline?.updated || null,
    baseline_code: baseline?.code || null,
    pending_count: pendingCount,
    in_flight_count: pendingCount,   // back-compat
    corpus_count: await fs.promises.readdir(CORPUS_DIR).then(fl => fl.filter(f => f.endsWith('.manifest.json')).length).catch(() => 0),
    // Board state lives in Supabase; if it's unreachable, leave the count null
    // rather than 500-ing the whole dashboard over one stat.
    change_count: await listChanges().then(c => (c || []).length).catch(() => null),
  };
}

// --- middleware factory ---

// No sweeps run in this middleware. Worktree collection — dev server, port,
// directory, branch — belongs to the reaper's own bounded five-minute sweep
// (reaper-sweep.mjs), which runs off the request path and only ever touches a
// workspace whose issue has retired AND whose chats have gone quiet. Nothing
// here does periodic git on a request.
export function dashApi() {
  return async (req, res, next) => {
    if (!req.url?.startsWith('/api/dash')) return next();
    res.setHeader('Cache-Control', 'no-store');
    const [pathname] = req.url.split('?');
    const segs = pathname.replace(/^\/api\/dash\/?/, '').split('/').filter(Boolean);
    const send = (data, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    try {
      // Optional cache invalidation
      if (req.url.includes('nocache=1')) invalidateCache();
      if (req.method === 'GET' && segs.length === 0) return send({ ok: true, hint: 'try /api/dash/state' });
      // Local-dev sign-in bypass: hand the browser a session minted from the
      // service token so localhost (and worktree preview links) never demand a
      // login. This route lives ONLY in the local dev middleware — it is never
      // deployed to Vercel — so production stays gated by RLS + the email
      // allow-list. The service token bypasses RLS, which is exactly what a
      // trusted local dev session wants.
      if (req.method === 'GET' && segs[0] === 'dev-session') {
        const key = process.env.DASH_SUPABASE_SERVICE_KEY;
        if (!key) return send({ error: 'no service key in env' }, 404);
        // WHO is at this machine? The local git identity — already set on every
        // dev's box (you can't commit without it), so a teammate's own profile
        // renders locally with zero config and no login prompt, on every worktree
        // port. It is the SAME account as signing in with that email the normal
        // way: both key on the lowercased email, so the profile, avatars, and
        // owner assignments are identical — only the token differs (service key
        // here, the user's JWT there). DASH_DEV_EMAIL overrides a git email that
        // isn't the allow-listed one; dev@localhost is the last resort when git
        // has no email configured at all.
        const gitEmail = await gitConfig('user.email');
        const email = (process.env.DASH_DEV_EMAIL || gitEmail || 'dev@localhost').trim().toLowerCase();
        // Populate the display name from git too, so names fill in without anyone
        // opening their profile — same zero-config source as the email.
        const name = await gitConfig('user.name');
        if (name) await seedProfileName(email, name);
        return send({
          access_token: key, refresh_token: 'dev', token_type: 'bearer',
          expires_at: 4102444800, user: { email },
        });
      }
      // Which stores the SUPERVISOR is pointed at: the Supabase project + run
      // tables, and the codex rollout tree. The Vite edge reports its separate
      // browser-bundle identity at /api/dash/edge-store; the test harness checks
      // both, so a correctly scoped supervisor cannot mask a production bundle.
      if (req.method === 'GET' && segs[0] === 'store') {
        const { URL, ANON } = await import('./supabase.mjs');
        const { TABLE } = await import('./issues-store.mjs');
        const { TABLE: PROFILES_TABLE } = await import('./profiles-store.mjs');
        const { CHATS_TABLE } = await import('./chat-mirror.mjs');
        const { CODEX_SESSIONS } = await import('./agents.mjs');
        const { RUN_ID } = await import('./run-scope.mjs');
        return send({
          url: URL, anonKey: ANON, table: TABLE, profilesTable: PROFILES_TABLE, chatsTable: CHATS_TABLE,
          codexSessions: CODEX_SESSIONS(), testRunId: RUN_ID,
        });
      }
      // Live context-window + LOC for one chat, rendered natively by the Dash
      // (chat-dropdown ring + code-pane LOC badge) so the terminal status bar is
      // gone. Each agent sources it its own way — claude from its statusline file,
      // codex from its rollout — behind ONE payload shape
      // ({ used, added, removed, compactAt }); chatStatusAny picks the right one by
      // uuid. The `session` param may be a bare uuid or a prefixed handle
      // (`codex:<uuid>`); parseHandle strips the prefix to the on-disk uuid. Empty
      // {} = no live data yet (or an unknown id). Ids are uuids; the regex still
      // guards against path traversal into the claude filename.
      if (req.method === 'GET' && segs[0] === 'chat-status') {
        const url = new URL(req.url, 'http://localhost');
        const session = url.searchParams.get('session') || '';
        if (!/^[A-Za-z0-9:_-]+$/.test(session)) return send({});
        const { sessionId } = parseHandle(session);
        return send(await chatStatusAny(sessionId) || {});
      }
      // The Code pane's two writes, both scoped to ONE issue worktree and both
      // reversible: `reset` parks the whole delta on a `refs/dash-reset/…` ref
      // and puts the worktree back on its base; `undo` restores from the pair of
      // shas the reset returned. See code-reset.mjs — the main checkout is
      // refused there, not here, so the rule lives with the operation.
      if (req.method === 'POST' && segs[0] === 'code' && segs[1] && (segs[2] === 'reset' || segs[2] === 'undo')) {
        const env = decodeURIComponent(segs[1]);
        let body = {};
        if (segs[2] === 'undo') {
          try { body = await readBody(req); } catch { return send({ error: 'invalid JSON body' }, 400); }
        }
        try {
          return send(segs[2] === 'reset' ? await resetWorkspace(env) : await undoReset(env, body));
        } catch (error) {
          if (error instanceof CodeBrowserError) return send({ error: error.message }, error.status);
          throw error;
        }
      }
      if (req.method === 'GET' && segs[0] === 'code' && segs[1]) {
        const env = decodeURIComponent(segs[1]);
        try {
          if (segs.length === 2) return send(await environmentSnapshot(env));
          if (segs.length === 3 && segs[2] === 'file') {
            const url = new URL(req.url, 'http://localhost');
            const q = url.searchParams;
            // The client passes what the tree snapshot already told it (status +
            // base sha) so the server can skip re-scanning the whole repo per open.
            const hint = q.get('baseSha')
              ? { baseSha: q.get('baseSha'), status: q.get('status') || null, oldPath: q.get('oldPath') || null, base: q.get('base') || null }
              : null;
            return send(await environmentFile(env, q.get('path'), hint));
          }
          return send({ error: 'unknown code endpoint' }, 404);
        } catch (error) {
          if (error instanceof CodeBrowserError) return send({ error: error.message }, error.status);
          throw error;
        }
      }
      if (req.method === 'GET' && segs[0] === 'state') return send(await memoAsync('state', 60000, topLevelState));
      // Issue text-search — the same matcher the board box and ⌘K palette use
      // (issue-search.js: id + title + tags, case-insensitive substring), exposed
      // so an agent can find issues headlessly instead of only through the UI.
      // Empty q returns every issue. GET /api/dash/search?q=…
      if (req.method === 'GET' && segs[0] === 'search') {
        const q = new URL(req.url, 'http://localhost').searchParams.get('q') || '';
        const hits = searchIssues(await listChanges(), q)
          .map(i => ({ id: i.id, title: i.title, status: i.status, tags: i.tags || [] }));
        return send({ query: q, count: hits.length, results: hits });
      }
      // Place: body { ids, status, after } — the cards in `ids` move into the
      // `status` column immediately after card `after` (omit/null for the top),
      // and that column renumbers ranks 0..n in one atomic write. Both board
      // gestures are this one call: a within-column reorder passes the column
      // the cards already sit in. Only the moved ids and the anchor are sent —
      // the server derives the rest of the column from its own rows, so a
      // concurrent edit by someone else is never undone (issues-store,
      // place_cards). Order is shared live across worktrees/machines.
      if (req.method === 'POST' && segs[0] === 'changes' && segs[1] === 'place') {
        let body;
        try { body = await readBody(req); } catch { return send({ error: 'invalid JSON body' }, 400); }
        const result = await placeChange(body?.ids, body?.status, body?.after);
        invalidateCache();
        return send(result, result.error ? 400 : 200);
      }
      // Dependency edit: body { id, field:'requires'|'unlocks', dep, add }.
      // Maintains the inverse (requires ⟺ unlocks) atomically server-side, the
      // programmatic twin of board.mjs' requires/unlocks verbs.
      if (req.method === 'POST' && segs[0] === 'changes' && segs[1] === 'dep') {
        let body;
        try { body = await readBody(req); } catch { return send({ error: 'invalid JSON body' }, 400); }
        const result = await changeDep(body?.id, body?.field, body?.dep, body?.add);
        invalidateCache();
        return send(result, result.error ? 400 : 200);
      }
      // Inline title rename from a card: body { id, title }.
      if (req.method === 'POST' && segs[0] === 'changes' && segs[1] === 'title') {
        let body;
        try { body = await readBody(req); } catch { return send({ error: 'invalid JSON body' }, 400); }
        const result = await renameChange(body?.id, body?.title);
        invalidateCache();
        return send(result, result.error ? 400 : 200);
      }
      // Realtime is now a browser-side Supabase subscription (dash/src/realtime.js),
      // the SAME path local and remote — there is no server SSE relay anymore.
      // ONE change management system: /api/dash/changes is the single board feed.
      // A change is a row in the Supabase issues table.
      if (req.method === 'GET' && segs[0] === 'changes' && segs.length === 1) return send(await memoAsync('changes', 30000, listChanges));
      if (req.method === 'GET' && segs[0] === 'changes' && segs[1]) {
        const cid = decodeURIComponent(segs.slice(1).join('/'));
        const item = await issueDetail(cid);
        return item ? send(item) : send({ error: 'not found' }, 404);
      }
      // Per-commit metric snapshots — recalced + pushed to the Supabase
      // metric_runs table by CI on every merge (scripts/snapshot-metrics.mjs
      // --remote). Powers the dashboard's sparkline trend view.
      if (req.method === 'GET' && segs[0] === 'stats-history' && segs.length === 1) {
        return send({ entries: await statsHistory() });
      }
      if (req.method === 'GET' && segs[0] === 'tests' && segs.length === 1) return send(await memoAsync('tests', 2000, listCorpus));
      if (req.method === 'POST' && segs[0] === 'tests' && segs[1] === 'create-from-session') {
        let body;
        try { body = await readBody(req); } catch { return send({ error: 'invalid JSON body' }, 400); }
        const result = await createTestFromSession(body || {});
        return send(result, result.error ? 400 : 200);
      }
      if (req.method === 'DELETE' && segs[0] === 'tests' && segs[1]) {
        const result = await deleteCorpusTest(decodeURIComponent(segs[1]));
        return send(result, result.error ? 400 : 200);
      }
      if (req.method === 'GET' && segs[0] === 'tests' && segs[1] && segs[2] === 'svg') {
        // Lossless SVG export of the session's initial state. The SVG
        // carries an embedded <artifact:data> fragment, so dragging it
        // into the main app (or pasting) restores the full constraint
        // graph — not just geometry. See src/svg.js exportSVG/importSVG.
        const name = decodeURIComponent(segs[1]);
        const sessionPath = path.join(CORPUS_DIR, `${name}.json`);
        const session = await readJSON(sessionPath);
        if (!session) return send({ error: 'session not found' }, 404);
        try {
          // Dynamic-import via file:// URLs so we reuse the real hydrate
          // + export paths rather than duplicating schema logic. ESM
          // import() wants a URL, not a filesystem path.
          const replayUrl = new URL('file://' + path.join(REPO, 'tests/solver-harness/replay.js')).href;
          const svgUrl    = new URL('file://' + path.join(REPO, 'src/svg.js')).href;
          const { hydrateState } = await import(replayUrl);
          const { exportSVG }    = await import(svgUrl);
          const state = hydrateState(session.state);
          const svg = exportSVG(state, { selection: new Set() });
          if (!svg) return send({ error: 'nothing exportable' }, 500);
          res.writeHead(200, {
            'Content-Type': 'image/svg+xml; charset=utf-8',
            'Content-Disposition': `attachment; filename="${name}.svg"`,
            'Cache-Control': 'public, max-age=300',
          });
          res.end(svg);
          return;
        } catch (e) {
          return send({ error: 'export failed: ' + e.message }, 500);
        }
      }
      if (req.method === 'GET' && segs[0] === 'tests' && segs[1]) {
        const item = await corpusDetail(decodeURIComponent(segs.slice(1).join('/')));
        return item ? send(item) : send({ error: 'not found' }, 404);
      }
      send({ error: 'unknown endpoint' }, 404);
    } catch (e) {
      send({ error: e.message, stack: e.stack }, 500);
    }
  };
}

// Serves /dash/gifs/<exp>/<file>. The canonical corpus subdir is bucket-backed
// (CI renders it) and is served bucket-FIRST — a stale/crashed local preview
// must never shadow the canonical gif. Experiment-branch captures still live
// on disk, so those serve local-first (else redirect, for safety).
export function gifsServe() {
  return async (req, res, next) => {
    if (!req.url?.startsWith('/dash/gifs/')) return next();
    const rel = decodeURIComponent(req.url.replace(/^\/dash\/gifs\//, '').split('?')[0]);
    const [experiment, ...rest] = rel.split('/');
    if (!experiment || rest.length === 0) { res.writeHead(404); res.end(); return; }
    // The bucket is the only source: CI renders the canonical corpus gifs there.
    res.writeHead(302, { Location: gifPublicUrl(experiment, rest.join('/')) });
    res.end();
  };
}
