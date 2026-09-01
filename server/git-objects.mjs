// Reading a blob out of git's object store, without starting a program to do it.
//
// Every other question the Code pane asks git is a whole-tree question —
// `ls-files`, `diff`, `merge-base` — and those genuinely are programs. Fetching
// the base version of ONE file is not: it's a lookup, and it sits on the only
// path a human ever waits on (click a changed file, see the diff). Paying a
// fork+exec for it makes the cost of showing a file a function of how busy the
// machine is rather than how big the file is: measured on a working machine
// (load ~20, ~140 node processes), fork+exec of `true` — a program that does
// nothing — costs 0.8-2.0s, and `git show <sha>:<path>` cost the same. Unchanged
// files, which never needed a base version and so never spawned, answered in
// 1-9ms throughout. That gap was the whole bug.
//
// So the process is opened ONCE per repository and kept: `git cat-file --batch`
// is a request/response protocol over a pipe, which is exactly the shape of what
// this is asked for. A read costs a write and a read, and no fork.
//
// SCOPE — object questions only. Callers pass a rev that names an immutable
// object (`<full-sha>:<path>`), never a ref. A long-lived git process caches
// what it has resolved, so asking THIS for `HEAD` would be asking a process that
// may predate the branch you just switched to. Refs stay with the commands that
// re-read them per run. Objects have no such hazard, and a batch session does
// pick up objects written after it started (a commit made mid-session resolves
// normally) — the object store is re-read on a miss.
import { spawn } from 'node:child_process';

// A session lives as long as you are browsing and no longer. Back-to-back clicks
// are what it exists to make free; a repository you have finished with should not
// hold a process open for the rest of the dash's life, and there are dozens of
// worktrees on this machine.
//
// The seam exists so the expiry rules can be tested in milliseconds rather than
// minutes — the same `LAB_*` idiom the rest of the dash uses to make machine-
// scale behaviour reachable from a test.
const IDLE_MS = Number(process.env.LAB_GIT_OBJECT_IDLE_MS) || 60_000;

const sessions = new Map(); // repository root → session
const EMPTY = Buffer.alloc(0);

// "It exists, and it is bigger than you said you would take." Distinct from
// `null` (no such object) because the two render differently and must never be
// confused: absent means an empty base version, oversize means don't try.
export const OVERSIZE = Symbol('git-object-oversize');

class GitObjectError extends Error {}

// Route incoming bytes: payload bytes go straight into the collected chunks,
// anything past the payload's trailing newline starts the next header. Only
// header bytes are ever concatenated as they arrive, and a header is tens of
// bytes.
function absorb(session, chunk) {
  if (session.awaiting === null) {
    session.buffer = session.buffer.length ? Buffer.concat([session.buffer, chunk]) : chunk;
    return;
  }
  const need = session.awaiting + 1 - session.bodyLen;
  const mine = chunk.length <= need ? chunk : chunk.subarray(0, need);
  session.bodyLen += mine.length;
  // The trailing newline is counted but never kept — it frames the payload, it
  // isn't part of it.
  if (!session.dropping) {
    const keep = session.bodyLen > session.awaiting ? mine.subarray(0, mine.length - (session.bodyLen - session.awaiting)) : mine;
    if (keep.length) session.body.push(keep);
  }
  if (chunk.length > need) session.buffer = chunk.subarray(need);
}

// The batch protocol, once, in one place:
//   →  <rev>\0
//   ←  <oid> <type> <size>\n <size bytes> \n     the object
//   ←  <rev> missing\n                           no such object
// Answers arrive in the order the requests were written, so pending resolvers are
// a FIFO and concurrent reads pipeline through one process instead of queueing
// behind each other.
//
// A miss is matched against the rev we SENT rather than found by scanning for a
// newline, because git echoes that rev back verbatim — and a path may legally
// contain a newline. Scanning, `<sha>:we\nird.js missing\n` reads as two answers
// (`<sha>:we`, then `ird.js missing`), which resolves the request behind it as
// well: the queue slips by one and every later reader is handed the previous
// file's bytes. Silent, and exactly the kind of wrong this must not be.
function parse(session) {
  for (;;) {
    // `=== null`, not truthiness: a zero-length blob is a real answer with a
    // real size, and if its payload has not arrived yet we must come back
    // still expecting it. Reading `0` as "expecting nothing" would re-enter
    // here and parse the trailing newline as the next answer's header.
    if (session.awaiting === null) {
      if (!session.pending.length) return; // nothing was asked; nothing to match
      const miss = Buffer.from(`${session.pending[0].rev} missing\n`, 'utf8');
      const head = session.buffer.subarray(0, miss.length);
      if (head.equals(miss)) {
        session.buffer = session.buffer.subarray(miss.length);
        session.pending.shift().resolve(null);
        hold(session);
        continue;
      }
      // Too short to tell a miss from a header yet — a success answer opens with
      // the blob's oid where a miss opens with the rev, so they diverge inside
      // the first line, but only once enough bytes are here to see it.
      if (miss.subarray(0, session.buffer.length).equals(session.buffer)) return;
      const newline = session.buffer.indexOf(10);
      if (newline === -1) return;
      const header = session.buffer.toString('utf8', 0, newline);
      session.buffer = session.buffer.subarray(newline + 1);
      const parts = header.split(' ');
      const size = parts.length === 3 ? Number(parts[2]) : NaN;
      // Any other status git may report (`ambiguous`, …) carries no payload, so
      // the next bytes are the next answer.
      if (!Number.isInteger(size)) { session.pending.shift()?.resolve(null); hold(session); continue; }
      session.awaiting = size;
      session.body = [];
      session.bodyLen = 0;
      // The header states the size BEFORE the bytes arrive, which is the only
      // chance to decline them. Past the caller's ceiling the payload is read off
      // the pipe and dropped rather than assembled: the answer is "too large",
      // and nobody needs a hundred megabytes in hand to say so.
      session.dropping = size > session.pending[0].maxBytes;
      // Whatever of the payload already arrived with the header.
      const carried = session.buffer;
      session.buffer = EMPTY;
      absorb(session, carried);
    }
    if (session.bodyLen < session.awaiting + 1) return; // payload + its trailing newline
    const request = session.pending.shift();
    const dropped = session.dropping;
    // One concat over the collected chunks — not one per chunk. Growing a single
    // buffer as each chunk lands recopies everything already held, which is
    // quadratic in the object's size and runs on the loop that also relays
    // terminal keystrokes.
    const body = dropped ? null : Buffer.concat(session.body, session.awaiting);
    session.awaiting = null;
    session.body = null;
    request?.resolve(dropped ? OVERSIZE : body);
    hold(session);
  }
}

// Anything that ends the process ends every request that was riding it. They
// FAIL rather than answering empty: an empty answer for "the base version of
// this file" renders as a whole-file deletion, which is a lie the reader cannot
// tell from the truth. A genuinely absent object is `missing`, handled above.
function fail(session, error) {
  if (sessions.get(session.root) === session) sessions.delete(session.root);
  clearTimeout(session.idle);
  const pending = session.pending.splice(0);
  for (const request of pending) request.reject(error);
  hold(session);
}

// A kept-open process is a set of live handles, and a live handle keeps Node's
// event loop from draining. The session must hold the loop open for exactly as
// long as somebody is waiting on it, and not one moment longer.
//
// Both halves of that are load-bearing, and each was wrong on its own:
//   held always  — a script whose last act was one read sat there until the idle
//                  timer fired a minute later.
//   held never   — a program whose only outstanding work was a read exited
//                  before its own answer arrived.
//
// What does the holding is a TIMER, not the child's own handles. Re-refing a
// child process after unrefing it races its teardown: a session whose root
// isn't a repository would deliver `close` — and so reject its request — only
// about three times in five, and lose the answer entirely otherwise. A timer
// has no such lifecycle of its own, so "is an answer owed" is the only thing
// that decides whether this process may exit. The child and its pipes stay
// unrefed always; unref suppresses keeping the loop ALIVE, never event
// delivery, so both the bytes and the death still arrive.
function hold(session) {
  const wanted = session.pending.length > 0;
  if (session.held === wanted) return;
  session.held = wanted;
  if (wanted) session.keepAlive = setInterval(() => {}, 1 << 30);
  else clearInterval(session.keepAlive);
}

function open(root) {
  const child = spawn('git', ['-C', root, 'cat-file', '--batch', '-z'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const session = {
    root, child, pending: [], buffer: EMPTY, awaiting: null,
    body: null, bodyLen: 0, dropping: false, idle: null, stderr: '', held: true, keepAlive: null,
  };
  // Closing our end of stdin is what tells `cat-file` to finish, so a parent
  // that goes away takes the child with it either way.
  child.unref();
  child.stdin.unref?.();
  child.stdout.unref?.();
  child.stderr.unref?.();
  hold(session); // nothing pending yet — an idle session must not hold the loop
  child.stdout.on('data', (chunk) => { absorb(session, chunk); parse(session); });
  child.stderr.on('data', (chunk) => { session.stderr += chunk.toString('utf8'); });
  child.stdin.on('error', () => {}); // the child may exit before a write lands
  child.on('error', (error) => fail(session, new GitObjectError(`could not run git (${error.code || error.message})`)));
  child.on('close', () => fail(session, new GitObjectError(session.stderr.trim() || 'git cat-file ended')));
  return session;
}

// Idle means idle. A session with requests outstanding is not idle no matter how
// long it has been waiting, and closing one is how a slow machine made itself
// slower: under real load a `cat-file` could take longer to START than the idle
// window, so the timer tore down the session the pending read was waiting on, the
// retry opened another, and six reads cost three spawns and twenty-seven minutes.
// The window is time since the last request STARTED; only an empty queue may act
// on it, and a busy one waits its turn again.
function close(session) {
  clearTimeout(session.idle);
  if (session.pending.length) {
    session.idle = setTimeout(() => close(session), IDLE_MS);
    session.idle.unref?.();
    return;
  }
  if (sessions.get(session.root) === session) sessions.delete(session.root);
  session.child.stdin.end(); // `cat-file --batch` exits on EOF
}

// Read one object. Resolves its bytes; `null` when the object store has no such
// object — a path the base commit never carried, which is an ordinary thing for
// the tree snapshot and the working tree to disagree about for a moment — or
// `OVERSIZE` when it exists but exceeds `maxBytes`, in which case its bytes are
// dropped as they arrive rather than assembled.
export function readObject(root, rev, { maxBytes = Infinity } = {}) {
  if (typeof rev !== 'string' || rev.includes('\0')) {
    return Promise.reject(new GitObjectError('invalid object name'));
  }
  warmObjects(root);
  const session = sessions.get(root);
  return new Promise((resolve, reject) => {
    session.pending.push({ resolve, reject, rev, maxBytes });
    hold(session); // somebody is waiting now — keep the loop alive for them
    session.child.stdin.write(`${rev}\0`);
  });
}

// Have a session ready for this repository, and keep the one that's there alive.
//
// Opening is the one part that still forks, so the FIRST read after a cold start
// pays the spawn floor — which is the whole stall, just moved to the first click
// instead of every click. The tree snapshot is the signal that removes even that:
// a pane fetches the tree before a human can click anything in it, and re-fetches
// every 3s while it stays open. So the session is opened by the tree and lives as
// long as the pane looking at it, and every click — the first one included —
// finds it already there.
export function warmObjects(root) {
  const session = sessions.get(root) || open(root);
  sessions.set(root, session);
  clearTimeout(session.idle);
  session.idle = setTimeout(() => close(session), IDLE_MS);
  session.idle.unref?.();
}

// Let go of every open session. The dash server never needs this — sessions age
// out on their own and die with the process — but a test that wants to prove a
// cold start, or to finish without a child outliving it, says so rather than
// reaching into the map.
export function closeObjectSessions() {
  for (const session of [...sessions.values()]) close(session);
}
