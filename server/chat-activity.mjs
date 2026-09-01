// Working / needs-input detection for every live chat on this machine — the
// SUPERVISOR's job, not a browser pane's.
//
// It used to run in whichever browser pane happened to own a chat
// (session-pool ownership). That made a UI-lifecycle event — mount, unmount,
// ownership handoff — restart the detector, so dots blinked through unknown
// states on every board load and disagreed between two viewers of the same
// board. Detection was never a per-viewer concern: the supervisor owns the
// PTYs and already reads every byte they emit, so it is the one place that can
// answer "is this chat working?" once, for everybody, for as long as the chat
// lives.
//
// THE SIGNAL IS UNCHANGED. The grammar still reads the RENDERED VIEWPORT, not
// the raw stream (see src/spinner.js for why the stream is an unreliable
// proxy), and it is still the SAME code: viewportText + the agent adapter's
// isWorking, imported from src/. What moved is only WHO runs it and WHERE the
// grid comes from — a headless xterm fed by pty.onData instead of the xterm
// the browser was painting. Same emulator, same version (@xterm/headless is
// xterm.js's node build, pinned to the same beta as @xterm/xterm), so the grid
// the supervisor reads is the grid the pane would have shown.
//
// One 300ms sampler for the whole machine, not one per session: the tick is a
// clock, and N chats sharing it is N buffer reads, not N timers.

import headless from '@xterm/headless';
import { viewportText } from '../src/spinner.js';
import { agentById } from '../src/agents.js';

const { Terminal } = headless;

// Why a chat is in the state it is in, in one line. Detection is a judgement
// about a screen nobody is looking at, so when it disagrees with a human the
// only way to settle it is to see the screen, the clauses it was read under,
// and every geometry change that touched it — DASH_ACTIVITY_DEBUG=1 prints
// exactly that.
const DEBUG = !!process.env.DASH_ACTIVITY_DEBUG;

const SAMPLE_MS = 300;   // how often each session's viewport is classified
const SETTLE_MS = 2500;  // a just-spawned chat is working, not idle (see below)

// A viewport change counts as liveness for this long. EXPORTED because it is
// also the settling time of the signal itself: until a change is this old it
// can still combine with the next one into "streaming", so anything that needs
// a chat to be genuinely at rest — a test sampling the dot after typing into
// the terminal — has to wait it out rather than guess a number.
export const GRACE_MS = 2500;

// sessionId → { id, term, agent, spawnedAt, lastText, changes[], pending, reprime, state, since }
const sessions = new Map();
const listeners = new Set();
let timer = null;

// Scrollback is deliberately ZERO. The grammar reads the VIEWPORT and nothing
// else, so retaining history would be pure memory per live chat — and with no
// scrollback baseY stays 0, which is exactly what viewportText already asks
// for. Everything that decides the answer (cursor addressing, erase, scroll
// regions, the alt screen) is unaffected.
function makeTerm(cols, rows) {
  return new Terminal({
    cols: Math.max(2, cols || 100),
    rows: Math.max(1, rows || 30),
    scrollback: 0,
    allowProposedApi: true,
  });
}

// A chat enters the world WORKING and stays that way through the settle
// window. A spawning agent cannot need input before it has drawn anything, and
// the old client detector's equivalent window only stopped COUNTING changes —
// so a resuming claude that redrew its transcript without a spinner reported
// idle for up to 2.5s, which is precisely the transient this move exists to
// kill. After the window the adapter governs, unchanged.
export function openSession(sessionId, { agent, cols, rows } = {}) {
  if (!sessionId) return;
  closeSession(sessionId);
  const now = Date.now();
  sessions.set(sessionId, {
    id: sessionId,
    term: makeTerm(cols, rows),
    agent: agent || undefined,
    spawnedAt: now,
    lastText: null,
    changes: [],
    pending: 0,   // bytes handed to the emulator that it has not parsed yet
    reprime: false,
    state: 'working',
    since: now,
  });
  emit(sessionId, 'working', now);
  startSampler();
}

// Every byte the PTY emits, into the same emulator the pane would have used.
//
// xterm parses ASYNCHRONOUSLY, on a time budget, so bytes that have arrived are
// not yet on the screen — and on a loaded box that lag reaches seconds. A
// sampler that only reads the screen would call such a chat idle while its
// output sits in the queue, then watch it "start working" when the queue
// drained: a dot that blinks off and on for no reason the agent did. So the
// queue is counted. Unparsed bytes are not ambiguous — the agent WROTE them,
// which is the same fact the streaming clause reads one step later.
export function feedSession(sessionId, data) {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.pending += 1;
  s.term.write(data, () => { s.pending -= 1; });
}

// Mirror the PTY's geometry: the grid a frame was formatted for is the grid it
// has to be read in, so a pane's resize has to reach this emulator too or the
// bottommost-line scan starts reading wrapped rows.
//
// A RESIZE IS NOT LIVENESS. Reflowing 30 rows into 68 rewrites the viewport top
// to bottom, and the streaming clause counts exactly that — a changed viewport
// — as the agent doing work. But nothing happened: somebody opened a pane, or
// dragged a divider. So the next sample RE-PRIMES instead of comparing, making
// the post-resize screen the new baseline. (The old pane-side detector never
// had to say this out loud: its settle window started at MOUNT, which happened
// to swallow the pane's own opening fit. The supervisor's window starts when
// the PTY does, so a pane opened an hour later would otherwise read as a burst
// of work — and the dropped dot is exactly the flicker this move exists to
// end. It is one of the two things i-session-pool-dot-drops was watching; the
// other was that test typing into the terminal and sampling before the echo
// aged out.)
export function resizeSession(sessionId, cols, rows) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (DEBUG) console.log(`[chat-activity] ${sessionId.slice(0, 8)} resize ${s.term.cols}x${s.term.rows} -> ${cols}x${rows}`);
  try { s.term.resize(Math.max(2, cols | 0), Math.max(1, rows | 0)); } catch { /* geometry rejected */ }
  s.reprime = true;
}

// The chat ended. Its state disappears rather than freezing: no live PTY, no
// state, no dot — the same "absent" a client used to get from an unmounted pane.
export function closeSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  sessions.delete(sessionId);
  try { s.term.dispose(); } catch { /* already gone */ }
  emit(sessionId, null, null);
  if (!sessions.size) stopSampler();
}

// { sessionId: { state, since } } for every live chat. `since` stamps when the
// CURRENT state began — it is the episode identity a client dismissal is keyed
// to, so "I've seen this one" survives a reload and expires the moment the chat
// works again, whether or not anyone was watching.
export function activitySnapshot() {
  const out = {};
  for (const [id, s] of sessions) out[id] = { state: s.state, since: s.since };
  return out;
}

// Push notification of every state change: { session, state, since }, with
// state null when the chat ends.
export function subscribeActivity(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(session, state, since) {
  const frame = { session, state, since };
  for (const fn of listeners) {
    try { fn(frame); } catch (e) { console.error('[chat-activity] listener failed:', e.message); }
  }
}

function startSampler() {
  if (timer) return;
  timer = setInterval(sampleAll, SAMPLE_MS);
  // Never a reason for the process to stay alive.
  timer.unref?.();
}

function stopSampler() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

// Classify one session — the old client detector's loop body, verbatim in
// substance: prime on the first sample, count viewport changes inside the
// grace window, and hand the adapter the viewport plus those changes.
export function sampleSession(s, now = Date.now()) {
  const text = viewportText(s.term);
  const settling = now - s.spawnedAt < SETTLE_MS;
  // A geometry change rewrote the screen; take it as the new baseline rather
  // than as the agent having done something (see resizeSession).
  if (s.reprime) { s.reprime = false; s.lastText = text; }
  else if (s.lastText === null) s.lastText = text;
  else if (text !== s.lastText) {
    s.lastText = text;
    // The agent's own startup redraw is "screen changing, no spinner" — byte
    // for byte the shape of a live response — so it is not counted as
    // liveness. Only the window differs from the client's: it is anchored at
    // SPAWN, because a supervisor sees the stream once, live, and never the
    // reattach replay the pane had to sit through.
    if (!settling) s.changes.push(now);
    if (DEBUG) console.log(`[chat-activity] ${s.id?.slice(0, 8)} change ${JSON.stringify(text.slice(-80))}`);
  }
  s.changes = s.changes.filter((t) => now - t < GRACE_MS);
  // Output already in flight counts, so an idle episode can never begin while
  // the emulator still has unread bytes (see feedSession).
  const working = settling || s.pending > 0
    || agentById(s.agent).isWorking({ viewport: text, recentChanges: s.changes });
  return working ? 'working' : 'idle';
}

function explain(id, s, state, now) {
  const tail = (s.lastText || '').split('\n').filter((l) => l.trim()).slice(-1)[0] || '';
  console.log(`[chat-activity] ${id.slice(0, 8)} ${state} agent=${s.agent || 'claude'} `
    + `changes=${s.changes.length} pending=${s.pending} `
    + `settling=${now - s.spawnedAt < SETTLE_MS} `
    + `bottom=${JSON.stringify(tail.slice(0, 60))}`);
}

function sampleAll() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    let next;
    try { next = sampleSession(s, now); } catch (e) {
      console.error('[chat-activity] sample failed:', e.message);
      continue;
    }
    if (next === s.state) continue;
    s.state = next;
    s.since = now;
    if (DEBUG) explain(id, s, next, now);
    emit(id, next, now);
  }
}

// Test seam: drain the emulator's write queue (xterm parses asynchronously) and
// take one sample, so a test can assert a verdict on exact bytes with no timer.
export async function __sampleNow(sessionId, now) {
  const s = sessions.get(sessionId);
  if (!s) return undefined;
  await new Promise((r) => s.term.write('', r));
  const next = sampleSession(s, now);
  if (next !== s.state) { s.state = next; s.since = now ?? Date.now(); emit(sessionId, next, s.since); }
  return next;
}

// Test seam: the live session record (emulator included), for parity checks.
export function __sessionState(sessionId) { return sessions.get(sessionId); }
