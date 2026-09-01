// Whether the dash control plane on this origin can serve the board that is
// asking — so a board that cannot be told anything stops looking like a board
// with nothing to tell.
//
// WHY THIS EXISTS. The supervisor is the one process on this machine that does
// NOT restart when code lands: it owns every live agent PTY, and bouncing it
// interrupts every turn in flight. That drift is deliberate. What was not
// deliberate is what happened the first time a feature landed BEHIND it —
// needs-input detection moved server-side (i-needs-input-server-state), main
// moved on, and the machine kept serving a build with no
// /api/dash/terminal/activity route at all. Every board asked for that stream,
// got a 404, retried on a backoff forever, and painted a clean empty board.
// Dots were gone for a day and nothing anywhere said why.
//
// The defect was never the drift. It was that "the server cannot answer" and
// "there is nothing to report" RENDER IDENTICALLY, so a dead control plane is
// indistinguishable from a quiet one.
//
// THE SIGNAL IS DETERMINISTIC, not a guess about age. "Older than HEAD" is
// true of the supervisor nearly always and would be pure noise. What is rare
// and exact is a 404 on a route this board needs: client and server are built
// from the same repo, so a supervisor that is UP and IDENTIFIES ITSELF yet has
// no such route is, necessarily, running a build from before that route
// existed. Nothing is inferred from timestamps or commit counts.
//
// The same 404 from an origin with NO supervisor (the board-only Vercel
// deploy) means something else entirely — there are no PTYs there to need
// input — so the identity probe is what tells the two apart, and only the
// first is worth a word.
//
// THIS IS THE OBSERVED HALF of one question, and shell-build.js holds the
// DECLARED half: a protocol version the two sides announce to each other. The
// declared one is sharper when it fires and catches a plane this board must not
// talk to at all — but it only fires when somebody remembered to bump the
// constant, and the day this bug happened nobody had. The observed one needs no
// discipline: a board that asked for something and was told there is no such
// thing has proof. Neither subsumes the other; both reach the one banner in
// main.jsx.
//
// Plain .js, not .jsx, and it stays that way: activity-store.js imports this
// and is itself imported by pure-node derivation tests.

import { useSyncExternalStore } from 'react';

const IDENTITY = '/api/dash/supervisor';

// The restart. NAMED rather than wired to a button, on purpose: it stops every
// dash-bearing vite and bounces the supervisor, which interrupts whatever turn
// each live agent is mid-way through. That is a decision, not a click.
export const RESTART_COMMAND = 'node scripts/supervisor-cutover.mjs';

// route → the user-facing thing that route powers, for routes currently found
// missing. A route re-reported as answering leaves the map, so a restart heals
// the notice with no reload.
const missing = new Map();
// The supervisor's identity as of the last diagnosis: an object when one
// answers on this origin, null when nothing does.
let supervisor = null;
let probing = null;

const listeners = new Set();
let snapshot = { state: 'ok', missing: [], supervisor: null };

function derive() {
  if (!missing.size) return 'ok';
  // A supervisor that answers but lacks the route is behind this board. No
  // supervisor at all is a board-only origin — correct, and silent.
  return supervisor ? 'stale' : 'absent';
}

function publish() {
  const next = { state: derive(), missing: [...missing.values()], supervisor };
  const same = next.state === snapshot.state
    && next.supervisor === snapshot.supervisor
    && next.missing.length === snapshot.missing.length
    && next.missing.every((m, i) => m === snapshot.missing[i]);
  if (same) return;
  snapshot = next;
  for (const fn of listeners) fn();
}

// One probe answers "is there a supervisor here at all", which is the only
// thing that separates a stale build from an origin that never had one.
// Concurrent reports collapse onto the one in flight.
function diagnose() {
  if (probing) return;
  probing = (async () => {
    let id = null;
    try {
      const r = await fetch(IDENTITY, { headers: { accept: 'application/json' } });
      if (r.ok) id = await r.json();
    } catch { /* nothing answers — an origin with no dash */ }
    supervisor = id && id.service === 'artifact-dash-supervisor' ? id : null;
    publish();
  })().finally(() => { probing = null; });
}

// A client's verdict on ONE supervisor route. `ok` false ONLY for a definitive
// 404 — a 401, a 503 from a booting supervisor, or a dropped socket says
// nothing about which build is running and must never reach here. `powers`
// names what the caller loses, so the notice can say what broke rather than
// read a URL at somebody.
export function reportRoute(route, ok, powers) {
  if (ok) {
    if (!missing.delete(route)) return;
    publish();
    return;
  }
  if (missing.has(route)) return;
  missing.set(route, powers || route);
  diagnose();
}

function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function getSnapshot() { return snapshot; }

export function useControlPlane() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

// What to say, or null when there is nothing to — which is every moment except
// the rare one this module exists for. Built here rather than in the shell so
// the wording lives with the fact it reports, in the same
// { headline, detail, remedyLead, remedy } shape the declared-skew half uses.
export function staleNotice({ state, missing: lost, supervisor: sup }) {
  if (state !== 'stale') return null;
  const build = sup?.codeVersion ? `build ${sup.codeVersion}` : 'an older build';
  const pid = sup?.pid ? `, pid ${sup.pid}` : '';
  return {
    headline: 'The supervisor is older than this dash.',
    detail: `It is running ${build}${pid}, which has no route for ${lost.join(', ')}.`,
    remedyLead: 'Restart it:',
    remedy: RESTART_COMMAND,
  };
}

// Test seam: drive the module without a server.
if (typeof window !== 'undefined') {
  window.__dashControlPlane = { reportRoute, getSnapshot };
}
