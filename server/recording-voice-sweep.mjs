// The safety net: the box finishes what no server saw the end of.
//
// The FAST path is not here. When a recording is stopped through a server that
// holds the key — a checkout or a box, via /api/debug/sessions — that server
// transcribes it the moment it closes (dev/app-server.mjs), so the words are on
// the recording within seconds and nothing waits for a poll. This sweep exists
// for the two endings a server never sees: a tab that crashed (no close ever
// arrives) and a recording made on a deploy (the browser closed it straight to
// Supabase). It polls the shared bucket and catches both.
//
// A recording streams into the corpus as it happens (corpus-recording.mjs):
// the shell at start, a part every few seconds, the microphone beside it. Two
// things about that stream cannot be done by the browser that wrote it —
//
//   • transcribing the audio. The browser may store a file; it may not hold
//     GROQ_API_KEY. So the words are read here, where the key lives, by
//     scripts/transcribe-recording.mjs in a child process (ffmpeg, minutes of
//     network) — the same arrangement as recording-video-sweep.mjs, for the
//     same reason: the dash's event loop is shared with every terminal.
//
//   • finishing a recording nobody stopped. A tab that crashed at minute forty
//     left forty minutes of parts and a shell still marked open. Assembling
//     those into a recording is the browser's own stop, run for it — the same
//     assembleSession, marked `interrupted` — and it happens only when
//     abandonment is PROVABLE: the recorder stops itself at RECORDING_LIMIT_MS,
//     so a recording open past that plus a grace period has no browser behind
//     it by contract, not by guess.
//
// Recordings from before parts existed have no folder under parts/ and are
// never touched. A recording that fails is remembered for the life of the
// process and skipped, so one broken session cannot starve the queue; one
// without a key to transcribe with is finished but not marked, so a later pass
// with a key picks it up.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ABANDON_GRACE_MS, RECORDING_LIMIT_MS, assembleSession, closeSession, listParts,
  listRecordingsInProgress, loadFrameParts, saveVoice,
} from './corpus-recording.mjs';
import { loadSession } from './corpus-remote.mjs';

const SWEEP_MS = 60 * 1000;
const START_DELAY_MS = 45 * 1000;    // after the video sweep's first pass, not on top of it
const PASS_BUDGET_MS = 40 * 1000;
const TRANSCRIBE_TIMEOUT_MS = 10 * 60 * 1000;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Is this open recording provably without a browser? See RECORDING_LIMIT_MS.
export function abandoned(session, now = Date.now()) {
  return !!session?.open && Number(session.startTime) + RECORDING_LIMIT_MS + ABANDON_GRACE_MS < now;
}

function transcribeInChild(id) {
  return new Promise((resolve) => {
    execFile('node', ['scripts/transcribe-recording.mjs', id],
      { cwd: ROOT, timeout: TRANSCRIBE_TIMEOUT_MS, maxBuffer: 8 << 20 },
      (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, reason: (stderr || err.message).trim().split('\n').pop() });
        resolve({ ok: true, summary: stdout.trim().split('\n').pop() });
      });
  });
}

// Bring one streamed recording to rest. Returns what it found:
//   done         transcript already written
//   recording    still open, and within its limit — a browser may be writing
//   orphan       no shell — cancelled under us, or never opened
//   silent       closed, no audio (mic was off); marked so it is not revisited
//   transcribed  words written
//   untranscribed audio waiting for a key
//   failed       transcription failed; skipped for the life of the process
export async function settleRecording(id, { now = Date.now(), transcribe = transcribeInChild, canTranscribe = !!process.env.GROQ_API_KEY } = {}) {
  const parts = await listParts(id);
  if (parts.voice) return { id, state: 'done' };
  const session = await loadSession(id, { fresh: true });
  if (!session) return { id, state: 'orphan' };
  if (session.open) {
    if (!abandoned(session, now)) return { id, state: 'recording' };
    const frameParts = await loadFrameParts(id, parts.frames);
    const last = frameParts.reduce((m, p) => Math.max(m, Number(p.tEnd) || 0), 0);
    const endTime = Number(session.startTime) + last;
    const { session: whole, sceneSamples } = assembleSession(session, frameParts, { endTime, interrupted: true });
    await closeSession(id, whole, sceneSamples);
    console.log(`[recording-voice] ${id} finished for its absent browser: ${whole.frameCount} frames, ${parts.audio.length} audio parts`);
  }
  if (!parts.audio.length) { await saveVoice(id, []); return { id, state: 'silent' }; }
  if (!canTranscribe) return { id, state: 'untranscribed' };
  const result = await transcribe(id);
  if (!result.ok) { console.warn(`[recording-voice] ${id} failed, skipping: ${result.reason}`); return { id, state: 'failed' }; }
  console.log(`[recording-voice] ${id} ${result.summary}`);
  return { id, state: 'transcribed' };
}

const settled = new Set();   // ids this process has brought to rest
const failed = new Set();    // ids this process has already failed on

export async function voiceSweep() {
  if (!process.env.DASH_SUPABASE_SERVICE_KEY) return { settled: 0, reason: 'no service key' };
  const ids = await listRecordingsInProgress();
  let count = 0;
  const until = Date.now() + PASS_BUDGET_MS;
  for (const id of ids) {
    if (settled.has(id) || failed.has(id)) continue;
    if (Date.now() >= until) break;   // checked BEFORE each, never mid-transcription
    try {
      const { state } = await settleRecording(id);
      if (state === 'done' || state === 'orphan' || state === 'silent' || state === 'transcribed') { settled.add(id); count++; }
      else if (state === 'failed') failed.add(id);
    } catch (e) {
      failed.add(id);
      console.warn(`[recording-voice] ${id} failed, skipping: ${e.message}`);
    }
  }
  return { settled: count };
}

let started = false;
export function startVoiceSweep() {
  if (started) return;   // once per process
  started = true;
  let inFlight = false;
  const safe = async () => {
    if (inFlight) return;   // passes never overlap — a transcription can outlast a tick
    inFlight = true;
    try { await voiceSweep(); }
    catch (e) { console.error('[recording-voice] sweep failed:', e.message); }
    finally { inFlight = false; }
  };
  setTimeout(safe, START_DELAY_MS).unref?.();
  setInterval(safe, SWEEP_MS).unref?.();
}
