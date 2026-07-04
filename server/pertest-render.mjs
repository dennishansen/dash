// pertest-render.mjs — instant local preview render for a single corpus test.
//
// CI is the canonical renderer (it renders the whole corpus on every merge),
// but when a user adds a test from a session in Dash they want to see its
// gif now — not after a commit + CI cycle. CI can't help here: it renders from
// the committed repo, and a just-created test isn't committed yet. So we render
// that one bench locally and upload it to the corpus-gifs bucket, then drop the
// local copy (the bucket is the gif's home). Best-effort: if the local render
// fails (canvas/ffmpeg/env), the test files are still written and CI renders it
// canonically on the next merge.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { invalidateGifCache } from './corpus-remote.mjs';

const CURRENT_STATE = '2026-04-20-current-state';
const DONE_TTL_MS = 5 * 60_000;

export function createPerTestRenderer({ repo }) {
  // name -> { phase: rendering|uploading|done|error, startedAt, doneAt, elapsedMs, error }
  const jobs = new Map();

  function finish(name, error) {
    const j = jobs.get(name) || { startedAt: Date.now() };
    jobs.set(name, {
      ...j,
      phase: error ? 'error' : 'done',
      doneAt: Date.now(),
      elapsedMs: Date.now() - j.startedAt,
      error,
    });
  }

  function start(name) {
    jobs.set(name, { phase: 'rendering', startedAt: Date.now(), doneAt: null, error: null });
    const gif = path.join(repo, 'docs/solver-lab/gifs', CURRENT_STATE, `${name}.gif`);
    const render = spawn('node', ['scripts/render-all-corpus-gifs.mjs', '--only', name], {
      cwd: repo, env: { ...process.env, HARNESS_SNAP_TO_GRID: '0' }, stdio: ['ignore', 'ignore', 'ignore'],
    });
    render.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(gif)) {
        finish(name, `local render failed (exit ${code}); CI will render it on the next merge`);
        return;
      }
      const job = jobs.get(name);
      if (job) job.phase = 'uploading';
      const up = spawn('node', ['scripts/upload-corpus-gifs.mjs', '--only', CURRENT_STATE], {
        cwd: repo, env: process.env, stdio: ['ignore', 'ignore', 'pipe'],
      });
      let upErr = '';
      up.stderr.on('data', (d) => { upErr += d.toString(); });
      up.on('close', (upCode) => {
        try { fs.unlinkSync(gif); } catch {}    // bucket is the home; drop local
        // The new object isn't in listGifs()'s 60s cache yet; drop it so the
        // next /api/dash/tests poll sees has_gif and stops showing "pending".
        invalidateGifCache();
        finish(name, upCode === 0 ? null : `upload failed (need DASH_SUPABASE_SERVICE_KEY): ${upErr.trim().slice(-160)}`);
      });
    });
  }

  function getJobFor(name) {
    const j = jobs.get(name);
    if (!j) return null;
    if (j.doneAt && Date.now() - j.doneAt > DONE_TTL_MS) { jobs.delete(name); return null; }
    return {
      phase: j.phase,
      startedAt: j.startedAt,
      doneAt: j.doneAt,
      elapsedMs: j.elapsedMs ?? (Date.now() - j.startedAt),
      error: j.error,
    };
  }

  return { start, getJobFor };
}
