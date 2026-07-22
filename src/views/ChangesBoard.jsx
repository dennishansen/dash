import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAsync, useIssuesRealtime } from '../api.js';
import { useActivity } from '../activity-store.js';
import { listChanges, createChange, moveChange, reorderChange } from '../board-store.js';
import { insertionIndex } from './dragOrder.js';
import { useSelection } from '../selection.jsx';
import { columnCompare, archiveCompare, ARCHIVE_COLS } from '../board-sort.js';
import { searchIssues } from '../issue-search.js';
import { useHotkey } from '../hotkeys.js';
import { hk } from '../hotkey-registry.js';
import { Avatar, usePeople, useDismiss } from '../profiles.jsx';
import { OptionMenu } from '../OptionMenu.jsx';
import {
  FILTER_FIELDS, CREATED_BUCKETS, SINGLE_SELECT_FIELDS, FILTER_OPERATORS, DEFAULT_OP,
  fieldHasOperators, valuesNeeded, emptyFilters, anyFilterActive, fieldActive,
  issueMatchesFilters, tagOptions, ownerEmailsPresent, todayStr,
} from '../board-filters.js';

function SearchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.6 10.6 14 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
function FilterIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 4h12M4.5 8h7M6.5 12h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
function ClearIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// The six change buckets, in board order. Mirrors the roadmap tiers plus the
// transient `in-progress` lane between committed (`next`) and shipped (`done`).
// Issues live entirely in Supabase (issues table) now, so dragging a card
// between columns is the way to change its status — see commitDrag. A card
// enters `in-progress` automatically when work begins (`board.mjs start`, run
// by /change /bug and worktree creation) and leaves it when /merge flips it to
// done/rejected; a live researcher branch surfaces here too.
export const BUCKETS = [
  { key: 'maybe',       title: 'Maybe',       tone: 'plain' },
  { key: 'future',      title: 'Future',      tone: 'plain' },
  { key: 'next',        title: 'Next',        tone: 'info' },
  { key: 'in-progress', title: 'In Progress', tone: 'active' },
  { key: 'done',        title: 'Done',        tone: 'ok' },
  { key: 'rejected',    title: 'Rejected',    tone: 'warn' },
];

// The board owns its cursor/selection keys only when focus rests on a PASSIVE
// surface — the body or a scroll container, never a focusable control (a card
// adder, a sidebar link, the App·Code tab), which was the gap that let
// Enter/arrows leak onto them. (Inputs and the terminal are excluded by the
// primitive's own focus rules.) Stable module-level refs for useHotkey's `when`.
const passiveSurface = (e) => {
  const t = e.target;
  return !(t instanceof Element) || !t.closest('a[href], button, [role="button"], [role="tab"]');
};
// The board is the OSS home route (`/` — empty hash path). This event-time check
// (not the React `visible` prop) lets a chord fired in the frame after
// navigating off the board decline here instead of acting on a board the user
// has already left. The ⌘↑/↓ reorder chords gate on `passiveSurface` alone and
// re-check the route inside their handler, so they still CONSUME the key during
// the board↔detail hand-off frame while only ACTING on the board.
const onBoardRoute = () => {
  const p = (window.location.hash || '').replace(/^#/, '').split('?')[0];
  return p === '' || p === '/';
};
const boardOwnsKeyboard = (e) => passiveSurface(e) && onBoardRoute();

export function ChangesBoard({ visible = true }) {
  // The board reads Supabase directly (board-store), so it works remotely on
  // Vercel with no /api/dash server. Instant cross-edit refresh comes from a
  // browser-side Supabase Realtime subscription (realtime.js) — the SAME path
  // local and remote, authed with the signed-in user's JWT. The 60s poll is now
  // just a backstop for a dropped socket. The board stays mounted across routes
  // (see Shell), so this subscription stays live the whole session.
  const { data, err, loading, refresh } = useAsync('changes', listChanges, { pollMs: 60000 });
  useIssuesRealtime(refresh);
  const navigate = useNavigate();
  const { selectedId, anchorId, setSelection, chatFocused, setOrder } = useSelection();
  const [search, setSearch] = useState('');
  // The search box collapses to just its icon; clicking expands + focuses it,
  // clicking out (or Escape) collapses it again. An active query is PRESERVED
  // across collapse (the board stays filtered) and the collapsed icon shows an
  // accent tint so a hidden filter is never silent.
  const [searchOpen, setSearchOpen] = useState(false);
  const searchWrapRef = useDismiss(searchOpen, () => setSearchOpen(false));
  const [showFilters, setShowFilters] = useState(false);
  // Structured filter state: a Set per field (owner/tags/created), multi-select
  // OR within a field and AND across fields — see board-filters.js. Replaces the
  // old tags-only `activeTags` Set. Transient (per-load), unlike view-mode.
  const [filters, setFilters] = useState(emptyFilters);
  // A created-bucket filter measures against "today", so the board must notice a
  // day boundary even while idle — without polling. `dayTick` bumps at the next
  // local midnight (the timer reschedules itself via its own dep) and whenever the
  // tab regains focus; the `filtered` memo reads `todayStr()` fresh on any bump.
  // At rest this is a single pending timer, no interval.
  const [dayTick, setDayTick] = useState(0);
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') setDayTick(t => t + 1); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  useEffect(() => {
    const now = new Date();
    // Exact next local midnight — setTimeout fires at-or-after its delay, so by the
    // time it runs `todayStr()` already reads the new day (no fudge-factor buffer).
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const timer = setTimeout(() => setDayTick(t => t + 1), nextMidnight - now);
    return () => clearTimeout(timer);
  }, [dayTick]);
  const [hidden, setHidden] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('dash-hidden-cols') || '[]')); }
    catch { return new Set(); }
  });
  const toggleCol = (key) => setHidden(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    localStorage.setItem('dash-hidden-cols', JSON.stringify([...next]));
    return next;
  });

  const filtered = useMemo(() => {
    // `now` fresh each derivation (not frozen at mount), so a created-bucket
    // filter reads the right day even on a board left open across midnight — and
    // realtime data pushes re-run this memo continually. Structured filters first
    // (owner/tags/created), then the same free-text matcher the ⌘K palette uses —
    // one search, not two (issue-search.js). searchIssues trims the query, so a
    // whitespace-only search is NOT a filter — consistent with `filterActive`
    // (also trimmed), so drag/keyboard-reorder never renumber a hidden subset.
    const now = todayStr();
    let rows = (data ?? []).filter(i => issueMatchesFilters(i, filters, now));
    rows = searchIssues(rows, search);
    return rows;
  }, [data, filters, search, dayTick]);

  // Drag is disabled while ANY filter is active — a structured field OR the
  // search box: a column then shows only a subset of its cards, so renumbering it
  // from the visible set would collide with (and reorder relative to) the hidden
  // cards. Clear the filters to reorder.
  const filterActive = anyFilterActive(filters) || search.trim() !== '';

  // Pointer-drag reorder + restatus. The grabbed card lifts off and follows the
  // cursor (a fixed-position clone); a placeholder holds the drop slot in the
  // column under the pointer while siblings glide via FLIP. On release: a drop
  // in the origin column reorders it; a drop in another column also changes the
  // card's status (its new column). Both commit to Supabase via the server.
  // Only issue cards are draggable — live branch pseudo-cards have no board row.
  const [override, setOverride] = useState({});
  const [writeErr, setWriteErr] = useState(null);
  // drag = { id, col (origin status), targetCol, w, h, gx, gy, x, y, index } or null.
  const [drag, setDrag] = useState(null);
  const bodyRefs = useRef({});   // colKey → column-body DOM node (for geometry)
  const didDragRef = useRef(false); // suppress the Link click that follows a drag
  const kanbanRef = useRef(null); // the horizontal kanban scroller (for ⌘-wheel)
  useEffect(() => { setOverride({}); }, [data]);
  // ⌘-wheel scrolls the wide kanban horizontally — the natural gesture when a
  // mouse (or trackpad) only sends a vertical delta. Gated on there actually
  // being horizontal overflow, so ⌘-wheel keeps its native browser zoom when the
  // board already fits. Non-passive so preventDefault takes. Re-runs on `data` so
  // it attaches once the board (and its scroller) has mounted.
  useEffect(() => {
    const el = kanbanRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (!e.metaKey || !e.deltaY) return;
      if (el.scrollWidth <= el.clientWidth) return; // no horizontal overflow → leave ⌘-wheel to the browser
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [data]);

  const cols = useMemo(() => {
    const out = Object.fromEntries(BUCKETS.map(b => [b.key, []]));
    for (const i of filtered) (out[i.status] ?? (out[i.status] = [])).push(i);
    for (const k of Object.keys(out)) out[k].sort(ARCHIVE_COLS.has(k) ? archiveCompare : columnCompare);
    return out;
  }, [filtered]);

  const displayItems = (key) => {
    const items = cols[key];
    const ov = override[key];
    if (!ov) return items;
    const byId = new Map(items.map(x => [x.id, x]));
    const out = ov.map(id => byId.get(id)).filter(Boolean);
    for (const x of items) if (!ov.includes(x.id)) out.push(x);
    return out;
  };
  // Insertion index for the dragged card within a column: walk the non-dragged
  // ISSUE cards' midpoints and count how many sit above the pointer. Branch
  // pseudo-cards are excluded so this index lives in the same universe as the
  // committed id list (issue-only) — otherwise a branch row above the drop slot
  // would shift the computed index off by one. Geometry is read live from the
  // DOM so it works with variable card heights.
  const computeIndex = (col, draggedId, pointerY) => {
    const body = bodyRefs.current[col];
    if (!body) return 0;
    const mids = [...body.querySelectorAll('[data-card-id][data-card-kind="issue"]')]
      .filter(el => el.dataset.cardId !== draggedId)
      .map(el => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; });
    return insertionIndex(mids, pointerY);
  };
  // Which column is under the pointer (by horizontal extent of its body). Null
  // when over no expanded column — caller falls back to the origin column.
  const columnAt = (pointerX) => {
    for (const b of BUCKETS) {
      const body = bodyRefs.current[b.key];
      if (!body) continue;
      const r = body.getBoundingClientRect();
      if (pointerX >= r.left && pointerX <= r.right) return b.key;
    }
    return null;
  };

  // pointerdown on a card arms the drag; it only activates past a small threshold
  // so plain clicks still navigate. Window listeners track move/up so the drag
  // survives the cursor leaving the card.
  const onCardPointerDown = (e, id, col) => {
    if (e.button !== 0) return;
    const card = e.currentTarget;
    const rect = card.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY };
    const grab = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    let active = false;

    const move = (ev) => {
      const targetCol = columnAt(ev.clientX) || col;
      if (!active) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
        active = true;
        didDragRef.current = true;
        setDrag({ id, col, targetCol, w: rect.width, h: rect.height, gx: grab.x, gy: grab.y,
                  x: ev.clientX, y: ev.clientY, index: computeIndex(targetCol, id, ev.clientY) });
        return;
      }
      const index = computeIndex(targetCol, id, ev.clientY);
      setDrag(d => d ? { ...d, x: ev.clientX, y: ev.clientY, targetCol, index } : d);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(d => {
        if (d) commitDrag(d);
        return null;
      });
      // Let the click that fires right after pointerup see didDrag, then clear.
      setTimeout(() => { didDragRef.current = false; }, 0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Board writes go straight to Supabase (board-store). Each returns {ok} or
  // {error}; normalize to a promise that rejects on error so `commit` can catch.
  const write = (p) => p.then(r => { if (r && r.error) throw new Error(r.error); });

  // Surface a write failure instead of silently reverting on refresh. On
  // failure also drop any optimistic override for the column, so a failed write
  // whose refresh also fails doesn't leave a stale order on screen.
  const commit = (p, optimisticCol) => p.then(() => setWriteErr(null))
    .catch(() => {
      setWriteErr('Board write failed — change not saved. Retry.');
      if (optimisticCol) setOverride(o => { const n = { ...o }; delete n[optimisticCol]; return n; });
    })
    .finally(refresh);

  // + on a column head: create a blank issue at the top of that column and
  // jump straight to its detail (title is inline-editable there). The new card
  // is ranked against the FULL column from `data` — not the filtered view — so
  // "top of the column" holds even while a search/tag filter is active.
  const addIssue = async (status) => {
    const ids = (data ?? [])
      .filter(i => i.kind === 'issue' && i.status === status)
      .sort(columnCompare)
      .map(i => i.id);
    try {
      const out = await createChange(status, ids);
      if (out.error || !out.id) throw new Error(out.error || 'create failed');
      // Carry a one-shot focus flag so the detail view autofocuses the title —
      // only on a fresh create, never on ordinary navigation to an issue.
      navigate(`/changes/${encodeURIComponent(out.id)}`, { state: { focusTitle: true } });
    } catch {
      setWriteErr('Issue create failed — nothing was added. Retry.');
      refresh();
    }
  };

  const commitDrag = (d) => {
    // Target column's FINAL ordering: its current ISSUE cards with the dragged
    // card inserted at the drop slot. Live branch pseudo-cards (kind:'branch')
    // are excluded — they have no issue row. Drag is disabled under a
    // filter, so this column is the full unfiltered set; the server renumbers
    // ranks 0..n from it, making the drop position exact (no collisions).
    const ids = cols[d.targetCol].filter(x => x.kind === 'issue').map(x => x.id).filter(x => x !== d.id);
    ids.splice(Math.min(d.index, ids.length), 0, d.id);
    if (d.targetCol === d.col) {
      // Same column → reorder (rank-only). Optimistic override for a smooth
      // release; refresh resyncs (and reverts the optimism if the write failed).
      setOverride(o => ({ ...o, [d.col]: ids }));
      commit(write(reorderChange(ids)), d.col);
      return;
    }
    // Cross column → status + ranks in ONE atomic request. No optimistic
    // override (the card's column lives in server data); refresh reflects it.
    commit(write(moveChange(d.targetCol, ids)));
  };

  // The lifted card rendered once, fixed to the viewport, tracking the cursor.
  const dragItem = drag
    ? (cols[drag.col] || []).find(x => x.id === drag.id)
    : null;

  // The keyboard nav grid: the visible (non-collapsed, non-empty) columns in
  // board order, each carrying its displayed card ids — the exact order the user
  // sees, including any optimistic drag/reorder override (displayItems). This is
  // the single source for cursor nav, the selection range, and the detail rail.
  const navCols = useMemo(() =>
    BUCKETS.filter(b => !hidden.has(b.key))
      .map(b => ({ key: b.key, ids: displayItems(b.key).map(x => x.id) }))
      .filter(c => c.ids.length),
    [cols, override, hidden]);
  // Publish the flat board order so the detail view's ⌘↑/↓ rail and its
  // after-delete cursor-park (useIssueNav) read the same order shown here.
  useEffect(() => { setOrder(navCols.flatMap(c => c.ids)); }, [navCols, setOrder]);

  // Locate an id in the grid: its column index and row within it.
  const locate = (id) => {
    for (let ci = 0; ci < navCols.length; ci++) {
      const ri = navCols[ci].ids.indexOf(id);
      if (ri >= 0) return { ci, ri };
    }
    return null;
  };

  // The highlighted set — the contiguous card run between the anchor and the
  // focus WITHIN one column (file-list style). A single selection (anchor ===
  // focus) or an anchor that has drifted to another column collapses to just the
  // focus.
  const selectedIds = useMemo(() => {
    if (!selectedId) return new Set();
    const f = locate(selectedId);
    if (!f) return new Set();
    if (!anchorId || anchorId === selectedId) return new Set([selectedId]);
    const a = locate(anchorId);
    if (!a || a.ci !== f.ci) return new Set([selectedId]);
    return new Set(navCols[f.ci].ids.slice(Math.min(a.ri, f.ri), Math.max(a.ri, f.ri) + 1));
  }, [navCols, anchorId, selectedId]);

  // Each column's REORDERABLE (issue-only) ids as last rendered AND advanced
  // synchronously by a nudge — so a second ⌘↓ fired before React re-renders
  // derives its move from the first move's result, not the same stale order.
  const liveOrderRef = useRef({});
  liveOrderRef.current = Object.fromEntries(
    BUCKETS.filter(b => !hidden.has(b.key))
      .map(b => [b.key, displayItems(b.key).filter(x => x.kind === 'issue').map(x => x.id)]));

  // ↑/↓ walk a column, ←/→ jump columns (clamping the row), ⌥↑/⌥↓ snap to a
  // column's top/bottom. Lands the cursor as a fresh single selection.
  const moveSelection = (dir) => {
    if (!navCols.length) return;
    let ci = navCols.findIndex(c => c.ids.includes(selectedId));
    if (ci < 0) { setSelection(navCols[0].ids[0]); return; }
    let ri = navCols[ci].ids.indexOf(selectedId);
    if (dir === 'up') ri = Math.max(0, ri - 1);
    else if (dir === 'down') ri = Math.min(navCols[ci].ids.length - 1, ri + 1);
    else if (dir === 'top') ri = 0;
    else if (dir === 'bottom') ri = navCols[ci].ids.length - 1;
    else if (dir === 'left') ci = Math.max(0, ci - 1);
    else if (dir === 'right') ci = Math.min(navCols.length - 1, ci + 1);
    ri = Math.min(ri, navCols[ci].ids.length - 1);
    setSelection(navCols[ci].ids[ri]);
  };

  // Shift+↑/↓ grows or shrinks a CONSECUTIVE card run within the focus's column
  // (never across columns). The anchor stays put while the focus steps one card;
  // the run between them is the selection.
  const extendSelection = (dir) => {
    if (dir !== 'up' && dir !== 'down') return;
    const f = locate(selectedId);
    if (!f) return;
    const col = navCols[f.ci].ids;
    const ri = dir === 'up' ? Math.max(0, f.ri - 1) : Math.min(col.length - 1, f.ri + 1);
    // Keep the anchor if it's still in THIS column; otherwise the current focus
    // becomes the anchor (the first extend out of a single selection).
    const a = locate(anchorId);
    const anchor = (a && a.ci === f.ci) ? anchorId : selectedId;
    setSelection(col[ri], anchor);
  };

  // ⌘↑/⌘↓ nudge the selected card(s) one slot within their column, rewriting
  // ranks through the same board-store reorder the drag path uses — so order
  // syncs live across worktrees/machines. While the board owns the keyboard,
  // ⌘↑/↓ always CONSUMES the key: it moves the run when it can and is otherwise
  // inert — never releasing to the browser's native ⌘↑/↓ page-scroll. A no-op on
  // an archive column (done/rejected ignore rank), under an active filter (the
  // column shows a subset — renumbering it would collide with hidden cards), or
  // when the run is already clamped at a column end.
  const reorderSelection = (dir) => {
    if (dir !== 'up' && dir !== 'down') return false;
    // Off the board (the hand-off frame before this hidden board's chord detaches):
    // consume the key so it can't native-scroll, but don't act — the detail owns
    // ⌘↑/↓ there.
    if (!onBoardRoute()) return;
    if (!selectedId) return false;                 // no cursor — leave the key alone
    const f = locate(selectedId);
    if (!f) return;                                // not on a card — inert (consume)
    const bucketKey = navCols[f.ci].key;
    if (ARCHIVE_COLS.has(bucketKey) || filterActive) return; // not reorderable — inert
    const ids = liveOrderRef.current[bucketKey] || [];
    const run = ids.filter(id => selectedIds.has(id));
    if (!run.length) return;                       // inert (e.g. focus on a live branch card)
    const first = ids.indexOf(run[0]);
    const last = ids.indexOf(run[run.length - 1]);
    if (dir === 'up' && first === 0) return;                // clamped at the top — inert
    if (dir === 'down' && last === ids.length - 1) return;  // clamped at the bottom — inert
    const next = [...ids];
    if (dir === 'up') {
      const [above] = next.splice(first - 1, 1);
      next.splice(last, 0, above);                          // the card above slides below the run
    } else {
      const [below] = next.splice(last + 1, 1);
      next.splice(first, 0, below);                         // the card below slides above the run
    }
    liveOrderRef.current[bucketKey] = next;                 // advance for a same-tick repeat
    setOverride(o => ({ ...o, [bucketKey]: next }));        // optimistic paint (like the drag)
    commit(write(reorderChange(next)), bucketKey);
    // Selection ids don't change on a reorder, so the scroll effect won't fire —
    // keep the moved run in view ourselves.
    requestAnimationFrame(() =>
      document.querySelector(`[data-card-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: 'nearest' }));
  };

  // Board cursor keys. Meaningful only while the BOARD owns the keyboard, so they
  // YIELD to the terminal (the primitive's default): a bare ↑/↓/←/→/Enter is real
  // terminal input, and ⌥↑/↓ leave the chat alone too. `when: boardOwnsKeyboard`
  // fires them only on a passive surface AND the board route; `enabled` also
  // pauses them mid pointer-drag. Bubble phase (capture:false).
  const navEnabled = visible && !drag;
  const boardOpts = { enabled: navEnabled, capture: false, when: boardOwnsKeyboard };
  useHotkey(hk('boardCursor', 'up'), () => moveSelection('up'), boardOpts);
  useHotkey(hk('boardCursor', 'down'), () => moveSelection('down'), boardOpts);
  useHotkey(hk('boardCursor', 'left'), () => moveSelection('left'), boardOpts);
  useHotkey(hk('boardCursor', 'right'), () => moveSelection('right'), boardOpts);
  useHotkey(hk('boardJump', 'top'), () => moveSelection('top'), boardOpts);
  useHotkey(hk('boardJump', 'bottom'), () => moveSelection('bottom'), boardOpts);
  useHotkey(hk('boardExtend', 'up'), () => extendSelection('up'), boardOpts);
  useHotkey(hk('boardExtend', 'down'), () => extendSelection('down'), boardOpts);
  useHotkey(hk('boardOpen'), () => { if (!selectedId) return false; navigate(`/changes/${encodeURIComponent(selectedId)}`); }, boardOpts);
  // ⌘↑/⌘↓ nudge the run (rank write). Gated on a passive surface (not the route)
  // so the hidden board still CONSUMES ⌘↑/↓ in the hand-off frame after navigating
  // to a detail — no native page-scroll leaks — while reorderSelection only ACTS
  // when onBoardRoute. Yields to the terminal like the cursor keys.
  const reorderOpts = { enabled: navEnabled, capture: false, when: passiveSurface };
  useHotkey(hk('boardReorder', 'up'), () => reorderSelection('up'), reorderOpts);
  useHotkey(hk('boardReorder', 'down'), () => reorderSelection('down'), reorderOpts);

  // On board load, park the keyboard cursor on the top of In Progress (where
  // active work is) so arrows move from there immediately. Only when nothing is
  // already selected on the board — returning from a detail keeps its card.
  useEffect(() => {
    if (!data) return;
    if (selectedId && filtered.some(i => i.id === selectedId)) return;
    const top = (key) => displayItems(key)[0]?.id;
    const pick = top('in-progress')
      ?? BUCKETS.filter(b => !hidden.has(b.key)).map(b => top(b.key)).find(Boolean);
    if (pick) setSelection(pick);
  }, [data]);

  // Keep the selected card in view as the cursor moves (and on return from detail).
  useEffect(() => {
    if (!selectedId) return;
    document.querySelector(`[data-card-id="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedId, data]);

  return (
    <div>
      <div className="page-header issues-header">
        <h2>Issues</h2>
        <div className="header-right">
          <button
            className={`filter-toggle${showFilters || anyFilterActive(filters) ? ' is-on' : ''}`}
            onClick={() => setShowFilters(s => !s)}
            title={showFilters ? 'Hide filters' : 'Show filters'}
            aria-label="Toggle filters"
            aria-pressed={showFilters}
          >
            <FilterIcon />
          </button>
          {!searchOpen ? (
            <button className={`filter-toggle search-toggle${search ? ' is-active' : ''}`}
              onClick={() => setSearchOpen(true)}
              title="Search issues" aria-label="Search issues" aria-expanded={false}>
              <SearchIcon />
            </button>
          ) : (
            <div className="search-field" ref={searchWrapRef}>
              <SearchIcon />
              <input
                type="text"
                autoFocus
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setSearchOpen(false); } }}
                placeholder="title, id, tag…"
                aria-label="Search issues"
              />
              {search ? (
                <button className="search-clear" onClick={() => setSearch('')}
                  title="Clear search" aria-label="Clear search">
                  <ClearIcon />
                </button>
              ) : null}
            </div>
          )}
        </div>
      </div>
      {/* Structured filters sit directly above the board they filter, revealed
          by the funnel toggle. ALWAYS closable — collapsing hides the bar even
          while filters are active; the toggle stays lit so a hidden filter is
          never silent (mirrors the collapsed-search accent). */}
      {showFilters ? (
        <FilterBar data={data} filters={filters} setFilters={setFilters} shownCount={filtered.length} />
      ) : null}
      {err ? <div className="error">{err}</div> : null}
      {writeErr ? <div className="error" onClick={() => setWriteErr(null)} style={{ cursor: 'pointer' }}>{writeErr}</div> : null}
      {loading && !data ? <div className="spin">loading…</div> : null}
      {data ? (
        <div ref={kanbanRef} className={`kanban kanban-5${drag ? ' is-dragging' : ''}`}>
          {BUCKETS.map(b => (
            <IssueColumn key={b.key} title={b.title} tone={b.tone}
              items={displayItems(b.key)} emptyMsg={`nothing ${b.title.toLowerCase()}`}
              collapsed={hidden.has(b.key)} onToggle={() => toggleCol(b.key)}
              colKey={b.key}
              dragId={drag ? drag.id : null}
              placeAt={drag && drag.targetCol === b.key ? drag.index : -1}
              placeH={drag ? drag.h : 0}
              isDropTarget={drag && drag.targetCol === b.key}
              bodyRef={el => { bodyRefs.current[b.key] = el; }}
              onCardPointerDown={onCardPointerDown} didDragRef={didDragRef}
              dragDisabled={filterActive} selectedId={chatFocused ? null : selectedId}
              rangeIds={chatFocused || selectedIds.size < 2 ? null : selectedIds}
              onAdd={() => addIssue(b.key)} />
          ))}
        </div>
      ) : null}
      {dragItem ? (
        <div className={`kcard kcard-floating status-${drag.targetCol}${dragItem.live ? ' is-live' : ''}`}
          style={{ position: 'fixed', left: drag.x - drag.gx, top: drag.y - drag.gy, width: drag.w }}>
          {dragItem.live ? <div className="kcard-head"><span className="pill live-tag">● live</span></div> : null}
          <div className="kcard-title">{dragItem.title}</div>
        </div>
      ) : null}
    </div>
  );
}

// Human labels for the three filter fields (the pill key + the add-menu rows).
const FIELD_LABEL = { owner: 'Owner', tags: 'Tags', created: 'Created' };

// The Notion-style structured filter bar: a pill per active field (each a summary
// that reopens its value menu, plus an X to clear that field) and a "+ Add filter"
// button that offers the fields not yet in play. Each field's value menu is the
// shared OptionMenu, with an operator <select> in its header for owner/tags; the
// operators + matcher live in board-filters.js, so this component is pure wiring.
// Rendered ONLY while the panel is open — the filters themselves live in the
// board, so collapsing hides the bar without dropping the active filter.
function FilterBar({ data, filters, setFilters, shownCount }) {
  // Which value menu is open: a field key, the sentinel '__add__' for the
  // add-filter menu, or null. One-at-a-time; click-outside / Escape closes it.
  const [openField, setOpenField] = useState(null);
  const wrapRef = useDismiss(!!openField, () => setOpenField(null));
  useHotkey('Escape', () => setOpenField(null),
    { enabled: !!openField, terminal: 'handle', allowInInput: true });

  // Owner options = the name-sorted roster ∩ owners actually present on the
  // board (a filter offers only values that can match). Reads the one roster
  // every card reads — no request per option.
  const people = usePeople();
  const tags = useMemo(() => tagOptions(data), [data]);
  const ownersPresent = useMemo(() => ownerEmailsPresent(data), [data]);
  const owners = useMemo(
    () => people.filter(p => ownersPresent.has(p.email)),
    [people, ownersPresent]);

  // {value,label} options for a field — the value menu rows and the pill summary.
  const optionsFor = (field) => {
    if (field === 'owner')   return owners.map(p => ({ value: p.email, label: p.name }));
    if (field === 'tags')    return tags.map(t => ({ value: t, label: t }));
    if (field === 'created') return CREATED_BUCKETS.map(b => ({ value: b.value, label: b.label }));
    return [];
  };

  // Switch a field's operator. empty/not-empty carry no values, so crossing
  // between the valued pair (contains/not-contains) and the valueless pair drops
  // the value set; staying inside the valued pair keeps it.
  const setFieldOp = (field, op) => setFilters(prev => {
    const keep = valuesNeeded(op) && valuesNeeded(prev[field].op);
    return { ...prev, [field]: { op, values: keep ? prev[field].values : new Set() } };
  });
  const toggleValue = (field, value) => setFilters(prev => {
    const cur = prev[field];
    const has = cur.values.has(value);
    // Single-select fields (created) REPLACE on pick — a second click on the
    // active value clears it. Multi-select fields (owner, tags) toggle in place.
    const values = SINGLE_SELECT_FIELDS.has(field)
      ? new Set(has ? [] : [value])
      : (() => { const s = new Set(cur.values); has ? s.delete(value) : s.add(value); return s; })();
    return { ...prev, [field]: { ...cur, values } };
  });
  const clearField = (field) => {
    setFilters(prev => ({ ...prev, [field]: { op: DEFAULT_OP, values: new Set() } }));
    setOpenField(o => (o === field ? null : o)); // an emptied open field would linger as a pill
  };
  const clearAll = () => { setFilters(emptyFilters()); setOpenField(null); };

  // A field shows a pill once it is ACTIVE (values, or an is-empty/not-empty op)
  // OR its menu is open (so picking it from the add-menu gives its value menu
  // somewhere to anchor). Owner/tags are always addable — they can filter by
  // is-empty/is-not-empty with no value options; created needs its buckets.
  const pillFields = FILTER_FIELDS.filter(f => fieldActive(f, filters[f]) || openField === f);
  const addable = FILTER_FIELDS.filter(
    f => !fieldActive(f, filters[f]) && openField !== f && (fieldHasOperators(f) || optionsFor(f).length > 0));

  // The pill's value text: "<operator> <values>" for owner/tags, the bucket for
  // created. A placeholder ("any" / "contains …") reads dim/italic.
  const summarize = (field) => {
    const { op, values } = filters[field];
    const opts = optionsFor(field);
    const labels = () => [...values].map(v => opts.find(o => o.value === v)?.label ?? v).join(', ');
    if (!fieldHasOperators(field)) return values.size ? labels() : 'any';
    const opLabel = FILTER_OPERATORS.find(o => o.value === op)?.label.toLowerCase();
    if (!valuesNeeded(op)) return opLabel;                    // "is empty" / "is not empty"
    return values.size ? `${opLabel} ${labels()}` : `${opLabel} …`;
  };
  const isPlaceholder = (field) => {
    const { op, values } = filters[field];
    return values.size === 0 && (!fieldHasOperators(field) || valuesNeeded(op));
  };

  const active = anyFilterActive(filters);
  const total = data?.length ?? 0;

  return (
    <div className="filter-bar" ref={wrapRef}>
      {pillFields.map(field => (
        <div className="filter-field" key={field}>
          <span className="filter-pill">
            <button type="button" className="filter-pill-open"
              aria-haspopup="listbox" aria-expanded={openField === field}
              onClick={() => setOpenField(o => (o === field ? null : field))}>
              <span className="filter-pill-key">{FIELD_LABEL[field]}</span>
              <span className={`filter-pill-val${isPlaceholder(field) ? ' is-any' : ''}`}>
                {summarize(field)}
              </span>
            </button>
            <button type="button" className="filter-pill-x"
              title={`Clear ${FIELD_LABEL[field]} filter`} aria-label={`Clear ${FIELD_LABEL[field]} filter`}
              onClick={() => clearField(field)}>
              <ClearIcon />
            </button>
          </span>
          {openField === field ? (
            <OptionMenu
              options={!fieldHasOperators(field) || valuesNeeded(filters[field].op) ? optionsFor(field) : []}
              selected={filters[field].values}
              single={SINGLE_SELECT_FIELDS.has(field)}
              onToggle={(v) => toggleValue(field, v)}
              renderOption={field === 'owner'
                ? (o) => (<><Avatar email={o.value} size={18} showTooltip={false} /><span className="person-name">{o.label}</span></>)
                : undefined}
              header={fieldHasOperators(field) ? (
                <select className="filter-op" value={filters[field].op}
                  aria-label={`${FIELD_LABEL[field]} operator`}
                  onChange={(e) => setFieldOp(field, e.target.value)}>
                  {FILTER_OPERATORS.map(op => <option key={op.value} value={op.value}>{op.label}</option>)}
                </select>
              ) : null}
              footer={fieldHasOperators(field) && !valuesNeeded(filters[field].op) ? (
                <div className="filter-menu-note dim">
                  {filters[field].op === 'empty' ? `— no ${field} —` : `— any ${field} —`}
                </div>
              ) : null} />
          ) : null}
        </div>
      ))}

      {addable.length ? (
        <div className="filter-field">
          <button type="button" className="filter-add"
            aria-haspopup="menu" aria-expanded={openField === '__add__'}
            onClick={() => setOpenField(o => (o === '__add__' ? null : '__add__'))}>
            + Add filter
          </button>
          {openField === '__add__' ? (
            <ul className="owner-menu filter-menu" role="menu">
              {addable.map(f => (
                <li key={f}>
                  <button type="button" className="owner-pick" role="menuitem"
                    onClick={() => setOpenField(f)}>{FIELD_LABEL[f]}</button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {active ? (
        <>
          <button type="button" className="filter-clear-all" onClick={clearAll}>clear all</button>
          <span className="dim count">{shownCount} of {total}</span>
        </>
      ) : null}
    </div>
  );
}

function IssueColumn({ title, tone, items, emptyMsg, collapsed, onToggle, colKey, dragId, placeAt, placeH, isDropTarget, bodyRef, onCardPointerDown, didDragRef, dragDisabled, selectedId, rangeIds, onAdd }) {
  if (collapsed) {
    return (
      <div className={`kcol kcol-${tone} kcol-collapsed`} onClick={onToggle} title="Show column">
        <div className="kcol-railhead">
          <span className="kcol-count">{items.length}</span>
          <span className="kcol-railtitle">{title}</span>
        </div>
      </div>
    );
  }

  // The lifted card is hidden from wherever it lives (its origin column); the
  // placeholder shows in the column under the pointer (target). placeAt is an
  // issue-only index (matching computeIndex + the committed id list), so the
  // placeholder is positioned before the placeAt-th ISSUE card — branch
  // pseudo-cards don't shift it.
  const visible = dragId ? items.filter(i => i.id !== dragId) : items;
  const ph = <div key="__ph" className="kcard-placeholder" style={{ height: placeH }} />;
  const rows = [];
  let issueIdx = 0, placed = false;
  for (const i of visible) {
    if (placeAt >= 0 && !placed && issueIdx === placeAt) { rows.push(ph); placed = true; }
    rows.push(<IssueCard key={i.id} i={i} colKey={colKey}
      onPointerDown={onCardPointerDown} didDragRef={didDragRef} dragDisabled={dragDisabled}
      selected={i.id === selectedId} range={rangeIds ? rangeIds.has(i.id) : false} />);
    if (i.kind === 'issue') issueIdx++;
  }
  if (placeAt >= 0 && !placed) rows.push(ph);

  return (
    <div className={`kcol kcol-${tone}${isDropTarget ? ' is-drop-target' : ''}`}>
      <div className="kcol-head" onClick={onToggle} title="Hide column" style={{ cursor: 'pointer' }}>
        <span className={`kcol-title pill bucket-${colKey}`}>{title}</span>
        <span className="kcol-count">{items.length}</span>
        <button className="kcol-add" title={`New issue in ${title}`} aria-label={`New issue in ${title}`}
          onClick={(e) => { e.stopPropagation(); onAdd(); }}>+</button>
      </div>
      <div className="kcol-body" ref={el => { bodyRef && bodyRef(el); }}>
        {visible.length === 0 && placeAt < 0
          ? <div className="kcol-empty">{emptyMsg}</div>
          : rows}
      </div>
    </div>
  );
}

function IssueCard({ i, colKey, onPointerDown, didDragRef, dragDisabled, selected, range }) {
  // Only real issue cards carry a board row, so only they are draggable. Live
  // branch pseudo-cards (kind 'branch') stay click-through links. Drag is also
  // off while a filter is active (a column shows only a subset — can't renumber).
  // A mounted chat that's idle (waiting for input, for ANY reason — turn done,
  // asked a question, errored, exited) gets the "needs input" flag on its card.
  // Gated to the in-progress column: that lane is where active conversations
  // live (and are kept attached), so a stalled chat there is the only one worth
  // flagging. Working chats and issues with no mounted chat carry no flag.
  const activity = useActivity();
  const idle = i.status === 'in-progress' && activity[i.id] === 'idle';
  const draggable = i.kind === 'issue' && !dragDisabled;
  const dragProps = draggable ? {
    draggable: false,
    onPointerDown: (e) => onPointerDown(e, i.id, i.status),
    onClick: (e) => { if (didDragRef.current) { e.preventDefault(); e.stopPropagation(); } },
  } : {};
  return (
    <Link to={`/changes/${encodeURIComponent(i.id)}`} data-card-id={i.id} data-card-kind={i.kind}
      className={`kcard issue-card status-${i.status}${i.live ? ' is-live' : ''}${draggable ? ' draggable' : ''}${selected ? ' is-selected' : ''}${range ? ' is-range' : ''}`}
      {...dragProps}>
      {i.live ? <div className="kcard-head"><span className="pill live-tag" title={`branch live (pid ${i.live_pid})`}>● live</span></div> : null}
      {/* The owner's avatar trails the title, reading against the card's right
          edge — a card is already dense, so who holds it is a glance, not a line.
          An UNOWNED issue shows nothing: no placeholder person, no empty circle.
          <Avatar> reads the roster every other surface reads (one fetch for the
          whole board), so this costs no request per card. */}
      <div className="kcard-title-row">
        {idle ? <span className="kcard-idle-dot" title="chat idle — needs your input" /> : null}
        <div className="kcard-title">{i.title}</div>
        <Avatar email={i.owner} size={17} className="card-avatar" />
      </div>
    </Link>
  );
}
