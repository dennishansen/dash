// The box renders the videos nobody can render for themselves.
//
// A recording is a list of input events; watching one means replaying it through
// the app and encoding the frames — node, an offscreen canvas, ffmpeg. Supabase
// cannot do that (Deno, no ffmpeg, no checkout) and neither can a browser, so it
// happens HERE, next to a checkout, and the result goes in the public gif bucket.
// Render in one place, watch anywhere: the deploy shows the same video with no
// backend of its own, exactly as it already shows gifs.
//
// WHAT KEEPS THIS HONEST ABOUT COST. The dash shares one event loop with every
// attached terminal, and a render is 4s for a short recording and 40s for a long
// one (~45ms/frame, measured). So it runs in a CHILD PROCESS, one at a time,
// never overlapping — a sweep that blocked the loop for forty seconds would
// freeze every terminal on the box. Between passes it costs two bucket listings.
//
// WHAT IT WILL NOT DO:
//   • the `tests/` namespace — 670 machine fixtures, most of them throwaway runs
//     nobody will ever open. That is six hours of CPU for nothing (see
//     i-session-corpus-retention).
//   • re-render. A video's key carries the sha it was rendered at; when the code
//     moves on, the detail page SAYS the video is older rather than silently
//     spending the box's evening re-rendering the corpus. Faithfulness is its
//     own problem — i-faithful-recordings.
//   • retry forever. A recording that fails to render is remembered for the life
//     of the process and skipped, so one broken session cannot starve the queue.

import { execFile, execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRecordings, listRecordingVideos, recordingVideoKey } from './corpus-remote.mjs';

const SWEEP_MS = 60 * 1000;
const START_DELAY_MS = 30 * 1000;    // let the supervisor boot, and its terminals settle
// A pass is bounded by TIME, not by a count. Renders differ by an order of
// magnitude (4s for a 30-frame recording, 40s for an 800-frame one), so "three
// per pass" is either a crawl through a backlog or a long stall — the same
// number meaning two different things. A budget means the same thing either way:
// the box spends at most this long per minute on videos, so a cold corpus drains
// in an hour or so and the steady state is one render whenever somebody records.
const PASS_BUDGET_MS = 40 * 1000;
const CORPUS_DEPTH = 200;            // how far back to keep videos for
const RENDER_TIMEOUT_MS = 10 * 60 * 1000;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The sha this box would render AT. Same shape the recorder stamps into a
// session (`dev/app-server.mjs` codeVersion), so the two are comparable: 12 hex,
// `-dirty` when the tree had uncommitted work — which is itself worth carrying,
// since a video rendered from a dirty tree is not reproducible from any commit.
export function renderCodeVersion() {
  try {
    const sha = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim().slice(0, 12);
    const dirty = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).trim().length > 0;
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return null;
  }
}

// Render one recording to `recordings/<id>.<sha>.mp4`. A child process, because
// this is seconds-to-minutes of CPU and the dash's event loop is shared.
//
// `--no-humanize` on purpose: humanization exists to slow a test-pace session
// into something watchable, and a person's recording is already at a person's
// pace. Humanizing it would invent motion that never happened.
function renderOne(id, renderedAt) {
  return new Promise((resolve) => {
    const args = [
      'scripts/render-session.mjs', id,
      '--upload', recordingVideoKey(id, renderedAt),
      '--mode', 'full-ui',
      '--no-humanize',
    ];
    execFile('node', args, { cwd: ROOT, timeout: RENDER_TIMEOUT_MS, maxBuffer: 8 << 20 },
      (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, reason: (stderr || err.message).trim().split('\n').pop() });
        // render-session prints the animation's URL on its own line and the
        // poster's behind a label — take the one that is only a url, not simply
        // the last thing printed.
        const url = stdout.trim().split('\n').map(l => l.trim())
          .find(l => l.startsWith('http') && l.endsWith('.mp4'));
        resolve(url ? { ok: true, url } : { ok: false, reason: 'render printed no mp4 url' });
      });
  });
}

const failed = new Set();   // ids this process has already failed on

export async function videoSweep() {
  const renderedAt = renderCodeVersion();
  if (!renderedAt) return { rendered: 0, reason: 'not a git checkout' };
  if (!process.env.DASH_SUPABASE_SERVICE_KEY) return { rendered: 0, reason: 'no service key' };

  const [recordings, videos] = await Promise.all([
    listRecordings({ namespace: 'session', limit: CORPUS_DEPTH }),
    listRecordingVideos(),
  ]);
  // Newest first is the order they arrive in, and the order to render in: the
  // recording somebody made a minute ago is the one they are about to open.
  const missing = recordings.filter(r => !videos.has(r.id) && !failed.has(r.id));

  let rendered = 0;
  const until = Date.now() + PASS_BUDGET_MS;
  for (const rec of missing) {
    // Checked BEFORE each render, never mid-render: a started render always
    // finishes, so nothing is half-uploaded and no key is left promising a video
    // that does not exist.
    if (Date.now() >= until) break;
    const result = await renderOne(rec.id, renderedAt);
    if (result.ok) {
      rendered++;
      console.log(`[recording-video] ${rec.id} → ${result.url}`);
    } else {
      failed.add(rec.id);
      console.warn(`[recording-video] ${rec.id} failed, skipping: ${result.reason}`);
    }
  }
  return { rendered, pending: Math.max(0, missing.length - rendered) };
}

let started = false;
export function startVideoSweep() {
  if (started) return;   // once per process
  started = true;
  let inFlight = false;
  const safe = async () => {
    if (inFlight) return;   // passes never overlap — a render can outlast a tick
    inFlight = true;
    try { await videoSweep(); }
    catch (e) { console.error('[recording-video] sweep failed:', e.message); }
    finally { inFlight = false; }
  };
  setTimeout(safe, START_DELAY_MS).unref?.();
  setInterval(safe, SWEEP_MS).unref?.();
}
