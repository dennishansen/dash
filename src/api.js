import { useEffect, useState, useRef } from 'react';
import { subscribeIssues } from './realtime.js';
import * as issues from './issues-cache.js';
import * as payloads from './fetch-cache.js';

// The one polling loop behind every hook here: run `load` now, then again every
// pollMs while the tab is visible (and immediately when it becomes visible after
// being hidden) — but NEVER while the previous run is still in flight. Returns a
// teardown.
//
// That in-flight guard is the whole point. Each hook keeps a generation counter
// so a stale reply can't overwrite fresher data; when a poll fired on top of its
// own unfinished request, that guard threw the reply away instead. An endpoint
// slower than its interval therefore starved completely — every response landed
// already superseded, so data never painted and `loading` never cleared, while
// the stacked requests made the server slower still. One request at a time turns
// a slow endpoint into a slow load instead of a dead one.
export function startPolling(load, pollMs) {
  let inflight = false;
  const tick = () => {
    if (inflight) return;
    inflight = true;
    Promise.resolve(load()).catch(() => {}).finally(() => { inflight = false; });
  };
  tick();
  if (pollMs <= 0) return () => {};
  const onTick = () => { if (document.visibilityState === 'visible') tick(); };
  const interval = setInterval(onTick, pollMs);
  document.addEventListener('visibilitychange', onTick);
  return () => {
    clearInterval(interval);
    document.removeEventListener('visibilitychange', onTick);
  };
}

// One key's painted state, read straight out of the cache it belongs to. The
// hooks below re-seed from this the moment their key changes, in render, so
// what's on screen always belongs to the key being rendered.
const seed = (key) => ({
  key,
  data: payloads.read(key) ?? null,
  err: null,
  loading: Boolean(key) && !payloads.has(key),
});
const seedIssues = (key) => ({
  key,
  data: issues.read(key) ?? null,
  err: null,
  loading: !issues.has(key),
});

// ONE keyed load, cached, polled, and guarded against its own stale replies —
// the primitive both data hooks below are. It reads and writes the shared
// payload cache (fetch-cache.js) so a key you have seen before repaints at once
// and refreshes behind you; the lab runs long experiments, and the UI should
// reflect orchestrator state without a manual refresh click. Poll is gated by
// Page Visibility so inactive tabs don't spam the server. A null key means there
// is nothing to load yet (no selection) — it holds still rather than requesting.
//
// `key` names the payload and is the ONLY thing that restarts the load. `fn`
// fetches it, and is a fresh closure on every render, so depending on it would
// mean refetching forever; the ref keeps the latest one without making it a
// dependency — the deal useIssues already makes with its fetcher.
export function useAsync(key, fn, { pollMs = 0 } = {}) {
  // What's painted is DERIVED from the key during render, never assigned to it
  // by an effect. An effect lands a frame late, so the view committed one paint
  // of the previous key's payload under the new key — for the code pane that is
  // the header naming one file while the body still shows another, the exact
  // lie this exists to remove.
  // Spinner only when nothing is cached for this key yet — a background refresh
  // over already-painted data must not flip the whole view back to "loading…".
  const [stored, setStored] = useState(() => seed(key));
  const state = stored.key === key ? stored : seed(key);
  if (state !== stored) setStored(state);
  const tick = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  // Returns the load's promise so callers can sequence on "my refetch landed"
  // (the board holds optimistic drag state open until then).
  function refresh() {
    tick.current++;
    return load(tick.current, key);
  }

  async function load(tag, target) {
    if (!target) return;
    try {
      const value = await fnRef.current();
      // A superseded reply is dropped whole — not cached either. Caching it
      // would need a second ordering rule beside this counter (two requests for
      // one key can land in the order they didn't start in, and the older one
      // would overwrite), and one invariant does not get two mechanisms. The
      // counter already says it: the newest request started is the one that
      // counts, for the cache exactly as for the paint.
      if (tag !== tick.current) return;
      // unchanged payload ⇒ same object ⇒ no re-render
      setStored({ key: target, data: payloads.store(target, value), err: null, loading: false });
    } catch (e) {
      if (tag === tick.current) setStored((previous) => ({ ...previous, err: e.message, loading: false }));
    }
  }

  useEffect(() => {
    // A key change supersedes whatever is in flight — INCLUDING a change to
    // null, which starts no poll of its own and would otherwise let the
    // previous request's reply paint back over a view that has been cleared.
    tick.current++;
    if (!key) return undefined;
    // The first load rides the same in-flight guard as the poll — it's the run
    // most likely to be outpaced (nothing is painted yet, so it's the one whose
    // loss shows as a pane stuck on "Loading…").
    return startPolling(refresh, pollMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, pollMs]);

  return { data: state.data, err: state.err, loading: state.loading, refresh };
}

// The HTTP adapter over useAsync: the key IS the url, and the fetch is what a
// /api/dash endpoint needs and a Supabase-direct call does not.
export function useFetch(url, { pollMs = 15000 } = {}) {
  return useAsync(url, () => fetchJson(url), { pollMs });
}

async function fetchJson(url) {
  // Cache-bust so auto-poll doesn't hit the 60s server-side memo. The cache is
  // keyed by the STABLE url, not this busted one, or every poll would mint a
  // fresh entry and nothing would ever be a hit.
  const sep = url.includes('?') ? '&' : '?';
  const r = await fetch(`${url}${sep}_=${Date.now()}`);
  // The board moved to Supabase-direct (useAsync straight over the store); every
  // remaining useFetch caller is a LOCAL-only /api/dash endpoint. On Vercel those
  // don't exist — it answers with an HTML 404, whose `res.json()` throws the
  // cryptic "Unexpected token '<'". Detect the non-JSON response and surface a
  // clean "local only" message instead of that crash.
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) throw new Error('Available on the local Dash only (this machine has no Dash backend).');
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
  return j;
}

// Live context-window + LOC for one chat, served by /api/dash/chat-status. Works
// for both agents behind one shape — { used, added, removed, compactAt } — sourced
// per-agent server-side (claude's statusline file, codex's rollout). Returns that
// object once it lands, null until then (a not-yet-started session, or a codex
// chat before its first turn writes a token_count). Polls on a short cadence so
// the ring/badge track a working session in near-real time; null sessionId means
// "nothing selected" and never fetches.
export function useChatStatus(sessionId, { pollMs = 4000 } = {}) {
  const [data, setData] = useState(null);
  useEffect(() => {
    if (!sessionId) { setData(null); return undefined; }
    let live = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/dash/chat-status?session=${encodeURIComponent(sessionId)}&_=${Date.now()}`);
        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('json')) return; // no local Dash backend (Vercel)
        const j = await r.json();
        // Lines-changed and context-fill are independent now: the first comes
        // from git, the second from whatever the agent has published. A payload
        // is usable if it carries either, so the LOC badge is not held hostage
        // to a fill percentage that may never arrive.
        if (live) setData(j && (typeof j.used === 'number' || typeof j.added === 'number') ? j : null);
      } catch { /* transient — keep the last value */ }
    };
    const stopPoll = startPolling(load, pollMs);
    return () => { live = false; stopPoll(); };
  }, [sessionId, pollMs]);
  return data;
}

// Issues data = cache + fetch + subscribe, ONE hook. Every view that renders
// issue rows uses this. The painted value lives in issues-cache (shared across
// all hook instances of a key — a fetch by one repaints all); a coalesced
// refetch fires on every issues-change signal — socket frames from other
// clients, this client's own writes (board-store announces them), and socket
// (re)joins after a gap. Stale-while-revalidate: remounts paint the cached
// value instantly and refresh in the background.
//
// Coalesced because a single reorder/move updates a whole COLUMN of rows, so
// one drag emits dozens of socket change events — the trailing-edge debounce
// collapses a burst into one refetch.
const REALTIME_COALESCE_MS = 150;
export function useIssues(key, fn, { pollMs = 15000 } = {}) {
  // Re-seeded during render on a key change, same as useFetch and for the same
  // reason: reseeding in an effect paints one committed frame of the previous
  // key's rows — the board you just left, under the issue you just opened.
  const [stored, setStored] = useState(() => seedIssues(key));
  const state = stored.key === key ? stored : seedIssues(key);
  if (state !== stored) setStored(state);
  const tick = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  function refresh() {
    tick.current++;
    return load(tick.current, key);
  }

  async function load(tag, target) {
    const startedAt = issues.clock();
    try {
      const j = await fnRef.current();
      if (tag !== tick.current) return;
      issues.storeFetch(target, j, startedAt); // repaints via the subscription
    } catch (e) {
      if (tag === tick.current) setStored((previous) => ({ ...previous, err: e.message, loading: false }));
    }
  }

  useEffect(() => {
    tick.current++; // a key change supersedes whatever is in flight
    // Subscribe before the first load, so the repaint storeFetch triggers has
    // somewhere to land.
    const unsub = issues.subscribe(key, (v) => setStored({ key, data: v ?? null, err: null, loading: false }));
    const stopPoll = startPolling(refresh, pollMs);

    // The bus: refetch on any issues-change signal, trailing-edge coalesced.
    // A signal is news the poll hasn't seen, so it supersedes on purpose rather
    // than waiting behind an in-flight poll.
    let timer = null;
    const unsubBus = subscribeIssues(() => {
      clearTimeout(timer);
      timer = setTimeout(() => refresh(), REALTIME_COALESCE_MS);
    });

    return () => { unsub(); stopPoll(); clearTimeout(timer); unsubBus(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, pollMs]);

  return { data: state.data, err: state.err, loading: state.loading, refresh };
}

// "1 change" / "3 changes" — a count and its noun, agreeing.
export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// Format a number with sensible precision for the Dash table.
export function fmt(n, digits = 2) {
  if (n === null || n === undefined) return '—';
  if (typeof n !== 'number') return String(n);
  if (Number.isNaN(n)) return 'NaN';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toFixed(0);
  if (abs >= 10) return n.toFixed(1);
  if (abs >= 0.01) return n.toFixed(digits);
  return n.toExponential(1);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function ordinal(n) {
  const t = n % 100;
  if (t >= 11 && t <= 13) return n + 'th';
  return n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
}

// Humanized absolute date — "May 4th", or "May 4th 2025" if not this year.
export function fmtDate(s) {
  if (!s) return '—';
  const ms = instant(s);
  if (Number.isNaN(ms)) return '—';
  const d = new Date(ms);
  const base = `${MONTHS[d.getMonth()]} ${ordinal(d.getDate())}`;
  return d.getFullYear() === new Date().getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

// An instant, however the source spells one: ISO, a `git log` date
// ("2026-04-18 17:46:05 -0700"), or epoch milliseconds — a recording carries its
// own clock as a number, and a date is a date.
function instant(s) {
  return typeof s === 'number' ? s : Date.parse(s);
}

// Relative time — "just now", "2h ago", "3 weeks ago", falling back to an
// absolute humanized date once it's older than ~a year. Returns `—` on
// null/invalid.
export function fmtAgo(s) {
  if (!s) return '—';
  const ms = instant(s);
  if (Number.isNaN(ms)) return '—';
  const diff = (Date.now() - ms) / 1000;
  const ago = (n, unit) => `${plural(n, unit)} ago`;
  if (diff < 60)         return 'just now';
  if (diff < 3600)       return Math.round(diff / 60) + 'm ago';
  if (diff < 86400)      return Math.round(diff / 3600) + 'h ago';
  if (diff < 86400 * 7)  return Math.round(diff / 86400) + 'd ago';
  if (diff < 86400 * 60) return ago(Math.round(diff / (86400 * 7)), 'week');
  if (diff < 86400 * 365) return ago(Math.round(diff / (86400 * 30)), 'month');
  return fmtDate(s);
}

// "13.3s" / "2m 05s" — an elapsed span, at the precision it deserves. Distinct
// from fmtAgo, which places an instant; this measures one.
//
// Rounded ONCE, up front, and the unit chosen from the rounded value — rounding
// after the split is what makes 119999ms read "1m 60s" and 59999ms read "60.0s".
export function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const secs = Math.round(ms / 1000);
  const m = Math.floor(secs / 60);
  return `${m}m ${String(secs - m * 60).padStart(2, '0')}s`;
}

// Normalize a decision string ("keep (closure: …)", "keep-partial") to one
// of the canonical tokens used for pill styling: keep | park | discard |
// keep-partial | null. Keeps the color system stable when authors write prose.
export function normalizeDecision(d) {
  if (!d) return null;
  const s = String(d).toLowerCase();
  if (s.startsWith('keep-partial') || s.startsWith('keep_partial')) return 'keep-partial';
  if (s.startsWith('keep-park')) return 'keep-partial';
  if (s.startsWith('keep')) return 'keep';
  if (s.startsWith('park')) return 'park';
  if (s.startsWith('discard')) return 'discard';
  return null;
}

// Normalize a status string so `.pill.<class>` matches even if the backend
// emits variants. (e.g. "merged-partial" stays, but "merged (closure)" -> "merged").
//
// Canonical statuses:
//   live           — branch with an ALIVE researcher process (PID check)
//   pending        — branch has commits, no decision tag yet
//   merged         — ancestor of main (merge commit is the record)
//   merged-partial — merged with caveats (per human-authored recap)
//   rejected       — tagged rejected/<name> (tag is the record; branch may be deleted)
//   archived       — legacy synonym for 'rejected' (kept for back-compat with old data)
export function normalizeStatus(s) {
  if (!s) return null;
  const low = String(s).toLowerCase();
  if (low.startsWith('live')) return 'live';
  if (low.startsWith('pending')) return 'pending';
  if (low.startsWith('merged-partial')) return 'merged-partial';
  if (low.startsWith('merged')) return 'merged';
  if (low.startsWith('rejected')) return 'rejected';
  // Back-compat
  if (low.startsWith('in-progress')) return 'pending';
  if (low.startsWith('archived')) return 'rejected';
  if (low.startsWith('falsified')) return 'rejected';
  if (low.startsWith('parked')) return 'parked';
  if (low.startsWith('active')) return 'active';
  if (low.startsWith('open')) return 'open';
  return low;
}

// Color a delta vs baseline. lowerIsBetter=true means smaller=good.
export function deltaClass(value, baseline, lowerIsBetter = true) {
  if (value === null || baseline === null || value === undefined || baseline === undefined) return 'delta-flat';
  const diff = value - baseline;
  if (Math.abs(diff) < 1e-6) return 'delta-flat';
  const isBetter = lowerIsBetter ? diff < 0 : diff > 0;
  return isBetter ? 'delta-good' : 'delta-bad';
}
