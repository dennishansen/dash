// archive-watcher.js — worktree lifecycle janitor. Two automatic sweeps every
// POLL_MS:
//
// 1. Branch archiving. A branch is "terminal" when either
//    (1) its tip is an ancestor of main (the merge commit IS the record), OR
//    (2) a `rejected/*` tag points at its tip (the tag IS the gravestone).
//    Once terminal, the branch ref is just clutter — the tip is preserved by
//    the merge or the tag — so we delete it via `git branch -D`. The `-D` is
//    safe precisely because terminality means the commit is reachable from a
//    permanent ref. Skips: trunk; the current HEAD branch; unresolved tips.
//
// 2. Dev-server reaping. Each worktree change-session spawns its own vite dev
//    server; nothing tore them down, so they piled up across sessions until
//    file-watchers + esbuild thrashed memory into swap. When `git worktree
//    remove` deletes a worktree dir (e.g. during /merge), the bound vite
//    server is orphaned — its cwd points at a path that no longer exists.
//    We detect that (lsof still reports the original cwd; existsSync is false)
//    and SIGTERM the server. Scoped to vite procs under this repo's worktrees,
//    and only when the dir is provably gone — never the live main checkout.
//
// CONCURRENCY CONTRACT: every external command runs ASYNCHRONOUSLY. This file
// loads inside the vite dev server's event loop, so a synchronous spawn would
// freeze HTTP handling for the duration of the child process. Under multiple
// concurrent dev servers all sweeping the same .git every POLL_MS, git refs
// operations contend on locks and `lsof` is slow — sync spawns turned that
// contention into multi-second event-loop freezes (the dev server bound its
// port but answered no requests: a black screen with no error). Async spawns
// keep the server responsive while git/lsof wait. A sweep also never overlaps
// itself: if one is still running when the interval fires, the tick is skipped.

import { spawn } from 'child_process';
import { existsSync, realpathSync } from 'fs';

const POLL_MS = 5_000;
const TRUNK = new Set(['main', 'master']);

// Async spawn → { ok, out, status }. Never blocks the event loop, so a slow or
// lock-contended child can't freeze the dev server's request handling.
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, opts);
    } catch {
      resolve({ ok: false, out: '', err: 'spawn failed', status: -1 });
      return;
    }
    let out = '', err = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', d => { out += d; });
    child.stderr?.on('data', d => { err += d; });
    child.on('error', () => resolve({ ok: false, out: '', err: 'spawn error', status: -1 }));
    child.on('close', (code) => resolve({ ok: code === 0, out: out.trim(), err: err.trim(), status: code }));
  });
}

export function startArchiveWatcher({ repo }) {
  // Resolve symlinks once: lsof reports real paths (e.g. /tmp → /private/tmp on
  // macOS), so the orphan-scope check must compare against the real repo path.
  let repoReal; try { repoReal = realpathSync(repo); } catch { repoReal = repo; }

  const state = {
    enabled: true,
    lastCheckedAt: null,
    lastSweep: null,    // { at, archived: [{ name, sha, reason }], skipped: [...] }
    totalArchived: 0,
    lastReaped: null,   // [{ pid, cwd }] dev servers killed last sweep
    totalReaped: 0,
  };

  function git(args) {
    return run('git', args, { cwd: repo });
  }

  async function currentBranch() {
    const r = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return r.ok ? r.out : null;
  }

  async function rejectedShas() {
    const r = await git(['for-each-ref', '--format=%(objectname)', 'refs/tags/rejected/']);
    if (!r.ok) return new Set();
    return new Set(r.out.split('\n').map(s => s.trim()).filter(Boolean));
  }

  async function isMerged(sha, into) {
    const r = await git(['merge-base', '--is-ancestor', sha, into]);
    return r.status === 0;
  }

  // cwd of `pid` via lsof. macOS/Linux still report the ORIGINAL path after the
  // directory is deleted, so the caller's existsSync() is the orphan test.
  async function cwdOf(pid) {
    const r = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    if (!r.ok) return null;
    const n = r.out.split('\n').find(l => l.startsWith('n'));
    return n ? n.slice(1) : null;
  }

  // Kill vite dev servers whose worktree dir has been removed (e.g. by /merge's
  // `git worktree remove`). Scoped to this repo's worktrees and only when the
  // cwd is provably gone — never the live main checkout or another project.
  async function reapOrphanedDevServers() {
    const pg = await run('pgrep', ['-f', 'node.*vite']);
    if (!pg.ok || !pg.out) return [];
    const reaped = [];
    for (const s of pg.out.split('\n')) {
      const pid = parseInt(s.trim(), 10);
      if (!pid || pid === process.pid) continue;
      const cwd = await cwdOf(pid);
      if (!cwd || !cwd.startsWith(repoReal) || !cwd.includes('/worktrees/')) continue;
      if (existsSync(cwd)) continue; // worktree still on disk — leave it
      try { process.kill(pid, 'SIGTERM'); reaped.push({ pid, cwd }); state.totalReaped++; }
      catch { /* already gone / not ours */ }
    }
    return reaped;
  }

  async function sweep() {
    const checkedAt = new Date().toISOString();
    state.lastCheckedAt = checkedAt;

    // Reap first — independent of branch archiving, so a git hiccup below can't
    // skip it.
    state.lastReaped = await reapOrphanedDevServers();

    const head = await currentBranch();
    const trunk = await git(['rev-parse', 'main']);
    if (!trunk.ok) {
      state.lastSweep = { at: checkedAt, archived: [], skipped: [{ name: 'main', reason: 'rev-parse failed' }] };
      return;
    }

    const rejected = await rejectedShas();
    const refs = await git(['for-each-ref', '--format=%(refname:short)\t%(objectname)', 'refs/heads/']);
    if (!refs.ok) return;

    const archived = [];
    const skipped = [];

    for (const line of refs.out.split('\n')) {
      const [name, sha] = line.split('\t');
      if (!name || !sha) continue;
      if (TRUNK.has(name)) continue;
      if (name === head) { skipped.push({ name, reason: 'HEAD' }); continue; }

      let reason = null;
      if (await isMerged(sha, trunk.out)) reason = 'merged';
      else if (rejected.has(sha)) reason = 'rejected';
      if (!reason) continue;

      const del = await git(['branch', '-D', name]);
      if (del.ok) {
        archived.push({ name, sha: sha.slice(0, 8), reason });
        state.totalArchived++;
      } else {
        skipped.push({ name, reason: `delete-failed: ${del.err}` });
      }
    }

    state.lastSweep = { at: checkedAt, archived, skipped };
  }

  // Never let a slow sweep stack on top of itself — under lock contention a
  // sweep can outlast POLL_MS, and overlapping sweeps would multiply git load.
  let sweeping = false;
  function tick() {
    if (sweeping) return;
    sweeping = true;
    sweep().catch(() => {}).finally(() => { sweeping = false; });
  }

  // Run once at startup, then on interval.
  tick();
  const handle = setInterval(tick, POLL_MS);

  return {
    getStatus: () => ({ ...state, intervalMs: POLL_MS }),
    stop: () => clearInterval(handle),
  };
}
