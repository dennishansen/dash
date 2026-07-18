import { useEffect, useState, useRef } from 'react';
import { subscribeIssues } from './realtime.js';

// Last successful payload per URL, surviving unmount. React Router tears the
// board down when you open an issue and rebuilds it on return — without this,
// every navigation re-mounts at data=null and flashes a spinner while it
// re-fetches what it already had. Stale-while-revalidate: paint the cached
// value instantly, refresh in the background, swap when fresh data lands.
const cache = new Map();

// Tiny fetcher hook with auto-poll. The lab runs long experiments; the UI
// should reflect orchestrator state without a manual refresh click. Poll is
// gated by Page Visibility so inactive tabs don't spam the server.
export function useFetch(url, { pollMs = 15000 } = {}) {
  const [data, setData] = useState(() => cache.get(url) ?? null);
  const [err, setErr] = useState(null);
  // Spinner only when nothing is cached for this URL yet — a background refresh
  // over already-painted data must not flip the whole view back to "loading…".
  const [loading, setLoading] = useState(() => !cache.has(url));
  const tick = useRef(0);

  function refresh() {
    tick.current++;
    load(tick.current);
  }

  async function load(tag) {
    setErr(null);
    try {
      // Cache-bust so auto-poll doesn't hit the 60s server-side memo.
      const sep = url.includes('?') ? '&' : '?';
      const r = await fetch(`${url}${sep}_=${Date.now()}`);
      // The board moved to Supabase-direct (useAsync); every remaining useFetch
      // caller is a LOCAL-only /api/dash endpoint. On Vercel those don't exist —
      // it answers with an HTML 404, whose `res.json()` throws the cryptic
      // "Unexpected token '<'". Detect the non-JSON response and surface a clean
      // "local only" message instead of that crash.
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('json')) throw new Error('Available on the local Dash only (this machine has no Dash backend).');
      const j = await r.json();
      if (tag !== tick.current) return;
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      cache.set(url, j);
      setData(j);
    } catch (e) {
      if (tag === tick.current) setErr(e.message);
    } finally {
      if (tag === tick.current) setLoading(false);
    }
  }

  useEffect(() => {
    // URL changed (e.g. a different detail page): paint its cached payload at
    // once if we have one, spinner only if this URL has never been fetched.
    setData(cache.get(url) ?? null);
    setLoading(!cache.has(url));
    tick.current++;
    load(tick.current);

    if (pollMs <= 0) return;
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, pollMs);
    // Also refresh when the tab becomes visible again after being hidden.
    const onVis = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, pollMs]);

  return { data, err, loading, refresh };
}

// Same stale-while-revalidate contract as useFetch, but backed by an async
// FUNCTION instead of a URL — for board data that comes from Supabase directly
// (board-store.js) rather than the local /api/dash server. `key` is the cache
// identity (so two views asking for the same data share the painted value);
// `fn` is re-invoked on poll/refresh. Pass pollMs:0 for detail views that
// refresh on demand.
export function useAsync(key, fn, { pollMs = 15000 } = {}) {
  const [data, setData] = useState(() => cache.get(key) ?? null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(() => !cache.has(key));
  const tick = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  function refresh() { tick.current++; load(tick.current); }

  async function load(tag) {
    setErr(null);
    try {
      const j = await fnRef.current();
      if (tag !== tick.current) return;
      cache.set(key, j);
      setData(j);
    } catch (e) {
      if (tag === tick.current) setErr(e.message);
    } finally {
      if (tag === tick.current) setLoading(false);
    }
  }

  useEffect(() => {
    setData(cache.get(key) ?? null);
    setLoading(!cache.has(key));
    tick.current++;
    load(tick.current);
    if (pollMs <= 0) return;
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, pollMs);
    const onVis = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, pollMs]);

  return { data, err, loading, refresh };
}

// Alias: some components (e.g. the ⌘K palette) name this hook useIssues — the
// same key+fetcher cache as useAsync. Kept as an alias so those files import
// cleanly without a curated rename.
export const useIssues = useAsync;

// Live context-window usage for one agent chat, polled from the local Dash
// backend (/api/dash/chat-status). Powers the context ring + LOC badge next to
// a chat. Returns null when there's no local backend (e.g. the static deploy,
// where the fetch comes back non-JSON) or before the first sample.
export function useChatStatus(sessionId, { pollMs = 4000 } = {}) {
  const [data, setData] = useState(null);
  useEffect(() => {
    if (!sessionId) { setData(null); return undefined; }
    let live = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/dash/chat-status?session=${encodeURIComponent(sessionId)}&_=${Date.now()}`);
        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('json')) return; // no local Dash backend (static deploy)
        const j = await r.json();
        if (live) setData(j && typeof j.used === 'number' ? j : null);
      } catch { /* transient — keep the last value */ }
    };
    load();
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, pollMs);
    return () => { live = false; clearInterval(interval); };
  }, [sessionId, pollMs]);
  return data;
}

// Subscribe to live issues changes and run `onEvent` once per burst. The board
// uses this for instant cross-worktree / cross-machine refresh — Supabase
// Realtime pushes a postgres change whenever the issues table mutates, far
// tighter than the poll fallback. Unlike the old SSE relay this talks to
// Supabase DIRECTLY from the browser (realtime.js), so it works on the remote
// static deploy too — there is no /api/dash server to gate on. The socket is
// authed with the signed-in user's JWT, so a signed-out anon receives nothing.
//
// Coalesced: a single reorder/move updates a whole COLUMN of rows (set_ranks /
// move_column), so one drag emits dozens of change events. `onEvent` is a full
// refetch, so we debounce the trailing edge — a burst collapses to one refetch
// instead of dozens. `onEvent` is held in a ref so a fresh closure each render
// doesn't tear down the subscription; it's set up once on mount.
const REALTIME_COALESCE_MS = 150;
export function useIssuesRealtime(onEvent) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    let timer = null;
    const unsub = subscribeIssues(() => {
      clearTimeout(timer);
      timer = setTimeout(() => cb.current?.(), REALTIME_COALESCE_MS);
    });
    return () => { clearTimeout(timer); unsub(); };
  }, []);
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
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return '—';
  const d = new Date(ms);
  const base = `${MONTHS[d.getMonth()]} ${ordinal(d.getDate())}`;
  return d.getFullYear() === new Date().getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

// Relative time — "just now", "2h ago", "3 weeks ago", falling back to an
// absolute humanized date once it's older than ~a year. s can be ISO or
// `git log` date ("2026-04-18 17:46:05 -0700"). Returns `—` on null/invalid.
export function fmtAgo(s) {
  if (!s) return '—';
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return '—';
  const diff = (Date.now() - ms) / 1000;
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (diff < 60)         return 'just now';
  if (diff < 3600)       return Math.round(diff / 60) + 'm ago';
  if (diff < 86400)      return Math.round(diff / 3600) + 'h ago';
  if (diff < 86400 * 7)  return Math.round(diff / 86400) + 'd ago';
  if (diff < 86400 * 60) return plural(Math.round(diff / (86400 * 7)), 'week');
  if (diff < 86400 * 365) return plural(Math.round(diff / (86400 * 30)), 'month');
  return fmtDate(s);
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
//   pending        — branch has commits, no decision tag yet, no live process
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
