// Dash API — read-only endpoints under /api/dash/*
//
// Serves the Dash UI sidecar at /dash/. All endpoints parse files/git in real
// time; no caching, no DB. Freshness comes from disk/Supabase on every read.

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { startArchiveWatcher } from './archive-watcher.js';
import { listChanges, issueDetail, reorderChanges, moveChange, renameChange, createChange } from './dash-issues.js';
import { CodeBrowserError, environmentSnapshot, environmentFile } from './code-browser.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..', '..');

// --- helpers ---

// Run git from REPO using spawnSync — no shell, so format strings with
// special chars like '%(refname)' don't get interpreted as subshells.
// `args` is an array of git args, e.g. ['log', '--oneline', '-5'].
function git(args) {
  if (typeof args === 'string') args = args.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(s => s.replace(/^"|"$/g, '')) || [];
  try {
    const r = spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });
    if (r.status !== 0) return '';
    return r.stdout || '';
  } catch { return ''; }
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

// Tiny in-process memoization with TTL. The board writes occasionally; for list
// views a short TTL is fine. The UI can force a refresh by calling
// /api/dash/changes?nocache=1 or using the refresh button.
//
// Stored on globalThis so vite HMR reloading the module doesn't drop it.
if (!globalThis.__labCache) globalThis.__labCache = new Map();
const cache = globalThis.__labCache;
function invalidateCache() { cache.clear(); }
// Async memo for handlers whose producer awaits I/O (e.g. the board-state fetch
// behind listChanges). Rejections are not cached — a failed fetch shouldn't
// poison the TTL window.
async function memoAsync(key, ttlMs, fn) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && hit.expiry > now) return hit.value;
  const value = await fn();
  cache.set(key, { value, expiry: now + ttlMs });
  return value;
}

// --- top-level state (sidebar) ---

async function topLevelState() {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const head = git(['log', '--oneline', '-1', 'HEAD']).trim();
  return {
    branch,
    head,
    // Board state lives in Supabase; if it's unreachable, leave the count null
    // rather than 500-ing the whole sidebar over one stat.
    change_count: await listChanges().then(c => (c || []).length).catch(() => null),
  };
}

// --- middleware factory ---

// Pinned to globalThis, NOT a module-level binding: vite restarts its dev
// server by re-evaluating this module in the same process, which would reset a
// module-level `let` to null and start a SECOND watcher while the first one's
// setInterval leaks. A process-global survives re-eval, so exactly one watcher
// runs per process no matter how many times vite restarts.
function archiveWatcher() {
  if (!globalThis.__artifactArchiveWatcher) {
    globalThis.__artifactArchiveWatcher = startArchiveWatcher({ repo: REPO });
  }
  return globalThis.__artifactArchiveWatcher;
}

export function dashApi() {
  archiveWatcher(); // auto-archive merged or rejected branches
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
        return send({
          access_token: key, refresh_token: 'dev', token_type: 'bearer',
          expires_at: 4102444800, user: { email: process.env.DASH_DEV_EMAIL || 'dev@localhost' },
        });
      }
      // Code browser: a read-only view of an issue worktree's files. `env` is the
      // issue/environment id; GET /code/<env> is the file-tree snapshot, and
      // GET /code/<env>/file?path=… returns one file's contents (see code-browser.mjs).
      if (req.method === 'GET' && segs[0] === 'code' && segs[1]) {
        const env = decodeURIComponent(segs[1]);
        try {
          if (segs.length === 2) return send(await environmentSnapshot(env));
          if (segs.length === 3 && segs[2] === 'file') {
            const u = new URL(req.url, 'http://localhost');
            return send(await environmentFile(env, u.searchParams.get('path')));
          }
          return send({ error: 'unknown code endpoint' }, 404);
        } catch (error) {
          if (error instanceof CodeBrowserError) return send({ error: error.message }, error.status);
          throw error;
        }
      }
      if (req.method === 'GET' && segs[0] === 'state') return send(await memoAsync('state', 60000, topLevelState));
      // Reorder: body { ids: [...] } → each change's rank = its index, written
      // to the issues table in Supabase (issues-store, set_ranks). Status is
      // untouched, so dragging a card within a column never changes its column
      // and the order is shared live across worktrees/machines.
      if (req.method === 'POST' && segs[0] === 'changes' && segs[1] === 'reorder') {
        let body;
        try { body = await readBody(req); } catch { return send({ error: 'invalid JSON body' }, 400); }
        const result = await reorderChanges(body?.ids);
        invalidateCache();
        return send(result, result.error ? 400 : 200);
      }
      // Move: body { status, ids } where ids is the target column's FINAL
      // ordering (dragged card inserted at the drop slot). Sets every card's
      // status to that column and renumbers ranks 0..n in one atomic bulk write
      // — the cross-column drag (issues-store, move_column).
      if (req.method === 'POST' && segs[0] === 'changes' && segs[1] === 'move') {
        let body;
        try { body = await readBody(req); } catch { return send({ error: 'invalid JSON body' }, 400); }
        const result = await moveChange(body?.status, body?.ids);
        invalidateCache();
        return send(result, result.error ? 400 : 200);
      }
      // Create: body { status, ids } where ids is the column's existing issue
      // ordering — the new blank issue is ranked ahead of it (top of column).
      // Returns { id } so the client can open the new issue's detail.
      if (req.method === 'POST' && segs[0] === 'changes' && segs[1] === 'create') {
        let body;
        try { body = await readBody(req); } catch { return send({ error: 'invalid JSON body' }, 400); }
        const result = await createChange(body?.status, body?.ids);
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
      // A change is a row in the Supabase issues table; live in-flight branches
      // are folded in (see listChanges).
      if (req.method === 'GET' && segs[0] === 'changes' && segs.length === 1) return send(await memoAsync('changes', 30000, listChanges));
      if (req.method === 'GET' && segs[0] === 'changes' && segs[1]) {
        const cid = decodeURIComponent(segs.slice(1).join('/'));
        const item = await issueDetail(cid);
        return item ? send(item) : send({ error: 'not found' }, 404);
      }
      // Archive watcher status — last sweep's archived/skipped branches,
      // counters, poll interval. Useful for verifying the auto-archive is
      // alive and seeing which branches got swept.
      if (req.method === 'GET' && segs[0] === 'archive-status' && segs.length === 1) {
        return send(archiveWatcher().getStatus());
      }
      send({ error: 'unknown endpoint' }, 404);
    } catch (e) {
      send({ error: e.message, stack: e.stack }, 500);
    }
  };
}
