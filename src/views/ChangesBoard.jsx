import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useIssues, fmtDate } from '../api.js';
import { subscribeIssues } from '../realtime.js';
import { useActivity, issueActivity, dismissIssueIdle } from '../activity-store.js';
import { listChanges, createChange, placeChange } from '../board-store.js';
import { insertionIndex } from './dragOrder.js';
import { useSelection, isBoardRoute } from '../selection.jsx';
import { NAV_ICON } from '../icons.jsx';
import { useHotkey } from '../hotkeys.js';
import { hk, hkCaps } from '../hotkey-registry.js';
import { columnCompare, archiveCompare } from '../board-sort.js';
import { COLUMNS, ARCHIVE_COLS } from '../board-columns.mjs';
import { searchIssues } from '../issue-search.js';
import { Avatar, usePeople, useDismiss } from '../profiles.jsx';
import { OptionMenu } from '../OptionMenu.jsx';
import { useAnchoredPopover } from '../popover.js';
import { CARD_PROPS, useCardProps, toggleCardProp, reorderCardProps } from '../card-props.js';
import { tagPillClass } from '../tag-style.js';
import { copyText } from '../clipboard.js';
import {
  FILTER_FIELDS, CREATED_BUCKETS, SINGLE_SELECT_FIELDS, FILTER_OPERATORS, DEFAULT_OP,
  fieldHasOperators, emptyFilters, anyFilterActive, fieldActive,
  serializeFilters, parseFilters, withEmptyOption,
  issueMatchesFilters, tagOptions, ownerEmailsPresent, todayStr,
} from '../board-filters.js';

// A PASSIVE surface = focus not on an interactive control — the document body
// (nothing focused) or a scroll container like `.main`, never a button, link, or
// tab (a focused card adder, a sidebar link, the App·Code tab), which was the gap
// that let Enter/arrows leak onto them. (Inputs, the terminal, and an open modal
// are already excluded by the primitive's focus rules — a modal owns the keyboard
// entirely, so board keys never fire behind the shortcuts overlay / ⌘K palette.)
// Stable module-level refs for useHotkey's deps.
const passiveSurface = (e) => {
  const t = e.target;
  return !(t instanceof Element) || !t.closest('a[href], button, [role="button"], [role="tab"]');
};
// The board owns its cursor/selection keys only on a passive surface AND when the
// board is the current route. The `isBoardRoute` check is event-time, not the
// React `visible` prop — so a chord fired in the frame after navigating off the
// board (before the effect cleanup detaches the listener) declines here instead
// of acting on a board the user has already left. The ⌘↑/↓ REORDER chords
// deliberately gate on `passiveSurface` alone (not this) and re-check the route
// inside their handler: that way they still CONSUME ⌘↑/↓ during the board↔detail
// hand-off frame (no native page-scroll leaks through) while only ACTING on the
// board — see reorderSelection.
const boardOwnsKeyboard = (e) => passiveSurface(e) && isBoardRoute();
// A CHORD is the board's wherever focus happens to sit. `passiveSurface` is a
// rule about BARE keys: Enter presses the focused button, ↑/↓ walk the focused
// tablist, so the board must not take those from a control that has focus. No
// button, link or tab binds ⌘/⌥/⇧+arrow — there is nothing to take — and asking
// for a passive surface anyway meant the board's own move / jump / extend keys
// went dead the moment you clicked ANY of its chrome and left the focus ring on
// it. Which is every real session: you click the funnel, or the layout toggle,
// or a card, and ⌘↑/⌘↓ silently stops moving anything (i-small-changes-13).
// Inputs, the chat terminal and an open modal are excluded upstream by the
// primitive's own focus rules, so this needs no element test of its own.
const boardChord = () => isBoardRoute();

function SearchIcon() {
  return (
    <svg width={NAV_ICON} height={NAV_ICON} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.6 10.6 14 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
function FilterIcon() {
  return (
    <svg width={NAV_ICON} height={NAV_ICON} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 4h12M4.5 8h7M6.5 12h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
function ClearIcon() {
  return (
    <svg width={NAV_ICON} height={NAV_ICON} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
function KanbanIcon() {
  return (
    <svg width={NAV_ICON} height={NAV_ICON} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2.5" width="3.5" height="11" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="6.5" y="2.5" width="3.5" height="7.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="11" y="2.5" width="3.5" height="9" rx="1" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
// An eye — the display-properties control. Deliberately unlike the funnel beside
// it: filters change WHICH cards show, this changes what each card SHOWS.
function PropsIcon() {
  return (
    <svg width={NAV_ICON} height={NAV_ICON} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1.5 8s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4-6.5-4-6.5-4Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="1.8" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
function ListIcon() {
  return (
    <svg width={NAV_ICON} height={NAV_ICON} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M5 4h9M5 8h9M5 12h9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="2.3" cy="4" r="0.9" fill="currentColor" />
      <circle cx="2.3" cy="8" r="0.9" fill="currentColor" />
      <circle cx="2.3" cy="12" r="0.9" fill="currentColor" />
    </svg>
  );
}

// The columns this board renders come from board-columns.mjs — the one ordered
// declaration of what a status is, shared with the store, the CLI, and the ⌘K
// palette. Dragging a card between columns is how its status changes (see
// commitDrag). A card enters `in-progress` automatically when work begins
// (`board.mjs start`, run by /change and worktree creation) and leaves it
// when /merge flips it to done/rejected; a live researcher branch surfaces here
// too.
// The board's filter surface, remembered. One key for the whole thing — the
// structured fields, the free text, and whether either is unfolded — because
// they are one decision about what you are looking at, and restoring half of it
// (a live filter with its bar folded away, say) would be worse than none.
// Same idiom as `dash-view-mode` and `dash-hidden-cols` below: a guarded read, a
// guarded write, and a shape that tolerates being older than the code.
const FILTER_KEY = 'dash-filters';

function readFilterPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(FILTER_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      return {
        filters: parseFilters(raw.fields),
        search: typeof raw.search === 'string' ? raw.search : '',
        open: raw.open === true,
        searchOpen: raw.searchOpen === true,
      };
    }
  } catch { /* private mode / corrupt value */ }
  return { filters: emptyFilters(), search: '', open: false, searchOpen: false };
}

export function ChangesBoard({ visible = true }) {
  // The board reads Supabase directly (board-store), so it works remotely on
  // Vercel with no /api/dash server. useIssues refetches on every issues-change
  // signal — other clients' writes over the Realtime socket, THIS client's own
  // writes (board-store announces them), and socket rejoins — so no timer poll.
  // The board stays mounted across routes (see Shell), so the subscription
  // stays live the whole session.
  const { data, err, loading } = useIssues('changes', listChanges, { pollMs: 0 });
  const navigate = useNavigate();
  const activity = useActivity();
  const { selectedId, anchorId, setSelection, chatFocused, setOrder } = useSelection();
  // The whole filter surface — the structured fields, the free text, and whether
  // either is unfolded — restored as ONE thing, because it is one thought. Read
  // once, lazily, so a re-render never touches storage.
  const [prefs] = useState(readFilterPrefs);
  const [search, setSearch] = useState(prefs.search);
  // The search box collapses to just its icon; clicking expands + focuses it,
  // clicking out (or Escape) collapses it again. An active query is PRESERVED
  // across collapse (the board stays filtered) and the collapsed icon shows an
  // accent dot so a hidden filter is never silent.
  const [searchOpen, setSearchOpen] = useState(prefs.searchOpen);
  const searchWrapRef = useDismiss(searchOpen, () => setSearchOpen(false));
  const [showFilters, setShowFilters] = useState(prefs.open);
  // Structured filter state: a Set per field (owner/tags/created), multi-select
  // OR within a field and AND across fields — see board-filters.js. Replaces the
  // old tags-only `activeTags` Set.
  const [filters, setFilters] = useState(prefs.filters);
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
  // Board presentation: 'kanban' (horizontal columns of cards) or 'list'
  // (vertical stack of the same buckets, rows instead of cards). Both share the
  // same data, collapse set, drag, and keyboard rail — only layout differs.
  const [viewMode, setViewMode] = useState(() => {
    try { return localStorage.getItem('dash-view-mode') === 'list' ? 'list' : 'kanban'; }
    catch { return 'kanban'; }
  });
  const setView = (m) => {
    setViewMode(m);
    try { localStorage.setItem('dash-view-mode', m); } catch { /* private mode */ }
  };
  // One writer for the surface above. Cheap enough to run on any change (a
  // handful of strings), and writing on EVERY change is what makes a reload
  // land on exactly the board you left rather than the last one you happened to
  // commit some other way.
  useEffect(() => {
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify({
        fields: serializeFilters(filters), search, open: showFilters, searchOpen,
      }));
    } catch { /* private mode */ }
  }, [filters, search, showFilters, searchOpen]);

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
    // whitespace-only search narrows nothing.
    const now = todayStr();
    let rows = (data ?? []).filter(i => issueMatchesFilters(i, filters, now));
    rows = searchIssues(rows, search);
    return rows;
  }, [data, filters, search, dayTick]);
  // The corpus behind the view — what the heading measures the board against.
  const total = data?.length ?? 0;

  // Pointer-drag reorder + restatus. The grabbed card lifts off and follows the
  // cursor (a fixed-position clone); a placeholder holds the drop slot in the
  // column under the pointer while siblings glide via FLIP. On release: a drop
  // in the origin column reorders it; a drop in another column also changes the
  // card's status (its new column). Both are write-through mutations
  // (issues-cache): the drop is painted into the shared cache the instant of
  // release and held there by the pending-mutation journal until the server
  // confirms — no stale fetch, realtime burst, or write round-trip can flash
  // the card back. Only issue cards are draggable — live branch pseudo-cards
  // have no board row.
  // The board's one status line — whatever the board currently has to SAY about
  // itself, in one of two tones. An 'error' persists until it is dismissed or
  // superseded, because a failure you miss is a failure you act on. An 'info'
  // clears itself: it answers a gesture you just made, and a few seconds later
  // it is answering a question nobody is asking any more.
  const [note, setNote] = useState(null);
  const noteTimer = useRef(null);
  const say = (text, tone = 'error') => {
    clearTimeout(noteTimer.current);
    setNote(text ? { text, tone } : null);
    if (text && tone === 'info') noteTimer.current = setTimeout(() => setNote(null), 4500);
  };
  useEffect(() => () => clearTimeout(noteTimer.current), []);
  // ANY failed write anywhere (a detail-view delete included) rolls the cache
  // back and announces ROLLBACK — surface it here, since the board is where
  // the un-painted change visibly snaps back.
  useEffect(() => subscribeIssues(({ event }) => {
    if (event === 'ROLLBACK') say('A write failed — board restored to server state. Retry.');
  }), []);
  // drag = { id, col (origin column), targetCol, w, h, gx, gy, x, y, index } or null.
  const [drag, setDrag] = useState(null);
  const bodyRefs = useRef({});   // colKey → column-body DOM node (for geometry)
  const didDragRef = useRef(false); // suppress the Link click that follows a drag

  const cols = useMemo(() => {
    const out = Object.fromEntries(COLUMNS.map(b => [b.key, []]));
    for (const i of filtered) {
      (out[i.status] ?? (out[i.status] = [])).push(i);
    }
    for (const k of Object.keys(out)) out[k].sort(ARCHIVE_COLS.has(k) ? archiveCompare : columnCompare);
    return out;
  }, [filtered]);
  // The columns as LAST RENDERED, readable from a pointer handler. The drag's
  // pointerup closure was created at pointer-down, so reading `cols` through it
  // would see the board as it looked when the gesture started — and the drop
  // index is measured against the live DOM. Both have to read the same column
  // or the anchor names a card that isn't where the user saw it.
  const colsRef = useRef(cols);
  colsRef.current = cols;
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
  // Which bucket is under the pointer, by its body's extent along the axis the
  // buckets are laid out on: horizontal in kanban (columns side by side),
  // vertical in list (sections stacked). Collapsed buckets have no body ref, so
  // they're skipped — can't drop into a collapsed bucket in either layout. Null
  // when over no expanded bucket — caller falls back to the origin.
  const columnAt = (pointerX, pointerY) => {
    for (const b of COLUMNS) {
      const body = bodyRefs.current[b.key];
      if (!body) continue;
      const r = body.getBoundingClientRect();
      const inside = viewMode === 'list'
        ? (pointerY >= r.top && pointerY <= r.bottom)
        : (pointerX >= r.left && pointerX <= r.right);
      if (inside) return b.key;
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
      const targetCol = columnAt(ev.clientX, ev.clientY) || col;
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

  // Why a column won't take a hand-ordering, in the words the board would use.
  const archiveNote = (key) =>
    `${COLUMNS.find(b => b.key === key)?.title || key} is ordered by when cards closed, not by hand — there is no rank to move.`;

  // A board write's result → banner. The paint itself is the write-through
  // mutation's job (instant, rollback on failure); the board only reports.
  const banner = (p) => p.then(r => {
    say(r && r.error ? 'Board write failed — change not saved. Retry.' : null);
  });

  // + on a column head: create a blank issue at the top of that column and
  // jump straight to its detail (title is inline-editable there).
  const addIssue = async (status) => {
    const out = await createChange(status);
    if (out.error || !out.id) {
      say('Issue create failed — nothing was added. Retry.');
      return;
    }
    // Carry a one-shot focus flag so the detail view autofocuses the title —
    // only on a fresh create, never on ordinary navigation to an issue.
    navigate(`/issues/${encodeURIComponent(out.id)}`, { state: { focusTitle: true } });
  };

  const commitDrag = (d) => {
    // Done/Rejected are chronological archives (archiveCompare ignores rank), so
    // a same-column drop there is a no-op — don't write ranks the sort will
    // never read; the card just settles back into its slot, and the board says
    // why, since a card sliding home looks exactly like a drop that failed.
    if (d.targetCol === d.col && ARCHIVE_COLS.has(d.col)) { say(archiveNote(d.col), 'info'); return; }
    // The target column's ISSUE cards AS SHOWN. Live branch pseudo-cards
    // (kind:'branch') are excluded — they have no issue row. Under a filter this
    // is the visible subset, which is exactly right: the anchor names the card
    // the user SEES the slot sitting below, and that is what they asked for. The
    // column's resulting order is derived from the full column downstream.
    const shown = colsRef.current[d.targetCol].filter(x => x.kind === 'issue');
    const rest = shown.filter(x => x.id !== d.id).map(x => x.id);
    const at = Math.min(d.index, rest.length);
    const next = [...rest.slice(0, at), d.id, ...rest.slice(at)];
    // Dropped back into the slot it came from. Change nothing the user can't see,
    // because they changed nothing they can. Under a filter this is not merely a
    // wasted write: the anchor for slot 0 is "the top", so committing it would
    // lift the card above every HIDDEN card that was above it — a real move for a
    // gesture that visibly did nothing.
    if (d.targetCol === d.col && shown.length === next.length
        && shown.every((x, i) => x.id === next[i])) return;
    banner(placeChange({
      status: d.targetCol,
      moved: [d.id],
      after: at > 0 ? rest[at - 1] : null,   // the card the drop slot sits below; null = top
    }));
  };

  // The lifted card rendered once, fixed to the viewport, tracking the cursor.
  const dragItem = drag
    ? (cols[drag.col] || []).find(x => x.id === drag.id)
    : null;

  // The order the columns are DISPLAYED in, which the two layouts read opposite
  // ways: the kanban keeps the board's left-to-right order (board-columns.js),
  // but the list stacks the sections top-down in the REVERSED order — archives
  // (Rejected/Done) on top, the New inbox trailing at the bottom — so a downward
  // read runs from most-settled toward freshly-filed. Everything downstream (the
  // render, the keyboard grid, the detail rail) follows this one view-aware order.
  const displayBuckets = useMemo(
    () => (viewMode === 'list' ? [...COLUMNS].reverse() : COLUMNS),
    [viewMode],
  );

  // The visible grid: non-collapsed columns in display order, each carrying its
  // displayed id list — the exact same order the user sees. The keyboard cursor
  // walks it, and its flattening is the rail published to the selection context,
  // so the detail view's prev/next (⌘↑/⌘↓ + breadcrumb chevrons) navigates
  // exactly what's on screen here. The board stays mounted across routes, so
  // the rail stays live (filters, realtime moves) while a detail is open.
  const grid = useMemo(() => displayBuckets
    .filter(b => !hidden.has(b.key))
    .map(b => cols[b.key].map(x => x.id)),
    [cols, hidden, displayBuckets]);
  useEffect(() => { setOrder(grid.flat()); }, [grid, setOrder]);

  // The keyboard cursor walks columns that INCLUDE their header as the first
  // stop, so a section head is selectable like any card and Enter toggles it.
  // Every column carries at least its header (a collapsed one has only that), so
  // the cursor can reach and expand a collapsed section. Header stops are the
  // sentinel `header:<key>`; cards are their issue id.
  const isHeader = (id) => typeof id === 'string' && id.startsWith('header:');
  const navCols = useMemo(() => displayBuckets.map(b => [
    `header:${b.key}`,
    ...(hidden.has(b.key) ? [] : cols[b.key].map(x => x.id)),
  ]), [displayBuckets, hidden, cols]);

  // Locate an id in the nav grid: its column (navCols index, 1:1 with
  // displayBuckets) and row within it (row 0 is the section header, cards 1+).
  const locate = (id) => {
    for (let ci = 0; ci < navCols.length; ci++) {
      const ri = navCols[ci].indexOf(id);
      if (ri >= 0) return { ci, ri };
    }
    return null;
  };

  // The highlighted set — the contiguous card run between the anchor and the
  // focus WITHIN one column (file-list style). A single selection (anchor ===
  // focus), a header focus, or an anchor that has drifted to another column all
  // collapse to just the focus; the header row is never part of a card run.
  const selectedIds = useMemo(() => {
    if (!selectedId || isHeader(selectedId)) return new Set();
    const f = locate(selectedId);
    if (!f) return new Set();
    if (!anchorId || anchorId === selectedId) return new Set([selectedId]);
    const a = locate(anchorId);
    if (!a || a.ci !== f.ci) return new Set([selectedId]);
    return new Set(navCols[f.ci]
      .slice(Math.min(a.ri, f.ri), Math.max(a.ri, f.ri) + 1)
      .filter(id => !isHeader(id)));
  }, [navCols, anchorId, selectedId]);

  // Each bucket's card ids (cards only) as last rendered — refreshed every render
  // AND advanced synchronously by a nudge, so a second ⌘↓ fired before React
  // re-renders derives its move from the FIRST move's result, not the same stale
  // order (which would recompute the identical shift and move only once). Same
  // render-time-ref pattern as useIssueNav's orderRef. On the next render the
  // optimistic paint has landed, so this refresh matches — and a realtime change
  // from elsewhere correctly overwrites any half-applied local guess.
  const liveOrderRef = useRef({});
  liveOrderRef.current = Object.fromEntries(
    displayBuckets.map((b, ci) => [b.key, navCols[ci].filter(id => !isHeader(id))]));

  // Kanban is a 2D grid (↑/↓ within a column, ←/→ across); list is ONE
  // continuous top-down run (↑/↓ flow across section boundaries, ←/→ jump to the
  // prev/next section header). ⌥↑/⌥↓ snap to the current section's top/bottom
  // (kanban: its column; list: its header / last card), hopping to the adjacent
  // section's same edge when already parked on it.
  const moveSelection = (dir) => {
    if (!navCols.length) return;
    if (viewMode === 'list') {
      const flat = navCols.flat();
      const i = flat.indexOf(selectedId);
      if (i < 0) { setSelection(flat[0]); return; }
      if (dir === 'up' || dir === 'down') {
        setSelection(flat[dir === 'up' ? Math.max(0, i - 1) : Math.min(flat.length - 1, i + 1)]);
        return;
      }
      // ⌥↑/⌥↓ snap to the CURRENT section's top (its header) / bottom (its last
      // card). Already sitting on that edge → hop to the adjacent section's same
      // edge, so repeated presses walk section boundaries instead of jumping the
      // whole run at once.
      if (dir === 'top' || dir === 'bottom') {
        let ci = navCols.findIndex(col => col.includes(selectedId));
        if (ci < 0) ci = 0;
        const sec = navCols[ci];
        if (dir === 'top') {
          if (selectedId === sec[0] && ci > 0) ci -= 1;
          setSelection(navCols[ci][0]);
        } else {
          if (selectedId === sec[sec.length - 1] && ci < navCols.length - 1) ci += 1;
          const s = navCols[ci];
          setSelection(s[s.length - 1]);
        }
        return;
      }
      // ←/→ jump to the prev/next section header.
      let ci = navCols.findIndex(col => col.includes(selectedId));
      if (ci < 0) ci = 0;
      ci = dir === 'left' ? Math.max(0, ci - 1) : Math.min(navCols.length - 1, ci + 1);
      setSelection(navCols[ci][0]); // land on that section's header
      return;
    }
    let ci = navCols.findIndex(col => col.includes(selectedId));
    if (ci < 0) { setSelection(navCols[0][0]); return; }
    let ri = navCols[ci].indexOf(selectedId);
    if (dir === 'up') ri = Math.max(0, ri - 1);
    else if (dir === 'down') ri = Math.min(navCols[ci].length - 1, ri + 1);
    else if (dir === 'top') ri = 0;
    else if (dir === 'bottom') ri = navCols[ci].length - 1;
    else if (dir === 'left') ci = Math.max(0, ci - 1);
    else if (dir === 'right') ci = Math.min(navCols.length - 1, ci + 1);
    ri = Math.min(ri, navCols[ci].length - 1);
    setSelection(navCols[ci][ri]);
  };

  // Shift+↑/↓ grows or shrinks a CONSECUTIVE card run within the focus's column
  // (never across columns, either layout). The anchor stays put while the focus
  // steps one card, clamped to the column's cards; the run between them is the
  // selection. On a header (or nothing) there's no card to anchor — degrade to a
  // plain step, which lands on a card as a fresh single selection.
  const extendSelection = (dir) => {
    if (dir !== 'up' && dir !== 'down') return;
    const f = locate(selectedId);
    if (!f) return;
    const col = navCols[f.ci];
    if (f.ri === 0) {
      // On the section header there's no card to anchor. Shift+↓ enters the
      // column at its first card (a fresh single selection); Shift+↑ has nothing
      // above WITHIN the column, so it's inert. Never delegate to flat nav — that
      // would let a Shift step cross a section boundary in list layout.
      if (dir === 'down' && col.length > 1) setSelection(col[1]);
      return;
    }
    const ri = dir === 'up' ? Math.max(1, f.ri - 1) : Math.min(col.length - 1, f.ri + 1);
    // Keep the anchor if it's still a card in THIS column; otherwise the current
    // focus becomes the anchor (the first extend out of a single selection).
    const a = locate(anchorId);
    const anchor = (a && a.ci === f.ci && a.ri > 0) ? anchorId : selectedId;
    setSelection(col[ri], anchor);
  };

  // A one-shot lean on the cards a nudge could NOT move — the card tips the way
  // you pressed and settles back. Same idiom as the ⌘S copy flash: a chord has no
  // button to grey out, so the answer has to be the card itself. This is the whole
  // answer where you can SEE why nothing moved (a run already at a column end);
  // where you can't, `say` adds the reason in words.
  const bump = (dir) => {
    const cls = `nudge-blocked-${dir}`;
    for (const id of (selectedIds.size ? selectedIds : new Set([selectedId]))) {
      const el = id && document.querySelector(`[data-card-id="${CSS.escape(id)}"]`);
      if (!el) continue;
      el.classList.remove('nudge-blocked-up', 'nudge-blocked-down'); // restart on a repeat press
      void el.offsetWidth;
      el.classList.add(cls);
      setTimeout(() => el.classList.remove(cls), 320);
    }
  };

  // ⌘↑/⌘↓ nudge the selected card(s) one slot up or down WITHIN their column,
  // rewriting ranks through the same board-store reorder the drag path uses — so
  // the order is shared live across worktrees/machines. While the board owns the
  // keyboard, ⌘↑/↓ is the board's move-card chord and always CONSUMES the key
  // (returns undefined → the primitive preventDefaults): it moves the run when it
  // can and is otherwise inert — never releasing to the browser's native ⌘↑/↓
  // page-scroll. Declines (returns false) only when there is no board cursor at
  // all. Cross-column moves are intentionally out of scope for now (a future want).
  //
  // It works UNDER A SEARCH OR FILTER, on the column AS SHOWN: the run swaps with
  // the neighbour you can see, and the card it lands after is the anchor sent to
  // the server, which renumbers its own full column around it. Moving a card
  // below the card visibly above it is well defined whether or not other cards
  // are hidden — and a chord that silently did nothing whenever a (persisted,
  // near-invisible) search was on is what "reorder is broken" actually meant.
  //
  // What still declines, and how it says so: a header focus or no cursor (you are
  // not on a card); a run clamped at a column end (a lean on the card — you can
  // see there is nothing past it); an archive column, where rank isn't read at
  // all, which is the one reason that isn't on screen, so it is said in words.
  const reorderSelection = (dir) => {
    if (dir !== 'up' && dir !== 'down') return false;
    // Off the board (the frame after navigating to a detail, before this hidden
    // board's listener detaches): consume the key so it can't native-scroll, but
    // don't act — the detail owns ⌘↑/↓ there once it has mounted.
    if (!isBoardRoute()) return;
    if (!selectedId) return false;                          // no cursor — leave the key alone
    const f = locate(selectedId);
    if (isHeader(selectedId) || !f) return;                // not on a card — inert (consume)
    const bucketKey = displayBuckets[f.ci].key;
    if (ARCHIVE_COLS.has(bucketKey)) { bump(dir); say(archiveNote(bucketKey), 'info'); return; }
    // The column's cards AS SHOWN, from the LIVE order ref (advanced by any
    // same-tick prior nudge) rather than render-captured navCols — so a rapid
    // second ⌘↓ moves the run a second slot instead of recomputing the first move
    // against a stale order. Under a filter this is the visible subset, which is
    // the point: the neighbour swapped with, and the anchor derived from it, are
    // the cards the user can actually see.
    const ids = liveOrderRef.current[bucketKey] || navCols[f.ci].filter(id => !isHeader(id));
    const run = ids.filter(id => selectedIds.has(id));      // contiguous; selection ids don't change on a nudge
    if (!run.length) return;                                // inert
    const first = ids.indexOf(run[0]);
    const last = ids.indexOf(run[run.length - 1]);
    // Clamped: nothing shown past the run in that direction. The card leans and
    // settles — the same "heard you, nothing there" a list gives at its end.
    if (dir === 'up' && first === 0) { bump(dir); return; }
    if (dir === 'down' && last === ids.length - 1) { bump(dir); return; }
    const next = [...ids];
    if (dir === 'up') {
      const [above] = next.splice(first - 1, 1);
      next.splice(last, 0, above);                          // the card above slides below the run
    } else {
      const [below] = next.splice(last + 1, 1);
      next.splice(first, 0, below);                         // the card below slides above the run
    }
    liveOrderRef.current[bucketKey] = next;                 // advance synchronously for a same-tick repeat
    // The whole run moves as one, landing after whatever now precedes it.
    const at = next.indexOf(run[0]);
    banner(placeChange({
      status: bucketKey,
      moved: run,
      after: at > 0 ? next[at - 1] : null,                  // the visible card the run lands below
    }));
    // The selection ids don't change on a reorder, so the scroll-into-view effect
    // (keyed on selectedId) won't fire — keep the moved run in view ourselves.
    requestAnimationFrame(() =>
      document.querySelector(`[data-card-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: 'nearest' }));
  };

  // Board cursor keys. These are meaningful only while the BOARD owns the
  // keyboard, so — unlike the route/focus chords — they YIELD to the terminal
  // (the primitive's default): a bare ↑/↓/←/→/Enter is real terminal input, and
  // ⌥↑/⌥↓ (snap to section top/bottom) leave the chat terminal alone too.
  // ⌘/ctrl chords are NOT claimed here — they stay the Shell's focus-steer
  // (⌘←/⌘→). `when: boardOwnsKeyboard` fires these only when focus is on a
  // passive surface, so a focused card button/link keeps its own keys (and the
  // search box keeps typing). Gated on `visible` (the board stays mounted but
  // hidden on other routes, so an off-route board must not hijack arrows) and
  // paused mid pointer-drag. Bubble phase. `moveSelection`/`selectedId` are read
  // live via the handler ref.
  const navEnabled = visible && !drag;
  const boardOpts = { enabled: navEnabled, capture: false, when: boardOwnsKeyboard };
  useHotkey(hk('boardCursor', 'up'), () => moveSelection('up'), boardOpts);
  useHotkey(hk('boardCursor', 'down'), () => moveSelection('down'), boardOpts);
  useHotkey(hk('boardCursor', 'left'), () => moveSelection('left'), boardOpts);
  useHotkey(hk('boardCursor', 'right'), () => moveSelection('right'), boardOpts);
  // The MODIFIED clusters take `boardChord` instead: they are the board's keys
  // whatever holds the focus ring, because nothing else on the board binds them.
  const chordOpts = { enabled: navEnabled, capture: false, when: boardChord };
  // ⌥↑/⌥↓ snap to the current section's top/bottom, then hop section by section.
  useHotkey(hk('boardJump', 'top'), () => moveSelection('top'), chordOpts);
  useHotkey(hk('boardJump', 'bottom'), () => moveSelection('bottom'), chordOpts);
  // Shift+↑/↓ extend the consecutive card selection within the column.
  useHotkey(hk('boardExtend', 'up'), () => extendSelection('up'), chordOpts);
  useHotkey(hk('boardExtend', 'down'), () => extendSelection('down'), chordOpts);
  // ⌘↑/⌘↓ nudge the selected card(s) within their column (rank write). Route is
  // re-checked INSIDE reorderSelection rather than here, so the hidden board
  // still CONSUMES ⌘↑/↓ in the hand-off frame after navigating to a detail — no
  // native page-scroll leaks through — while only ACTING on the board. Yields to
  // the terminal (default) like the cursor keys, so it never fires over the chat.
  const reorderOpts = { enabled: navEnabled, capture: false };
  useHotkey(hk('boardReorder', 'up'), () => reorderSelection('up'), reorderOpts);
  useHotkey(hk('boardReorder', 'down'), () => reorderSelection('down'), reorderOpts);
  // Enter: a header stop toggles its section open/closed; a card opens. Decline
  // (return false) when nothing is selected so the key is left alone.
  useHotkey(hk('boardOpen'), () => {
    if (!selectedId) return false;
    if (isHeader(selectedId)) toggleCol(selectedId.slice('header:'.length));
    else navigate(`/issues/${encodeURIComponent(selectedId)}`);
  }, boardOpts);

  // ⌘Esc dismisses the "needs input" flag on the keyboard-selected card — the
  // same gesture the detail view offers, so a stalled chat can be cleared without
  // opening it. Declines (leaves the key alone) when nothing is selected or the
  // selected card isn't flagged. `visible` gates it so it never overlaps the
  // detail route's own ⌘Esc (the board is hidden, not unmounted, off-route).
  useHotkey(hk('boardDismissFlag'), () => {
    if (!selectedId || isHeader(selectedId)) return false;
    const issue = (data ?? []).find(i => i.id === selectedId);
    const flagged = issue && issue.status === 'in-progress'
      && issueActivity(activity, issue) === 'idle';
    if (!flagged) return false;
    dismissIssueIdle(activity, issue);
  }, { enabled: visible, terminal: 'handle', when: isBoardRoute });

  // ⌘S copies the keyboard-selected card's issue id to the clipboard — a quick
  // left-hand grab for pasting an id into a chat or commit without the mouse. A
  // brief flash on the card confirms it (a chord has no button to checkmark).
  // Declines when nothing or only a header is selected. The detail view binds the
  // same chord to copy the open issue's id.
  //
  // The flash waits for the copy to RESOLVE, and says which way it went. It used
  // to fire immediately beside a `.catch(() => {})` that ate the failure whole —
  // so on an insecure origin, where there is no clipboard to write to, the card
  // flashed exactly as it does on success (issue i-tailnet-secure-context).
  useHotkey(hk('boardCopyId'), () => {
    if (!selectedId || isHeader(selectedId)) return false;
    copyText(selectedId).then((ok) => {
      const el = document.querySelector(`[data-card-id="${CSS.escape(selectedId)}"]`);
      if (!el) return;
      const cls = ok ? 'card-copied' : 'card-copy-failed';
      el.classList.remove('card-copied', 'card-copy-failed');   // restart the flash on a repeat press
      void el.offsetWidth;
      el.classList.add(cls);
      setTimeout(() => el.classList.remove(cls), ok ? 650 : 1400);
    });
  }, { enabled: visible, terminal: 'handle', repeat: false, when: isBoardRoute });

  // ⌘L flips the board layout between kanban and list — a whole-board command, so
  // (unlike the cursor keys) it fires wherever focus sits on the board, not just a
  // passive surface. It yields to the chat terminal, keeping ⌘L as the shell's
  // clear-screen while you're typing. (⌘W, the natural "switch" chord, is a
  // browser-reserved close-tab accelerator no page can cancel, so ⌘L stands in.)
  useHotkey(hk('viewToggle'), () => setView(viewMode === 'list' ? 'kanban' : 'list'),
    { enabled: visible, repeat: false, when: isBoardRoute });


  // Park the keyboard cursor on the top of In Progress (where active work is) so
  // arrows move from there immediately. Only when nothing is already selected ON
  // THE BOARD — returning from a detail keeps its card.
  //
  // Keyed on `filtered`, not `data`: the cursor follows what the board SHOWS. A
  // search that hides the selected card used to strand the cursor on a card that
  // is no longer there — and a stranded cursor is a board where every card chord
  // (⌘↑/⌘↓ to move, ⌘S to copy, Enter to open) declines and says nothing, which
  // is the same "reorder is broken" by another route. `filtered` only changes
  // when the data or the filters do, so this costs a no-op comparison per push.
  useEffect(() => {
    if (!data) return;
    // ON THE BOARD means on SCREEN, and a column has two ways of hiding a card:
    // the filters can drop it, or the column can be collapsed. A selection that
    // only survives `filtered` is not enough — it can sit inside a collapsed
    // column, drawing no ring and answering no chord. `cols` is already the
    // filtered board, so this one test covers both. A header always stays put: a
    // collapsed section still draws its head, which is how you reopen it.
    const visibleTop = (key) => (hidden.has(key) ? undefined : cols[key][0]?.id);
    const onScreen = selectedId && (isHeader(selectedId)
      || COLUMNS.some(b => !hidden.has(b.key) && cols[b.key].some(i => i.id === selectedId)));
    if (onScreen) return;
    const pick = visibleTop('in-progress') ?? COLUMNS.map(b => visibleTop(b.key)).find(Boolean);
    if (pick) setSelection(pick);
  }, [filtered, hidden]);

  // Keep the selected card in view as the keyboard cursor moves. SELECTION
  // changes only — never data refreshes: realtime pushes a new `data` on every
  // issue change anywhere, and re-scrolling then would yank the board away from
  // wherever the user scrolled. Return-from-detail is covered by the Shell's
  // per-route scroll memory, not by re-scrolling here.
  useEffect(() => {
    if (!selectedId) return;
    const sel = isHeader(selectedId)
      ? `[data-head-key="${CSS.escape(selectedId.slice('header:'.length))}"]`
      : `[data-card-id="${CSS.escape(selectedId)}"]`;
    document.querySelector(sel)?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  // .board-scroll spans the full horizontal-scroll width (max-content) so the
  // sticky chrome has room to travel; .board-chrome is sized to .main's viewport
  // (100cqw) so its space-between search lays out across what's visible. The
  // chrome PINS on horizontal scroll (sticky: left) but scrolls away vertically
  // like any page header — only the .kcol-head column heads stay stuck on
  // vertical scroll. Everything stays inside .main, so the both-axes scroll
  // memory (i-4b767a) and the .main-bound sticky heads are untouched.
  return (
    <div className={`board-scroll${viewMode === 'list' ? ' board-scroll--list' : ''}`}>
      <div className="board-chrome">
        <div className="page-header issues-header">
          {/* The heading counts what is ON the board against what EXISTS, so a
              narrowed board says so — "11 of 35 issues" — in the one place you
              are already reading. The search and its filters survive a reload, so
              a board can be a subset of itself long after you have forgotten
              typing anything; a bare count of the subset reads as the whole
              corpus and hides that entirely. Unfiltered, the two are equal and it
              says the plain count. */}
          <h2>{filtered.length === total
            ? (total === 1 ? '1 issue' : `${total} issues`)
            : `${filtered.length} of ${total} issues`}</h2>
          <div className="header-right">
            <div className="view-toggle" role="group" aria-label="Board view">
              <button
                className={viewMode === 'kanban' ? 'is-on' : ''}
                onClick={() => setView('kanban')}
                title={`Board view (${hkCaps('viewToggle')})`} aria-label="Board view" aria-pressed={viewMode === 'kanban'}
              ><KanbanIcon /></button>
              <button
                className={viewMode === 'list' ? 'is-on' : ''}
                onClick={() => setView('list')}
                title={`List view (${hkCaps('viewToggle')})`} aria-label="List view" aria-pressed={viewMode === 'list'}
              ><ListIcon /></button>
            </div>
            <button
              className={`filter-toggle${showFilters || anyFilterActive(filters) ? ' is-on' : ''}`}
              onClick={() => setShowFilters(s => !s)}
              title={showFilters ? 'Hide filters' : 'Show filters'}
              aria-label="Toggle filters"
              aria-pressed={showFilters}
            >
              <FilterIcon />
            </button>
            <DisplayProps />
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
          <FilterBar data={data} filters={filters} setFilters={setFilters} />
        ) : null}
        {/* Board-status banners are chrome too — they ride the pinned block so a
            horizontal scroll doesn't slide them away with the columns. */}
        {err ? <div className="error">{err}</div> : null}
        {note ? (
          <div className={note.tone === 'error' ? 'error' : 'board-note'}
            onClick={() => say(null)} style={{ cursor: 'pointer' }}>{note.text}</div>
        ) : null}
      </div>
      {loading && !data ? <div className="spin">loading…</div> : null}
      {data ? (
        <div className={`${viewMode === 'list' ? 'board-list' : 'kanban kanban-buckets'}${drag ? ' is-dragging' : ''}`}>
          {(() => {
            const col = (b) => (
              <IssueColumn key={b.key} layout={viewMode} title={b.title} tone={b.tone}
                items={cols[b.key]} emptyMsg={`nothing ${b.title.toLowerCase()}`}
                collapsed={hidden.has(b.key)} onToggle={() => toggleCol(b.key)}
                colKey={b.key}
                dragId={drag ? drag.id : null}
                placeAt={drag && drag.targetCol === b.key ? drag.index : -1}
                placeH={drag ? drag.h : 0}
                isDropTarget={drag && drag.targetCol === b.key}
                bodyRef={el => { bodyRefs.current[b.key] = el; }}
                onCardPointerDown={onCardPointerDown} didDragRef={didDragRef}
                selectedId={chatFocused ? null : selectedId}
                rangeIds={chatFocused ? null : selectedIds}
                headerSelected={!chatFocused && selectedId === `header:${b.key}`}
                onAdd={() => addIssue(b.key)} />
            );
            // One section, one row — in BOTH layouts. Collapsed sections used to
            // tuck shoulder-to-shoulder into a shared row to save vertical
            // space, which cost more than it saved: a section sharing a row is
            // a narrow target whose header you cannot reliably double-click to
            // open again, so the cheapest way to expand a section was gone.
            // Stacked full-width, every header is the same wide, obvious strip
            // whether its section is open or shut.
            return displayBuckets.map(col);
          })()}
        </div>
      ) : null}
      {dragItem ? (
        <div className={`${viewMode === 'list' ? 'krow krow-floating' : 'kcard kcard-floating'} status-${drag.targetCol}`}
          style={{ position: 'fixed', left: drag.x - drag.gx, top: drag.y - drag.gy, width: drag.w }}>
          {viewMode === 'list'
            ? <span className="krow-title">{dragItem.title}</span>
            : <div className="kcard-title">{dragItem.title}</div>}
        </div>
      ) : null}
    </div>
  );
}

// The "+ Add filter" menu — the one popover here that isn't an OptionMenu (its
// rows pick a FIELD, they don't toggle a value). Its own component so it can take
// the shared viewport placement, which is a mounted-means-open hook.
function AddFilterMenu({ fields, onPick }) {
  const { ref, style } = useAnchoredPopover(true);
  return (
    <ul className="owner-menu filter-menu" role="menu" ref={ref} style={style}>
      {fields.map(f => (
        <li key={f}>
          <button type="button" className="owner-pick" role="menuitem"
            onClick={() => onPick(f)}>{FIELD_LABEL[f]}</button>
        </li>
      ))}
    </ul>
  );
}

// The display-properties control: a sliders button beside the filter funnel that
// opens the shared OptionMenu over the card-property catalogue. The funnel picks
// WHICH cards show; this picks WHAT each card shows on its right edge. The
// choice lives in card-props.js (persisted, shared) — every card subscribes
// there, so this component only draws the menu.
function DisplayProps() {
  const [open, setOpen] = useState(false);
  const { order, shown } = useCardProps();
  const label = (key) => CARD_PROPS.find(p => p.key === key)?.label || key;
  const wrapRef = useDismiss(open, () => setOpen(false));
  useHotkey('Escape', () => setOpen(false), { enabled: open, terminal: 'handle', allowInInput: true });
  return (
    <div className="props-menu-wrap" ref={wrapRef}>
      <button className={`filter-toggle${open ? ' is-on' : ''}`}
        onClick={() => setOpen(o => !o)}
        title="Properties shown on cards" aria-label="Properties shown on cards"
        aria-haspopup="listbox" aria-expanded={open}>
        <PropsIcon />
      </button>
      {open ? (
        <OptionMenu className="props-menu"
          options={order.map(k => ({ value: k, label: label(k) }))}
          selected={shown} onToggle={toggleCardProp} onReorder={reorderCardProps} />
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
function FilterBar({ data, filters, setFilters }) {
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
  // "(none)" leads the set-valued fields: emptiness is a value here, so "has no
  // owner" is picked the same way "owned by Dennis" is. Created has no such row —
  // a dateless issue matches no bucket at all, which is a different fact.
  const optionsFor = (field) => {
    if (field === 'owner')   return withEmptyOption(owners.map(p => ({ value: p.email, label: p.name })));
    if (field === 'tags')    return withEmptyOption(tags.map(t => ({ value: t, label: t })));
    if (field === 'created') return CREATED_BUCKETS.map(b => ({ value: b.value, label: b.label }));
    return [];
  };

  // Switch a field's operator. Both operators take the same values, so flipping
  // between them keeps the selection — "contains dash" becomes "doesn't contain
  // dash" in one click, which is the whole point of putting them on one axis.
  const setFieldOp = (field, op) => setFilters(prev => ({ ...prev, [field]: { ...prev[field], op } }));
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
    return values.size ? `${opLabel} ${labels()}` : `${opLabel} …`;
  };
  const isPlaceholder = (field) => filters[field].values.size === 0;

  const active = anyFilterActive(filters);

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
              options={optionsFor(field)}
              selected={filters[field].values}
              single={SINGLE_SELECT_FIELDS.has(field)}
              onToggle={(v) => toggleValue(field, v)}
              renderOption={field === 'owner'
                ? (o) => (<><Avatar email={o.value} size={18} showTooltip={false} /><span className="person-name">{o.label}</span></>)
                : undefined}
              header={fieldHasOperators(field) ? (
                // Both operators sit in view and one click apart. As a dropdown
                // this cost two clicks and hid the alternative, which is a poor
                // trade for a choice that is binary and flipped often — the
                // whole point of putting both on one axis was cheap negation.
                <div className="seg filter-op" role="radiogroup"
                  aria-label={`${FIELD_LABEL[field]} operator`}>
                  {FILTER_OPERATORS.map(op => (
                    <button key={op.value} type="button" role="radio"
                      className={filters[field].op === op.value ? 'is-selected' : ''}
                      aria-checked={filters[field].op === op.value}
                      onClick={() => setFieldOp(field, op.value)}>{op.label}</button>
                  ))}
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
          {openField === '__add__' ? <AddFilterMenu fields={addable} onPick={setOpenField} /> : null}
        </div>
      ) : null}

      {/* Clear-all wears the same shape as a pill's own ✕, so "get rid of this
          one" and "get rid of all of them" read as the same gesture at two
          scopes. The count moved to the board title — it is a fact about what
          you are looking at, not a footnote on the filter bar. */}
      {active ? (
        <button type="button" className="filter-clear-all" onClick={clearAll}
          title="Clear all filters" aria-label="Clear all filters"><ClearIcon /></button>
      ) : null}
    </div>
  );
}

// One bucket, rendered in the active layout. Kanban → a vertical column of
// cards; list → a full-width stacked section of table rows. Both share the same
// colored collapse-toggle head (pill title · count · +) and the same drag
// placeholder machinery — only the outer container, body, and row markup differ
// by `layout`. The bucket tint comes from the `kcol-${tone}` var-only class,
// reused across both layouts.
function IssueColumn({ layout, title, tone, items, emptyMsg, collapsed, onToggle, colKey, dragId, placeAt, placeH, isDropTarget, bodyRef, onCardPointerDown, didDragRef, selectedId, rangeIds, headerSelected, onAdd }) {
  const list = layout === 'list';

  // Kanban collapses to a thin vertical rail; list collapses to just its head
  // row (body hidden). The shared `hidden` set drives both, so a bucket stays
  // collapsed across a layout switch.
  if (collapsed && !list) {
    return (
      <div className={`kcol kcol-${tone} kcol-collapsed${headerSelected ? ' is-kbd-selected' : ''}`}
        data-head-key={colKey} onClick={onToggle} title="Show column">
        <div className="kcol-railhead">
          <span className="kcol-count">{items.length}</span>
          <span className="kcol-railtitle">{title}</span>
        </div>
      </div>
    );
  }

  const head = (
    <div className={`${list ? 'list-head' : 'kcol-head'}${headerSelected ? ' is-kbd-selected' : ''}`}
      data-head-key={colKey} onClick={onToggle}
      title={collapsed ? 'Show section' : (list ? 'Hide section' : 'Hide column')} style={{ cursor: 'pointer' }}>
      <span className={`kcol-title pill bucket bucket-${colKey}`}>{title}</span>
      <span className="kcol-count">{items.length}</span>
      <button className="kcol-add" title={`New issue in ${title}`} aria-label={`New issue in ${title}`}
        onClick={(e) => { e.stopPropagation(); onAdd(); }}>+</button>
    </div>
  );

  if (collapsed && list) {
    return <div className={`list-section kcol-${tone} is-collapsed`}>{head}</div>;
  }

  // The lifted card is hidden from wherever it lives (its origin bucket); the
  // placeholder shows in the bucket under the pointer (target). placeAt is an
  // issue-only index (matching computeIndex + the committed id list), so the
  // placeholder is positioned before the placeAt-th ISSUE row — branch
  // pseudo-cards don't shift it.
  const visible = dragId ? items.filter(i => i.id !== dragId) : items;
  const ph = <div key="__ph" className="kcard-placeholder" style={{ height: placeH }} />;
  const rows = [];
  let issueIdx = 0, placed = false;
  for (const i of visible) {
    if (placeAt >= 0 && !placed && issueIdx === placeAt) { rows.push(ph); placed = true; }
    rows.push(<IssueCard key={i.id} layout={layout} i={i} colKey={colKey}
      onPointerDown={onCardPointerDown} didDragRef={didDragRef}
      selected={i.id === selectedId}
      inRange={!!rangeIds && rangeIds.size > 1 && rangeIds.has(i.id)} />);
    if (i.kind === 'issue') issueIdx++;
  }
  if (placeAt >= 0 && !placed) rows.push(ph);

  const outer = list
    ? `list-section kcol-${tone}${isDropTarget ? ' is-drop-target' : ''}`
    : `kcol kcol-${tone}${isDropTarget ? ' is-drop-target' : ''}`;

  return (
    <div className={outer}>
      {head}
      <div className={list ? 'list-body' : 'kcol-body'} ref={el => { bodyRef && bodyRef(el); }}>
        {visible.length === 0 && placeAt < 0
          ? <div className="kcol-empty">{emptyMsg}</div>
          : rows}
      </div>
    </div>
  );
}

function IssueCard({ layout, i, colKey, onPointerDown, didDragRef, selected, inRange }) {
  // Only real issue cards carry a board row, so only they are draggable. Live
  // branch pseudo-cards (kind 'branch') stay click-through links.
  // A mounted chat that's idle (waiting for input, for ANY reason — turn done,
  // asked a question, errored, exited) gets the "needs input" flag on its card.
  // Gated to the in-progress column: that lane is where active conversations
  // live (and are kept attached), so a stalled chat there is the only one worth
  // flagging. Working chats and issues with no mounted chat carry no flag.
  const activity = useActivity();
  const idle = i.status === 'in-progress' && issueActivity(activity, i) === 'idle';
  const draggable = i.kind === 'issue';
  const dragProps = draggable ? {
    draggable: false,
    // Origin column is where the card is RENDERED (colKey) — while a pending
    // write-through move awaits its server confirm, that can differ from the
    // row's last-fetched status.
    onPointerDown: (e) => onPointerDown(e, i.id, colKey),
    onClick: (e) => { if (didDragRef.current) { e.preventDefault(); e.stopPropagation(); } },
  } : {};
  // List rows and kanban cards are the same Link with the same drag wiring and
  // the same data-card attributes computeIndex reads — only the inner markup and
  // container class differ. The row is a dense table-cell line: idle dot · title
  // · the chosen properties, with a bottom rule between rows.
  if (layout === 'list') {
    return (
      <Link to={`/issues/${encodeURIComponent(i.id)}`} data-card-id={i.id} data-card-kind={i.kind}
        className={`krow issue-row status-${i.status}${draggable ? ' draggable' : ''}${selected ? ' is-selected' : ''}${inRange ? ' is-range' : ''}`}
        {...dragProps}>
        {idle ? <span className="kcard-idle-dot" title={`chat idle — needs your input · ${hkCaps('boardDismissFlag')} to dismiss`} /> : null}
        <span className="krow-title">{i.title}</span>
        <CardProps i={i} />
      </Link>
    );
  }
  return (
    <Link to={`/issues/${encodeURIComponent(i.id)}`} data-card-id={i.id} data-card-kind={i.kind}
      className={`kcard issue-card status-${i.status}${draggable ? ' draggable' : ''}${selected ? ' is-selected' : ''}${inRange ? ' is-range' : ''}`}
      {...dragProps}>
      <div className="kcard-title-row">
        {idle ? <span className="kcard-idle-dot" title={`chat idle — needs your input · ${hkCaps('boardDismissFlag')} to dismiss`} /> : null}
        <div className="kcard-title">{i.title}</div>
        <CardProps i={i} />
      </div>
    </Link>
  );
}

// The properties trailing a card (and a list row), against its right edge — a
// card is already dense, so each is a glance, not a line. Which ones show, and
// in what order, is the shared display-properties choice (owner alone, last, by
// default). A property with no value renders nothing at all rather than a
// placeholder — an unowned issue shows no empty circle, an untagged one no empty
// chip. Tags cut to two with a "+N", the same truncation the issue page uses.
const CARD_TAG_CAP = 2;
function cardPropValue(key, i) {
  if (key === 'owner') return <Avatar email={i.owner} size={17} className="card-avatar" />;
  if (key === 'tags') {
    const tags = i.tags || [];
    if (!tags.length) return null;
    return (
      <>
        {tags.slice(0, CARD_TAG_CAP).map(t => (
          <span key={t} className={`field-pill ${tagPillClass(t)} card-prop-tag`}><span className="pill-text">{t}</span></span>
        ))}
        {tags.length > CARD_TAG_CAP
          ? <span className="field-pill card-prop-tag chip-overflow" title={tags.slice(CARD_TAG_CAP).join('\n')}>+{tags.length - CARD_TAG_CAP}</span>
          : null}
      </>
    );
  }
  if (key === 'id') return <span className="card-prop-id">{i.id}</span>;
  if (key === 'created') {
    const created = i.created_at || i.created;
    return created ? <span className="card-prop-date" title={`created ${created}`}>{fmtDate(created)}</span> : null;
  }
  if (key === 'updated') {
    return i.updated ? <span className="card-prop-date" title={`updated ${i.updated}`}>{fmtDate(i.updated)}</span> : null;
  }
  return null;
}
function CardProps({ i }) {
  const { order, shown } = useCardProps();
  if (!shown.size) return null;
  return (
    <span className="card-props">
      {order.filter(k => shown.has(k)).map(k => (
        <React.Fragment key={k}>{cardPropValue(k, i)}</React.Fragment>
      ))}
    </span>
  );
}
