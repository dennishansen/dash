import React, { useEffect, useLayoutEffect, useState, useRef, useMemo } from 'react';
import { Link, useParams, useNavigate, useLocation } from 'react-router-dom';
import { useAsync, useIssuesRealtime, fmtDate } from '../api.js';
import { changeDetail, renameChange, updateChangeField, setChangeStatus, setChangeDep, deleteChange, listChanges } from '../board-store.js';
import { BUCKETS } from './ChangesBoard.jsx';
import { useLocalBackend } from '../capabilities.js';
import { useSelection, useIssueNav } from '../selection.jsx';
import { useActivity } from '../activity-store.js';
import { Markdown } from './Markdown.jsx';
import { CopyButton } from './CopyButton.jsx';
import { useChatControl } from '../chat-control.jsx';
import { X, Pencil, Trash, User, ArrowUpRight } from '../icons.jsx';
import { Avatar, PersonLabel, usePeople, useDismiss, normalizeEmail } from '../profiles.jsx';
import { OptionMenu } from '../OptionMenu.jsx';
import { useAnchoredPopover } from '../popover.js';
import { tagPillClass } from '../tag-style.js';

// Inline-editable issue title. Looks like the static <h2> (CSS .title-edit),
// gaining a box outline only on hover / focus. Enter or blur saves via
// renameChange (Supabase, works remotely too); Escape reverts. On a failed
// write we restore the prior title rather than leave a phantom edit on screen.
function EditableTitle({ id, title, onSaved, autoFocus }) {
  const [val, setVal] = useState(title);
  const skipBlur = useRef(false);
  const ref = useRef(null);
  // On a fresh create the board navigates here with a focus flag — select the
  // placeholder title so the user can just type the real one. Once only.
  useEffect(() => {
    if (!autoFocus) return;
    const el = ref.current;
    if (el) { el.focus(); el.select(); }
  }, [autoFocus]);
  // Grow the textarea to fit its content (no scrollbar, no fixed rows).
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  // Resync if server truth changes under us (background refresh / another tab),
  // and re-fit on every value change (typing, resync, mount).
  useEffect(() => { setVal(title); }, [title]);
  useEffect(() => { fit(); }, [val]);

  const save = async () => {
    const next = val.trim();
    if (!next || next === title) { setVal(title); return; }
    try {
      const r = await renameChange(id, next);
      if (r && r.error) throw new Error(r.error);
      onSaved && onSaved();
    } catch {
      setVal(title);
    }
  };

  return (
    <textarea
      ref={ref}
      className="title-edit"
      value={val}
      rows={1}
      spellCheck={false}
      aria-label="issue title"
      onChange={e => setVal(e.target.value)}
      onKeyDown={e => {
        // Enter saves (titles are single-value — wrapping handles long text);
        // it never inserts a newline. Escape reverts.
        if (e.key === 'Enter') { e.preventDefault(); skipBlur.current = true; save(); e.currentTarget.blur(); }
        else if (e.key === 'Escape') { e.preventDefault(); skipBlur.current = true; setVal(title); e.currentTarget.blur(); }
      }}
      onBlur={() => { if (skipBlur.current) { skipBlur.current = false; return; } save(); }}
    />
  );
}

// A property with no value: a dashed slot the size of a chip, not the words
// "Empty" / "none" — an empty cell then reads as a shape waiting to be filled and
// still lines up with a filled one. Text-valued properties (created by) keep
// their grey word instead; there is no chip there to stand in for.
function EmptySlot({ label }) {
  return <span className="field-empty" role="presentation" title={label} aria-label={label} />;
}

// One chip inside a ChipMultiSelect trigger. A plain display pill (the trigger
// wrapper owns the click that opens the editor). When the chip carries a `to` it
// also gets a hover/focus-reveal external-link glyph (the .field-pill--reveal
// pattern) that navigates straight to that target; stopPropagation keeps that
// click from also toggling the menu. Long labels truncate. (OSS uses this only
// for tags today — tags carry no `to` — but it stays generic to match private.)
function Chip({ label, className = '', to }) {
  const body = <span className="chip-label">{label}</span>;
  if (!to) return <span className={`field-pill ${className}`}>{body}</span>;
  return (
    <span className={`field-pill field-pill--reveal ${className}`}>
      {body}
      <Link className="pill-reveal" to={to} title={`Open ${label}`}
        aria-label={`Open ${label}`} onClick={e => e.stopPropagation()}>
        <ArrowUpRight size={12} />
      </Link>
    </span>
  );
}

// The shared chip-multiselect shell. The value ITSELF is the trigger: the chips
// (or an "Empty" placeholder) are clickable and open the editor. The dropdown IS
// the shared OptionMenu (the same popover the board filters use): a search/create
// header, then the whole vocabulary as a checklist with the SELECTED members
// floated to the top. When `onCreate` is supplied (free-text tags) a "Create
// <query>" row appears for a query that matches nothing.
//
//   selected: [{ key, label, className?, to? }]  the chips currently on
//   options:  [{ key, label }]                   the add-vocabulary (selected filtered out)
//   onToggle(key)   flip membership       onCreate(query)?  add a brand-new member
function ChipMultiSelect({ selected, options, onToggle, onCreate, triggerTitle, emptyLabel = 'nothing set', searchPlaceholder = 'Search…', emptyHint }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const inputRef = useRef(null);
  const close = () => { setOpen(false); setQ(''); };
  const wrapRef = useDismiss(open, close);
  // Capture phase + stopPropagation so Escape closes the menu WITHOUT also
  // reaching the detail view's "Escape → back to board" listener — the same
  // pattern StatusPill / OwnerAvatar use (OSS ChangeDetail avoids useHotkey here).
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  const VISIBLE = 2; // chips shown inline before collapsing the rest into "+N"
  const query = q.trim();
  const match = (label) => label.toLowerCase().includes(query.toLowerCase());
  const selectedKeys = new Set(selected.map(s => s.key));
  // Selected first, then the rest of the vocabulary, both filtered by the query —
  // one flat OptionMenu list (checks distinguish the selected, which float to top).
  const checked = query ? selected.filter(s => match(s.label)) : selected;
  const rest = (options || []).filter(o => !selectedKeys.has(o.key) && (!query || match(o.label)));
  const menuOptions = [...checked, ...rest].map(o => ({ value: o.key, label: o.label }));
  const canCreate = !!onCreate && !!query
    && ![...(options || []), ...selected].some(o => o.label.toLowerCase() === query.toLowerCase());
  const commitFirst = () => {
    if (rest[0]) { onToggle(rest[0].key); setQ(''); }
    else if (canCreate) { onCreate(query); setQ(''); }
  };

  return (
    <span className="chip-select" ref={wrapRef}>
      {/* role=button (not <button>) so a chip can legally nest its reveal <Link>.
          Enter/Space open; the whole value is one click target. */}
      <div className="chip-trigger" role="button" tabIndex={0} title={triggerTitle}
        aria-haspopup="listbox" aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); setOpen(o => !o); } }}>
        {selected.length ? (
          <>
            {selected.slice(0, VISIBLE).map(s => <Chip key={s.key} {...s} />)}
            {selected.length > VISIBLE ? <span className="field-pill chip-overflow">+{selected.length - VISIBLE}</span> : null}
          </>
        ) : <EmptySlot label={emptyLabel} />}
      </div>
      {open ? (
        <OptionMenu
          className="chip-menu"
          options={menuOptions}
          selected={selectedKeys}
          onToggle={onToggle}
          header={
            <input ref={inputRef} className="chip-search" value={q} spellCheck={false}
              placeholder={searchPlaceholder} aria-label={searchPlaceholder}
              onChange={e => setQ(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); commitFirst(); }
                else if (e.key === 'Escape') { e.preventDefault(); close(); }
              }} />
          }
          footer={
            canCreate ? (
              <button type="button" className="owner-pick chip-create"
                onClick={() => { onCreate(query); setQ(''); }}>
                Create “{query}”
              </button>
            ) : (!menuOptions.length ? <div className="filter-menu-note dim">{emptyHint}</div> : null)
          } />
      ) : null}
    </span>
  );
}

// Tags configured on the shared shell: free-text labels over the board's tag
// vocabulary, create-on-miss, no external link. The mutation is updateChangeField
// (then onChanged refreshes the detail, matching OSS's other field writers).
function TagSelect({ id, tags, allTags, onChanged }) {
  const toggle = async (t) => {
    const tag = t.trim();
    if (!tag) return;
    const next = tags.includes(tag) ? tags.filter(x => x !== tag) : [...tags, tag];
    const r = await updateChangeField(id, 'tags', next);
    if (!(r && r.error)) onChanged?.();
  };
  const selected = tags.map(t => ({ key: t, label: t, className: tagPillClass(t) }));
  const options = (allTags || []).map(t => ({ key: t, label: t }));
  return (
    <ChipMultiSelect selected={selected} options={options} onToggle={toggle} onCreate={toggle}
      triggerTitle="Edit tags" searchPlaceholder="Search or create…"
      emptyHint="no tags yet" />
  );
}

// Requires/unlocks configured on the shared shell: chips read as issue TITLES
// (from `known`, with the id as a dangling fallback), each with an external-link
// out; the add-vocabulary is every other issue by title (no free-text create).
// The mutation is setChangeDep, which maintains the INVERSE edge on the other
// issue's row — dropping a `requires` drops the matching `unlocks` there — then
// re-fetches so both chip rows repaint.
function DepSelect({ id, field, list, known, onChanged }) {
  const toggle = async (dep) => {
    if (!dep || dep === id) return;
    const has = list.includes(dep);
    const r = await setChangeDep(id, field, dep, !has);
    if (!(r && r.error)) onChanged?.();
  };
  const selected = list.map(dep => {
    const meta = known.get(dep);
    return {
      key: dep,
      label: meta ? (meta.title || dep) : dep,
      className: meta ? 'deps-chip' : 'deps-chip deps-chip--dangling',
      to: `/changes/${encodeURIComponent(dep)}`,
    };
  });
  const options = [...known.values()]
    .filter(r => r.id !== id)
    .map(r => ({ key: r.id, label: r.title || r.id }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return (
    <ChipMultiSelect selected={selected} options={options} onToggle={toggle}
      triggerTitle={`Edit ${field}`} searchPlaceholder="Search issues…"
      emptyHint="no other issues" />
  );
}

// A convo pill (opens the chat) whose hover-X is a two-step unlink: first click
// swaps the pill into a remove/cancel confirm (it severs a chat link), mirroring
// Terminal.jsx's ChatSwitcher. Only on confirm do we write the shortened list.
function ConvoPill({ id, convo, conversations, onChanged, onOpen }) {
  const [confirming, setConfirming] = useState(false);
  const remove = async (e) => {
    e.stopPropagation();
    const next = conversations.filter(c => c !== convo);
    const r = await updateChangeField(id, 'conversations', next);
    setConfirming(false);
    if (!(r && r.error)) onChanged();
  };
  return (
    <span className="field-pill field-pill--reveal">
      <button type="button" className="convo-open" title="Open this chat"
        style={{ all: 'unset', cursor: 'pointer' }}
        onClick={() => onOpen?.()}>{String(convo).slice(0, 8)}</button>
      {confirming ? (
        <span className="pill-confirm" onClick={e => e.stopPropagation()}>
          <button type="button" className="issue-chat-confirm-yes" title="Confirm remove"
            onClick={remove}>remove</button>
          <button type="button" className="issue-chat-confirm-no" title="Cancel"
            onClick={(e) => { e.stopPropagation(); setConfirming(false); }}>cancel</button>
        </span>
      ) : (
        <button type="button" className="pill-reveal pill-reveal--remove"
          title="Remove this chat from the issue" aria-label="Remove chat"
          onClick={(e) => { e.stopPropagation(); setConfirming(true); }}>
          <X size={12} />
        </button>
      )}
    </span>
  );
}

// The owner affordance — a compact avatar button beside the status pill under the
// title, NOT a property row. An owner is metadata about WHO, and reads best as a
// face next to the state, the way every issue tracker shows an assignee. Empty is
// a real, first-class answer, so it's not hidden: a dotted circle holding a grey
// person glyph, quiet at rest but a real "assign" button. Assigned swaps to the
// person's photo. Clicking either opens the roster picker; picking reassigns, the
// menu's "unassign" clears it.
//
// `owner` holds an EMAIL — the same key profiles and the allow-list use — so the
// person shown is an exact lookup, never a name match, and the picker is the only
// way to set it from the UI, which is what keeps the column from drifting back
// into the free text it used to be.
function OwnerAvatar({ id, owner }) {
  const [picking, setPicking] = useState(false);
  const { ref: menuRef, style: menuStyle } = useAnchoredPopover(picking);
  const people = usePeople();
  const wrapRef = useDismiss(picking, () => setPicking(false));
  // Escape closes the picker without also reaching the detail view's bubble-
  // phase "Escape → back to board" listener — capture phase + stopPropagation,
  // the same pattern StatusPill uses.
  useEffect(() => {
    if (!picking) return;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setPicking(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [picking]);

  const assign = (email) => {
    setPicking(false);
    if (email !== (owner || null)) updateChangeField(id, 'owner', email);
  };
  const key = normalizeEmail(owner);
  // The avatar is nameless on its face, so the tooltip/label must carry WHO —
  // otherwise a hover reads "Change owner" and the assignee's name is lost.
  // Resolve from the roster; fall back to the email.
  const name = key ? (people.find(p => p.email === key)?.name || key) : null;
  const label = name ? `Owner: ${name} — click to change` : 'Assign an owner';

  return (
    <span className="owner-avatar-wrap" ref={wrapRef}>
      <button type="button" className={`owner-avatar${key ? ' is-set' : ' is-empty'}`}
        title={label}
        aria-haspopup="listbox" aria-expanded={picking}
        aria-label={label}
        onClick={() => setPicking(p => !p)}>
        {key ? <Avatar email={key} size={22} showTooltip={false} /> : <User size={14} />}
      </button>
      {picking ? (
        <ul className="owner-menu" role="listbox" ref={menuRef} style={menuStyle}>
          {people.map(p => (
            <li key={p.email}>
              <button type="button" className={`owner-pick${p.email === key ? ' is-current' : ''}`}
                role="option" aria-selected={p.email === key} onClick={() => assign(p.email)}>
                <Avatar email={p.email} size={18} showTooltip={false} />
                <span className="person-name">{p.name}</span>
              </button>
            </li>
          ))}
          {key ? (
            <li>
              <button type="button" className="owner-pick owner-pick--clear"
                onClick={() => assign(null)}>unassign</button>
            </li>
          ) : null}
          {people.length === 0 ? <li className="owner-menu-empty dim">nobody on this board yet</li> : null}
        </ul>
      ) : null}
    </span>
  );
}

// Read-only value pills (branch names, commit shas, session ids: derived
// worktree/chat metadata, not user-set). Capped at two visible with the rest
// collapsing into a "+N" — the same truncation the chip trigger uses — so a
// cell's width stays predictable however many an issue collects. Empty reads a
// dashed slot like every other empty cell.
const PILL_CAP = 2;
function PillValue({ values }) {
  if (!values.length) return <EmptySlot label="nothing set" />;
  const extra = values.length - PILL_CAP;
  return (
    <span className="prop-pills">
      {values.slice(0, PILL_CAP).map(v => <span key={v} className="field-pill" title={v}>{v}</span>)}
      {extra > 0 ? <span className="field-pill chip-overflow" title={values.slice(PILL_CAP).join('\n')}>+{extra}</span> : null}
    </span>
  );
}

// Every property of an issue, as one strip of labelled cells — status, owner,
// tags and the dependencies included, so there is a single properties surface
// rather than a bar plus a list. Nothing hides by policy: the strip wraps, and
// while collapsed only its FIRST ROW shows, so what "Show more properties"
// reveals is simply whatever didn't fit. Order is priority — the three that are
// always editable, then properties holding a value, then empty ones, then the
// provenance and timestamps — so a narrow pane keeps the meaningful cells on the
// visible row.
//
// The row height and the cells that fit are MEASURED (and re-measured on resize)
// rather than assumed. Off-row cells stay in the layout with visibility:hidden,
// which is what keeps that measurement valid while collapsed — and lets an open
// menu on a visible cell spill past the strip instead of being clipped. Expand
// state is per-mount — the parent keys this by issue id, so navigating to
// another issue resets it (no persistence).
function IssueProperties({ data, known, local, allTags, column, refresh }) {
  const [open, setOpen] = useState(false);
  const [rowH, setRowH] = useState(0);
  const [fit, setFit] = useState(0);
  const stripRef = useRef(null);
  const id = data.id;
  const status = data.status || 'next';
  const requires = data.requires || [];
  const unlocks = data.unlocks || [];
  const branches = (data.branches?.length ? data.branches : [data.branch]).filter(Boolean);
  const sessions = data.sessions || [];

  const pinned = [
    { key: 'status', label: 'status', value: <StatusPill id={id} status={status} onChanged={refresh} /> },
    { key: 'owner', label: 'owner', value: <OwnerAvatar id={id} owner={data.owner} /> },
    { key: 'tags', label: 'tags', width: 190, value: <TagSelect id={id} tags={data.tags || []} allTags={allTags} onChanged={refresh} /> },
  ];
  // Dependencies are cells like any other property — an empty one reads as a
  // dashed slot and is still the editor's trigger, which is how a first edge
  // gets added.
  const rest = [
    { key: 'requires', label: 'requires', width: 210, has: requires.length > 0, attrs: { 'data-dep-field': 'requires' }, value: <DepSelect id={id} field="requires" list={requires} known={known} onChanged={refresh} /> },
    { key: 'unlocks', label: 'unlocks', width: 210, has: unlocks.length > 0, attrs: { 'data-dep-field': 'unlocks' }, value: <DepSelect id={id} field="unlocks" list={unlocks} known={known} onChanged={refresh} /> },
  ];
  // branch/sessions are read-only worktree/chat metadata. When empty they only
  // exist on a LOCAL backend — remotely they are structurally always empty, so
  // listing them there would be permanent noise. `local !== false` keeps them in
  // while the probe is still deciding (null).
  if (branches.length || local !== false) rest.push({ key: 'branch', label: 'branch', width: 200, has: branches.length > 0, value: <PillValue values={branches} /> });
  if (sessions.length || local !== false) rest.push({ key: 'sessions', label: 'sessions', width: 200, has: sessions.length > 0, value: <PillValue values={sessions} /> });

  const cells = [
    ...pinned,
    ...rest.filter(p => p.has),
    ...rest.filter(p => !p.has),
    // Provenance + timestamps last, all read-only. "created by" pairs with
    // "created" (who + when); a pre-column row with no stored creator reads
    // "unknown".
    { key: 'created', label: 'created', width: 110, value: <span className="field-meta" title={data.created_at || ''}>{fmtDate(data.created_at)}</span> },
    { key: 'created_by', label: 'created by', width: 170, value: normalizeEmail(data.created_by) ? <PersonLabel email={data.created_by} /> : <span className="field-word-empty">unknown</span> },
    { key: 'updated', label: 'updated', width: 110, value: <span className="field-meta" title={data.updated || ''}>{fmtDate(data.updated)}</span> },
  ];

  // How many cells share the first row, and how tall that row is (cells differ
  // in height — an avatar sits taller than a date, so take the tallest). A
  // column has one cell per row and shows everything, so it never measures.
  useLayoutEffect(() => {
    const el = stripRef.current;
    if (!el || column) return;
    const measure = () => {
      const kids = [...el.children];
      if (!kids.length) return;
      const top = kids[0].offsetTop;
      const row = kids.filter(k => k.offsetTop === top);
      setRowH(Math.max(...row.map(k => k.offsetHeight)));
      setFit(row.length);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [data, local, open, column]);

  const overflows = !column && fit > 0 && cells.length > fit;
  const collapsed = overflows && !open;

  return (
    <>
      <div className={`props-strip${column ? ' props-strip--column' : ''}`} ref={stripRef}
        style={collapsed && rowH ? { height: rowH } : undefined}>
        {cells.map((c, i) => (
          <PropCell key={c.key} label={c.label} width={column ? undefined : c.width}
            offRow={collapsed && i >= fit} {...(c.attrs || {})}>
            {c.value}
          </PropCell>
        ))}
      </div>
      {overflows ? (
        <button type="button" className="more-props-toggle" aria-expanded={open}
          onClick={() => setOpen(o => !o)}>
          {open ? 'Show fewer properties' : `+ Show ${cells.length - fit} more properties`}
        </button>
      ) : null}
    </>
  );
}

// A labelled property cell: a small grey label ABOVE its value. EVERY property
// wears this shape — status, owner, tags, dependencies, branch, sessions, the
// timestamps — so the block reads as one Notion-style strip. `width` caps the
// cell so a long value truncates inside itself instead of shoving its neighbours
// off the row. `offRow` is a cell that wrapped past the first row while the
// strip is collapsed: hidden by visibility, so it keeps its place in the layout
// (and stays measurable) but is neither visible nor tabbable.
function PropCell({ label, width, offRow, children, ...rest }) {
  return (
    <div className={`prop-cell${offRow ? ' prop-cell--offrow' : ''}`}
      style={width ? { maxWidth: width } : undefined} {...rest}>
      <span className="prop-label">{label}</span>
      <span className="prop-value">{children}</span>
    </div>
  );
}

// The properties column is a FIXED 200 with 32 of air beside it; the body keeps
// its 560px reading measure when there's room and gives way down to 360 when
// there isn't. So the column appears as soon as the pane can hold the narrow
// body plus the column — not only once the body is at full width — and the two
// together stay centred in the pane.
const BODY_MIN = 360, BODY_MAX = 560, PROPS_W = 200, PROPS_GAP = 32;
const SIDEBAR_MIN = BODY_MIN + PROPS_GAP + PROPS_W;

// Clickable status pill: looks like the static bucket pill but opens a menu of
// the six columns. Picking one writes the issue's status directly (setStatus —
// no column reorder, the card just changes lanes) and refreshes. This is the
// detail-view twin of dragging a card between columns on the board. Click-
// outside or Escape closes; the current status is marked and disabled.
function StatusPill({ id, status, onChanged }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef(null);
  const { ref: menuRef, style: menuStyle } = useAnchoredPopover(open);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    // Capture phase + stopPropagation so Escape closes the menu WITHOUT also
    // reaching the detail view's bubble-phase "Escape → back to board" listener.
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey, true); };
  }, [open]);

  const pick = async (next) => {
    if (next === status) { setOpen(false); return; }
    setBusy(true);
    const r = await setChangeStatus(id, next);
    setBusy(false);
    setOpen(false);
    if (!(r && r.error)) onChanged?.();
  };

  return (
    <span className="status-menu-wrap" ref={wrapRef}>
      <button type="button" className={`pill bucket-${status} status-trigger`}
        aria-haspopup="listbox" aria-expanded={open} disabled={busy}
        title="Change status" onClick={() => setOpen(o => !o)}>
        {status}
      </button>
      {open ? (
        <ul className="status-menu" role="listbox" ref={menuRef} style={menuStyle}>
          {BUCKETS.map(b => (
            <li key={b.key} className={`status-item${b.key === status ? ' is-current' : ''}`}>
              <button type="button" className={`status-pick pill bucket-${b.key}`}
                role="option" aria-selected={b.key === status}
                disabled={busy || b.key === status} onClick={() => pick(b.key)}>
                {b.title}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </span>
  );
}

// Editable issue body. Renders markdown read-only with a reveal-on-hover pencil;
// clicking it swaps to a raw-markdown textarea. ⌘/Ctrl+Enter or Save commits via
// updateChangeField (Supabase, works remotely); Escape or Cancel reverts. The
// empty state is itself the entry point — click "add a description" to start.
function BodyEditor({ id, body, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(body || '');
  const ref = useRef(null);
  useEffect(() => { if (!editing) setVal(body || ''); }, [body, editing]);
  useEffect(() => { if (editing) { const el = ref.current; if (el) { el.focus(); el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } } }, [editing]);

  const save = async () => {
    const next = val;
    if (next === (body || '')) { setEditing(false); return; }
    const r = await updateChangeField(id, 'body', next);
    if (!(r && r.error)) { setEditing(false); onSaved?.(); }
    else setEditing(false);
  };

  if (editing) {
    return (
      <div className="recap-body recap-body--editing">
        <textarea
          ref={ref}
          className="body-edit"
          value={val}
          spellCheck={false}
          aria-label="issue body (markdown)"
          placeholder="Write a description… (markdown)"
          onChange={e => { setVal(e.target.value); const el = e.target; el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; }}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
            else if (e.key === 'Escape') { e.preventDefault(); setVal(body || ''); setEditing(false); }
          }}
        />
        <div className="body-edit-actions">
          <button type="button" className="body-edit-save" onClick={save}>Save</button>
          <button type="button" className="body-edit-cancel" onClick={() => { setVal(body || ''); setEditing(false); }}>Cancel</button>
          <span className="body-edit-hint">⌘↵ to save · esc to cancel</span>
        </div>
      </div>
    );
  }

  if (!body) {
    return (
      <button type="button" className="empty body-empty-add" onClick={() => setEditing(true)}>
        <Pencil size={12} /> add a description
      </button>
    );
  }

  return (
    <div className="recap-body recap-body--editable">
      <button type="button" className="body-edit-btn" title="Edit description"
        aria-label="Edit description" onClick={() => setEditing(true)}><Pencil size={13} /></button>
      <Markdown text={body} />
    </div>
  );
}

// Destructive delete for the whole issue, top-right of the detail head. Double
// opt-in (the issue body's requirement): a resting trash icon, first click
// reveals a "delete / cancel" confirm, only the second click drops the Supabase
// row — then we leave the now-dead detail route and return to the board. Mirrors
// ConvoPill's two-step pattern, escalated to red because this can't be undone.
function DeleteIssue({ id, onDeleted }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const del = async () => {
    setBusy(true); setErr(null);
    const r = await deleteChange(id);
    if (r && r.error) { setErr(r.error); setBusy(false); setConfirming(false); return; }
    onDeleted?.();
  };
  if (confirming) {
    return (
      <span className="issue-delete-confirm">
        <button type="button" className="issue-delete-yes" disabled={busy}
          title="Permanently delete this issue" onClick={del}>
          {busy ? 'deleting…' : 'delete'}
        </button>
        <button type="button" className="issue-delete-no" disabled={busy}
          title="Cancel" onClick={() => { setConfirming(false); setErr(null); }}>cancel</button>
        {err ? <span className="error">{err}</span> : null}
      </span>
    );
  }
  return (
    <button type="button" className="icon-btn issue-delete-btn" title="Delete this issue"
      aria-label="Delete this issue" onClick={() => setConfirming(true)}><Trash size={15} /></button>
  );
}

// Unified detail for a single change. Reads the issue straight from Supabase
// (board-store), so it works remotely. The live-branch (kind 'branch') variant
// only ever appears via the local backend's listing; remotely every card is an
// issue. The worktree-app link is gated on a local backend below.
export function ChangeDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const focusTitle = location.state?.focusTitle === true;
  const local = useLocalBackend();
  const { setSelection } = useSelection();
  const requestChat = useChatControl();
  const activity = useActivity();
  // Read the issue straight from Supabase (board-store) so detail works remotely.
  const { data, err, loading, refresh } = useAsync(`change:${id}`, () => changeDetail(id));
  // Every tag in use across the board — the tag multiselect's option list (issue
  // tags are free text, so this is a convenience set, not a closed vocabulary).
  // Shares the board's 'changes' cache key, so it's already warm.
  const { data: allIssues } = useAsync('changes', listChanges);
  const allTags = useMemo(() => [...new Set((allIssues || []).flatMap(r => r.tags || []))].sort(), [allIssues]);
  // Known issues for the deps panel: id→row, powering the requires/unlocks chip
  // titles, typeahead options, and dangling detection. Shares the same 'changes'
  // cache as allTags — one cheap list fetch (no bodies).
  const known = useMemo(() => new Map((allIssues || []).map(r => [r.id, r])), [allIssues]);
  // Live updates everywhere: any issue row change arrives over the browser-side
  // Supabase Realtime subscription the board uses (realtime.js), so convos /
  // branches refresh without a poll wait — local and remote alike.
  useIssuesRealtime(refresh);

  // Record which card we came in on, so ⌘← / Esc returns the board cursor here.
  useEffect(() => { setSelection(id); }, [id, setSelection]);
  // Neighbors on the board's published order — used to park the cursor after a
  // delete (the card that slides into the deleted slot).
  const { prevId, nextId } = useIssueNav(id);
  // Properties ride to the RIGHT of the body once the pane is wide enough to
  // hold both, and sit above it as a strip when it isn't. The pane is what
  // changes width here (the chat/app docks open and close beside it), so this
  // watches the scroll container rather than the window.
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const el = document.querySelector('.main');
    if (!el) return;
    // The pane's CONTENT box — its padding is not space the columns can use.
    const measure = () => {
      const cs = getComputedStyle(el);
      const inner = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      setWide(inner >= SIDEBAR_MIN);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // ⌘← (not bare ←, which collides with text-cursor / nav) or Esc → board.
      if ((e.key === 'ArrowLeft' && (e.metaKey || e.ctrlKey)) || e.key === 'Escape') {
        e.preventDefault();
        navigate('/');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  if (loading && !data) return <div className="spin">loading…</div>;
  if (err) return <div className="error">{err}</div>;
  if (!data) return <div className="error">not found</div>;

  const isIssue = data.kind === 'issue';
  const status = data.status || (data.live ? 'next' : 'next');
  // Same idle-chat marker as the board card, with the same gate: only an
  // in-progress issue's idle chat flags. Off that column, no flag.
  const idle = status === 'in-progress' && activity[data.id] === 'idle';
  const body = data.body ?? data.recap_text ?? null;

  return (
    <div className={`detail${wide && isIssue ? ' detail--sidebar' : ''}`}>
      <div className="detail-head">
        <div className="title-block">
          <div className="detail-title-row">
            {idle ? <span className="kcard-idle-dot" title="chat idle — needs your input" /> : null}
            {isIssue
              ? <EditableTitle id={data.id} title={data.title || data.id} onSaved={refresh} autoFocus={focusTitle} />
              : <h2>{data.title || data.id}</h2>}
          </div>
          {/* Issue properties now live in the strip below (IssueProperties), so
              the sub-line is only the live tag (when a local worktree is live)
              for an issue, and the branch/created summary for a live-branch. */}
          {isIssue ? (
            data.live ? <div className="detail-sub"><span className="pill live-tag">● live</span></div> : null
          ) : (
            <div className="detail-sub">
              {data.live ? <span className="pill live-tag">● live</span> : null}
              {!data.live ? <span className={`pill bucket-${status}`}>{status}</span> : null}
              <span className="itag" style={{ marginLeft: 8 }}>branch</span>
              {data.created ? <span className="dim" style={{ marginLeft: 8 }}>created {fmtDate(data.created)}</span> : null}
            </div>
          )}
        </div>
        {/* On delete, park the board cursor where the deleted card WAS: the card
            below it slides up into that slot (nextId), or if it was last, the one
            above (prevId). Set before navigating so the board's auto-park keeps it
            instead of jumping to the top of In Progress. */}
        {isIssue ? <DeleteIssue id={data.id}
          onDeleted={() => { setSelection(nextId ?? prevId ?? null); navigate('/'); }} /> : null}
      </div>

      <div className="issue-fields">
        {isIssue ? (
          <IssueProperties key={data.id} data={data} known={known} local={local} allTags={allTags}
            column={wide} refresh={refresh} />
        ) : (
          <div className="props-strip">
            {(data.branches?.length ? data.branches : [data.branch]).filter(Boolean).length ? (
              <PropCell label="branch" width={200}><PillValue values={(data.branches?.length ? data.branches : [data.branch]).filter(Boolean)} /></PropCell>
            ) : null}
            {data.commits?.length ? <PropCell label="commits" width={200}><PillValue values={data.commits.map(c => String(c).slice(0, 9))} /></PropCell> : null}
            {data.sessions?.length ? <PropCell label="sessions" width={200}><PillValue values={data.sessions} /></PropCell> : null}
          </div>
        )}
        {data.conversations?.length ? (
          <div className="field-row">
            <span className="k">convos</span>
            <span className="v">{data.conversations.map(c => (
              <ConvoPill key={c} id={data.id} convo={c} conversations={data.conversations}
                onChanged={refresh} onOpen={() => requestChat?.(data.id, c)} />
            ))}</span>
          </div>
        ) : null}
        {data.live_pid ? (
          <div className="field-row"><span className="k">live pid</span><span className="v"><span className="field-pill">{data.live_pid}</span></span></div>
        ) : null}
      </div>

      {isIssue ? (
        <BodyEditor id={data.id} body={body} onSaved={refresh} />
      ) : body ? (
        <div className="recap-body"><Markdown text={body} /></div>
      ) : (
        <div className="empty">no recap for this branch yet</div>
      )}
    </div>
  );
}
