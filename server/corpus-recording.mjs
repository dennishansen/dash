// A recording IN PROGRESS — the half of the corpus that exists between a person
// pressing ⌥` and pressing stop.
//
// Until this existed a recording was written ONCE, at stop, from memory. So it
// existed nowhere until it was over: a tab that crashed at minute forty took
// forty minutes of frames and every spoken word with it, and the code on the
// panel named nothing until the last second. The August 26 user test lost 57
// minutes of narration the same way (i-recording-voice-missing) — not to a
// crash, but the shape was identical: everything about a recording lived in
// one place, in RAM, behind a single write at the end that could fail silently.
//
// So a recording is a STREAM into the bucket, keyed from the first second:
//
//   <id>.json                                the shell at start (open: true);
//                                            the whole recording at stop
//   parts/<id>/frames/<seq>.json             every PART_MS: the frames and
//                                            scene samples since the last part
//   parts/<id>/audio/<seq>_<t>_<tEnd>.webm   every PART_MS of microphone,
//                                            while the mic is on
//   parts/<id>/voice.json                    the transcript, written later by
//                                            the sweep on the box that holds
//                                            GROQ_API_KEY (recording-voice-sweep)
//
// The canonical <id>.json is a MATERIALIZATION of the parts, and exactly one
// function does it — assembleSession — used by the browser at stop over the
// parts it just wrote, and by the sweep for a recording nobody stopped over the
// parts it downloads. Same function, same bytes: the crash path is exercised by
// every ordinary stop rather than kept for the day it is needed.
//
// Audio is kept, not just its words. A transcript is a one-shot guess by one
// model on one day; the audio can be re-read, by better models or by a person,
// and it is what lets a page with no server of its own — artifact.xyz — carry
// voice at all: the browser needs no key to store a file, only to transcribe
// it, and transcription happens wherever the key already lives.
//
// Cancel deletes all of it. A person may throw their own recording away
// (20260827223000_corpus_sessions_discard_own.sql); nothing else in the
// product removes one.

import {
  deleteObjects, listBucketObjects, publicUrl, putObject,
} from './supabase.mjs';
import { SESSIONS_BUCKET, loadSession, saveNewSession, saveSession } from './corpus-remote.mjs';

// The tick: how often the browser writes what it has. Also the audio chunk
// length, so one clock governs both streams. Ten seconds is the most a crash
// can take.
export const PART_MS = 10_000;

// A recording stops itself here, and the panel shows the limit throughout. The
// number does two jobs: it bounds what a forgotten tab can accumulate, and it
// is what makes "abandoned" PROVABLE for the sweep — a recording still open
// past this plus ABANDON_GRACE_MS has no browser behind it by contract, not by
// inference.
export const RECORDING_LIMIT_MS = 2 * 60 * 60 * 1000;
export const ABANDON_GRACE_MS = 10 * 60 * 1000;

const PARTS = 'parts';
const pad = (n) => String(n).padStart(5, '0');

export const partsPrefix = (id) => `${PARTS}/${id}/`;
export const partKey = (id, kind, name) => `${PARTS}/${id}/${kind}/${name}`;
export const voiceKey = (id) => `${PARTS}/${id}/voice.json`;
export const framePartName = (seq) => `${pad(seq)}.json`;
// The audio part's clock is in its NAME, so the sweep can lay every chunk on
// the recording's timeline from one listing without downloading anything.
export const audioPartName = (seq, t, tEnd) => `${pad(seq)}_${t}_${tEnd}.webm`;
const AUDIO_RE = /^(\d{5})_(\d+)_(\d+)\.webm$/;

export function parseAudioPartName(name) {
  const m = AUDIO_RE.exec(name);
  return m ? { name, seq: Number(m[1]), t: Number(m[2]), tEnd: Number(m[3]) } : null;
}

// --- the writes, in the order a recording makes them ------------------------

// Start: the shell. Insert-only under the minted id, reassigned on a collision
// (saveNewSession's rule), so the id on the panel is settled before any part
// is written under it. `open: true` is the one field that says "not over".
export function openSession(id, shell) {
  return saveNewSession(id, { ...shell, open: true });
}

// Every tick: one part. Upsert, so a retry of a part that did land is a no-op
// rather than a second id.
export function savePart(id, kind, name, body, contentType) {
  return putObject(SESSIONS_BUCKET, partKey(id, kind, name), body, contentType, { upsert: true });
}

// Stop: the whole recording over the shell. The scene-sample sidecar rides
// along exactly as before; readers of <id>.json see what they always saw.
export function closeSession(id, session, sceneSamples = null) {
  return saveSession(id, { ...session, id }, sceneSamples, { upsert: true });
}

// The one materialization. `parts` are `{ seq, t, tEnd, frames, sceneSamples }`
// in any order; the shell is what openSession wrote. `interrupted` marks a
// recording the sweep finished for somebody — it has no finalState, because
// nobody was there to capture one.
export function assembleSession(shell, parts, { finalState = null, endTime, interrupted = false } = {}) {
  const { open, ...rest } = shell;
  const ordered = [...parts].sort((a, b) => a.seq - b.seq);
  const frames = ordered.flatMap((p) => p.frames || []);
  const sceneSamples = ordered.flatMap((p) => p.sceneSamples || []);
  const session = { ...rest, endTime, frameCount: frames.length, frames };
  if (finalState) session.finalState = finalState;
  if (interrupted) session.interrupted = true;
  return { session, sceneSamples };
}

// Cancel: everything under the id, parts first. The DELETE endpoint takes
// exact keys, so the folder is listed to be emptied.
export async function deleteRecording(id) {
  const { frames, audio, voice } = await listParts(id);
  const keys = [
    ...frames.map((p) => partKey(id, 'frames', p.name)),
    ...audio.map((p) => partKey(id, 'audio', p.name)),
    ...(voice ? [voiceKey(id)] : []),
    `${id}.json`,
    `${id}.scene-samples.jsonl`,
  ];
  return deleteObjects(SESSIONS_BUCKET, keys);
}

// --- the reads the sweep makes ----------------------------------------------

const list = (prefix) => listBucketObjects(SESSIONS_BUCKET, prefix, { limit: 5000 }).catch(() => []);

// What a recording has streamed so far. Three listings, no downloads: the
// frames parts by seq, the audio parts with their clocks read off their names,
// and whether the transcript has been written.
export async function listParts(id) {
  const [root, frames, audio] = await Promise.all([
    list(partsPrefix(id)), list(`${partsPrefix(id)}frames/`), list(`${partsPrefix(id)}audio/`),
  ]);
  const files = (rows) => rows.filter((r) => r && r.id);
  return {
    voice: files(root).some((r) => r.name === 'voice.json'),
    frames: files(frames)
      .filter((r) => /^\d{5}\.json$/.test(r.name))
      .map((r) => ({ name: r.name, seq: Number(r.name.slice(0, 5)), url: publicUrl(SESSIONS_BUCKET, partKey(id, 'frames', r.name)) }))
      .sort((a, b) => a.seq - b.seq),
    audio: files(audio)
      .map((r) => parseAudioPartName(r.name))
      .filter(Boolean)
      .map((p) => ({ ...p, url: publicUrl(SESSIONS_BUCKET, partKey(id, 'audio', p.name)) }))
      .sort((a, b) => a.seq - b.seq),
  };
}

// Every id that has streamed anything — the folders under parts/. Recordings
// from before parts existed never appear here and are never touched.
export async function listRecordingsInProgress() {
  const rows = await list(`${PARTS}/`);
  return rows.filter((r) => r && !r.id && r.name).map((r) => r.name);
}

// The frame parts themselves, for assembly. Fresh reads: a part is written once
// under a key nobody has read before, so the CDN has nothing stale to offer.
export async function loadFrameParts(id, parts) {
  return Promise.all(parts.map(async (p) => {
    const res = await fetch(p.url);
    if (!res.ok) throw new Error(`frame part ${p.name} of ${id}: ${res.status}`);
    return res.json();
  }));
}

// The transcript, and where it goes: its own object (which is also the marker
// the sweep reads to know it has been here) and, when there are words, onto the
// recording itself where every reader already looks for `voice`.
//
// The recording is re-read FRESH before the amend. <id>.json was first written
// as a shell at start and may well have been read since; the CDN's five-minute
// copy of that shell is exactly the thing that must not be what `voice` is
// merged onto.
export async function saveVoice(id, voice) {
  await putObject(SESSIONS_BUCKET, voiceKey(id), JSON.stringify(voice), 'application/json', { upsert: true });
  if (!voice.length) return;
  const session = await loadSession(id, { fresh: true });
  if (!session) return;
  await saveSession(id, { ...session, voice }, null, { upsert: true });
}
