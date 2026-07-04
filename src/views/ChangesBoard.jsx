import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAsync, useIssuesRealtime } from '../api.js';
import { useActivity } from '../activity-store.js';
import { listChanges, createChange, moveChange, reorderChange } from '../board-store.js';
import { insertionIndex } from './dragOrder.js';
import { useSelection } from '../selection.jsx';
import { columnCompare, archiveCompare, ARCHIVE_COLS } from '../board-sort.js';

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
  const { selectedId, setSelectedId, chatFocused } = useSelection();
  const [search, setSearch] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [activeTags, setActiveTags] = useState(() => new Set());
  const toggleTag = (t) => setActiveTags(prev => {
    const next = new Set(prev);
    next.has(t) ? next.delete(t) : next.add(t);
    return next;
  });
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

  // All tags present across the corpus, for the filter chips.
  const allTags = useMemo(() => {
    const s = new Set();
    for (const i of data ?? []) for (const t of i.tags ?? []) s.add(t);
    return [...s].sort();
  }, [data]);

  const filtered = useMemo(() => {
    let rows = data ?? [];
    if (activeTags.size) rows = rows.filter(i => (i.tags ?? []).some(t => activeTags.has(t)));
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(i => (i.id + ' ' + (i.title || '') + ' ' + (i.tags || []).join(' ')).toLowerCase().includes(q));
    }
    return rows;
  }, [data, activeTags, search]);

  // Drag is disabled while a filter is active: a column then shows only a subset
  // of its cards, so renumbering it from the visible set would collide with (and
  // reorder relative to) the hidden cards. Clear the filter to reorder.
  const filterActive = activeTags.size > 0 || search.trim() !== '';

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
  useEffect(() => { setOverride({}); }, [data]);

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

  // Keyboard cursor. The grid is the visible (non-collapsed, non-empty) columns
  // in board order, each carrying its displayed id list — the exact same order
  // the user sees. ↑/↓ walk a column, ←/→ jump columns (clamping the row to the
  // new column's length), Enter opens the selected card. Collapsed and empty
  // columns are skipped so an arrow always lands on a real card.
  const moveSelection = (dir) => {
    const grid = BUCKETS
      .filter(b => !hidden.has(b.key))
      .map(b => displayItems(b.key).map(x => x.id))
      .filter(ids => ids.length);
    if (!grid.length) return;
    let ci = grid.findIndex(ids => ids.includes(selectedId));
    if (ci < 0) { setSelectedId(grid[0][0]); return; }
    let ri = grid[ci].indexOf(selectedId);
    if (dir === 'up') ri = Math.max(0, ri - 1);
    else if (dir === 'down') ri = Math.min(grid[ci].length - 1, ri + 1);
    else if (dir === 'left') ci = Math.max(0, ci - 1);
    else if (dir === 'right') ci = Math.min(grid.length - 1, ci + 1);
    ri = Math.min(ri, grid[ci].length - 1);
    setSelectedId(grid[ci][ri]);
  };

  useEffect(() => {
    // The board stays mounted while you're on other routes (hidden via CSS), so
    // only the visible board owns the arrow/Enter keys — otherwise it would
    // hijack them on the Tests/Dashboard pages.
    if (!visible) return undefined;
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (drag) return; // don't fight an in-flight pointer drag
      if (e.metaKey || e.ctrlKey) return; // ⌘←/⌘→ are the Shell's chat-focus toggle, not card nav
      const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
      if (dir) { e.preventDefault(); moveSelection(dir); }
      else if (e.key === 'Enter' && selectedId) { e.preventDefault(); navigate(`/changes/${encodeURIComponent(selectedId)}`); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // On board load, park the keyboard cursor on the top of In Progress (where
  // active work is) so arrows move from there immediately. Only when nothing is
  // already selected on the board — returning from a detail keeps its card.
  useEffect(() => {
    if (!data) return;
    if (selectedId && filtered.some(i => i.id === selectedId)) return;
    const top = (key) => displayItems(key)[0]?.id;
    const pick = top('in-progress')
      ?? BUCKETS.filter(b => !hidden.has(b.key)).map(b => top(b.key)).find(Boolean);
    if (pick) setSelectedId(pick);
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
            className={`filter-toggle${showFilters || activeTags.size ? ' is-on' : ''}`}
            onClick={() => setShowFilters(s => !s)}
            title={showFilters ? 'Hide filters' : 'Show filters'}
            aria-label="Toggle tag filters"
            aria-pressed={showFilters}
          >
            <FilterIcon />
          </button>
          <div className="search-field">
            <SearchIcon />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
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
        </div>
      </div>
      {/* Tag filters sit directly above the board they filter; revealed by the
          filter toggle, and forced open whenever a tag filter is active. */}
      {showFilters || activeTags.size ? (
        <div className="tag-bar">
          <div className="tag-chips">
            {allTags.map(t => (
              <button
                key={t}
                className={`chip${activeTags.has(t) ? ' chip-on' : ''}`}
                onClick={() => toggleTag(t)}
              >{t}</button>
            ))}
            {activeTags.size ? (
              <>
                <button className="chip chip-clear" onClick={() => setActiveTags(new Set())}>clear</button>
                <span className="dim count">{filtered.length} of {data?.length ?? 0}</span>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      {err ? <div className="error">{err}</div> : null}
      {writeErr ? <div className="error" onClick={() => setWriteErr(null)} style={{ cursor: 'pointer' }}>{writeErr}</div> : null}
      {loading && !data ? <div className="spin">loading…</div> : null}
      {data ? (
        <div className={`kanban kanban-5${drag ? ' is-dragging' : ''}`}>
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

function IssueColumn({ title, tone, items, emptyMsg, collapsed, onToggle, colKey, dragId, placeAt, placeH, isDropTarget, bodyRef, onCardPointerDown, didDragRef, dragDisabled, selectedId, onAdd }) {
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
      selected={i.id === selectedId} />);
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

function IssueCard({ i, colKey, onPointerDown, didDragRef, dragDisabled, selected }) {
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
      className={`kcard issue-card status-${i.status}${i.live ? ' is-live' : ''}${draggable ? ' draggable' : ''}${selected ? ' is-selected' : ''}`}
      {...dragProps}>
      {i.live ? <div className="kcard-head"><span className="pill live-tag" title={`branch live (pid ${i.live_pid})`}>● live</span></div> : null}
      <div className="kcard-title-row">
        {idle ? <span className="kcard-idle-dot" title="chat idle — needs your input" /> : null}
        <div className="kcard-title">{i.title}</div>
      </div>
    </Link>
  );
}
