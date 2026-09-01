import React, { Fragment, useCallback, useEffect, useLayoutEffect, useState, useRef, useMemo } from 'react';
import { Link, useParams, useNavigate, useLocation } from 'react-router-dom';
import { useIssues, useFetch, fmtDate } from '../api.js';
import { changeDetail, listChanges, renameChange, updateChangeField, setChangeStatus, setChangeDep, deleteChange } from '../board-store.js';
import { COLUMNS, DEFAULT_STATUS } from '../board-columns.mjs';
import { useLocalBackend } from '../capabilities.js';
import { useSelection, useIssueNav, isDetailRoute } from '../selection.jsx';
import { useActivity, issueActivity, dismissIssueIdle } from '../activity-store.js';
import { useHotkey, matchesCombo } from '../hotkeys.js';
import { hk, hkCaps } from '../hotkey-registry.js';
import { Markdown, toggleTask } from './Markdown.jsx';
import { CopyButton } from './CopyButton.jsx';
import { normalizeBody } from '../mdx-body.js';
import { X, Pencil, Trash, User, ArrowUpRight } from '../icons.jsx';
import { Avatar, PersonLabel, usePeople, useDismiss, normalizeEmail } from '../profiles.jsx';
import { OptionMenu } from '../OptionMenu.jsx';
import { useAnchoredPopover } from '../popover.js';
import { tagPillClass } from '../tag-style.js';
import {
  MDXEditor, headingsPlugin, listsPlugin, quotePlugin, thematicBreakPlugin,
  linkPlugin, linkDialogPlugin, imagePlugin, tablePlugin, codeBlockPlugin,
  codeMirrorPlugin, markdownShortcutPlugin, toolbarPlugin,
  UndoRedo, BoldItalicUnderlineToggles, BlockTypeSelect, ListsToggle,
  CreateLink, InsertCodeBlock,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';
import { getTheme, onThemeChange } from '../theme.js';

// Inline-editable issue title. Looks like the static <h2> (CSS .title-edit),
// gaining a box outline only on hover / focus. Enter or blur saves via
// renameChange (Supabase, works remotely too); Escape reverts. On a failed
// write we restore the prior title rather than leave a phantom edit on screen.
function EditableTitle({ id, title, autoFocus }) {
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
  // Grow the textarea to fit its content (no scrollbar, no fixed rows). The
  // field is border-box, so the height we set has to carry the borders that
  // scrollHeight doesn't count — otherwise the last line loses 2px off the
  // bottom, which is invisible on one line and a shaved descender on two.
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + border}px`;
  };
  // Resync if server truth changes under us (background refresh / another tab),
  // and re-fit on every value change (typing, resync, mount).
  useEffect(() => { setVal(title); }, [title]);
  useEffect(() => { fit(); }, [val]);
  // The text also re-wraps when the COLUMN narrows — a dock opening beside it, a
  // window drag, the properties strip becoming a sidebar — and none of those
  // change `val`, so the box kept its old height and `overflow: hidden` ate the
  // new line. Width is the only thing that can re-wrap it; the height changes
  // coming back through here are our own, and acting on those would loop.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let lastW = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === lastW) return;
      lastW = el.clientWidth;
      fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const save = async () => {
    const next = val.trim();
    if (!next || next === title) { setVal(title); return; }
    try {
      const r = await renameChange(id, next);
      if (r && r.error) throw new Error(r.error);
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
// wrapper owns the click that opens the editor). When the chip carries a `to`,
// it also gets a hover-reveal external-link glyph (the .field-pill--reveal
// pattern) that navigates straight to that target — the ONLY navigation out of a
// chip; the body-click opens the editor instead. `stopPropagation` keeps the
// glyph's click from also toggling the menu. Long labels (issue titles) truncate.
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

// A run of value pills that wraps to at most `lines` rows; whatever doesn't fit
// collapses into a trailing "+N". Each pill self-truncates at 140px, and wrapped
// rows carry a vertical gap. How many pills fit is MEASURED off a hidden twin
// that lays out the full set at the run's real width — so the visible count is a
// pure function of width, with no flicker loop (the twin never changes with the
// decision it drives). This is the ONE truncation rule behind every property
// value — tags, requires, unlocks, branch, sessions — so they all read the same.
//
//   items: [{ key, node, text, pillClass? }]  node = the real (interactive) pill;
//          text/pillClass size the twin and fill the "+N" tooltip. The run keys
//          each node off item.key itself, so callers hand over a bare pill.
//   lines: the row budget — 1 in the collapsed strip, 3 in the sidebar column.
function PillRun({ items, lines }) {
  const ref = useRef(null);
  // shown = how many pills render; budget = the width the run wraps within, only
  // PINNED onto the run when it actually truncates (a cell with a short value
  // still sizes to its content — the cap only bites when the value overflows).
  const [fit, setFit] = useState({ shown: items.length, budget: 0 });
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    const twin = host.querySelector('.pill-run-measure');
    const measure = () => {
      // The wrap width: in the sidebar column the value fills a fixed track, so
      // its own box is the budget; in the collapsed strip a cell is content-sized
      // (no definite width to wrap against), so use its max-width cap instead.
      const cell = host.closest('.prop-cell');
      const inColumn = !!host.closest('.props-strip--column');
      const cap = cell ? parseFloat(getComputedStyle(cell).maxWidth) : NaN;
      const budget = inColumn || !Number.isFinite(cap)
        ? host.parentElement.clientWidth
        : cap;
      twin.style.width = `${budget}px`;
      const kids = [...twin.children];
      if (!kids.length) { setFit({ shown: 0, budget }); return; }
      const tops = [];
      for (const k of kids) { const t = k.offsetTop; if (!tops.includes(t)) tops.push(t); }
      const lastTop = tops[Math.min(lines, tops.length) - 1];
      const inBudget = kids.filter(k => k.offsetTop <= lastTop + 1);
      if (inBudget.length === kids.length) { setFit({ shown: kids.length, budget }); return; }
      // Overflow: reserve room for the "+N" on the last budgeted row, popping
      // trailing pills off that row until the badge fits.
      const right = twin.getBoundingClientRect().right;
      const RESERVE = 42;
      const lastRow = inBudget.filter(k => k.offsetTop === lastTop);
      let keep = inBudget.length, i = lastRow.length - 1;
      while (i >= 0 && right - lastRow[i].getBoundingClientRect().right < RESERVE) { keep--; i--; }
      setFit({ shown: Math.max(keep, 1), budget });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host.parentElement);
    return () => ro.disconnect();
  }, [items, lines]);

  const more = items.length - fit.shown;
  return (
    <span className="pill-run" ref={ref}
      style={more > 0 && fit.budget ? { width: fit.budget } : undefined}>
      {items.slice(0, fit.shown).map(it => <Fragment key={it.key}>{it.node}</Fragment>)}
      {more > 0 ? (
        <span className="field-pill chip-overflow" title={items.slice(fit.shown).map(it => it.text).join('\n')}>+{more}</span>
      ) : null}
      {/* The measuring twin: plain ghosts (NO semantic pill classes — those would
          double-count in queries and leak dangling/tag styling), so the ghost's
          only styling is the shared 140px cap that governs a pill's width. */}
      <span className="pill-run-measure" aria-hidden="true">
        {items.map(it => (
          <span key={it.key} className="field-pill pill-run-ghost">{it.text}</span>
        ))}
      </span>
    </span>
  );
}

// The shared chip-multiselect shell — one control behind tags, requires AND
// unlocks. The value ITSELF is the trigger: the chips (or an "Empty" placeholder)
// are clickable and open the editor. The dropdown IS the shared OptionMenu (the
// same popover the board filters use): a search/create header, then the whole
// vocabulary as a checklist with the SELECTED members floated to the top — so you
// see the whole set and add/remove by clicking. When `onCreate` is supplied
// (free-text tags) a "Create <query>" row appears for a query that matches
// nothing. The three axes tags and deps differ on are all props: the chip
// `label`/`className`/`to` (tag string vs issue title-via-`known`, with a dangling
// fallback and an external-link out), the add-vocabulary `options`, and the
// `onToggle`/`onCreate` mutations (updateChangeField vs setChangeDep, which
// maintains the inverse edge).
//
//   selected: [{ key, label, className?, to? }]  the chips currently on
//   options:  [{ key, label }]                   the add-vocabulary (selected filtered out)
//   onToggle(key)   flip membership       onCreate(query)?  add a brand-new member
function ChipMultiSelect({ selected, options, onToggle, onCreate, triggerTitle, emptyLabel = 'nothing set', searchPlaceholder = 'Search…', emptyHint, lines = 1 }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const inputRef = useRef(null);
  const close = () => { setOpen(false); setQ(''); };
  const wrapRef = useDismiss(open, close);
  useHotkey('Escape', close, { enabled: open, terminal: 'handle', allowInInput: true });
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

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
      {/* role=button (not <button>) so dep chips can legally nest their reveal
          <Link>. Enter/Space open; the whole value is one click target. */}
      <div className="chip-trigger" role="button" tabIndex={0} title={triggerTitle}
        aria-haspopup="listbox" aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        // Only the trigger's OWN Enter/Space opens the menu — a keydown that
        // bubbled up from a chip's focused reveal <Link> must be left alone so
        // keyboard Enter follows the link instead of toggling the menu.
        onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); setOpen(o => !o); } }}>
        {selected.length ? (
          <PillRun lines={lines} items={selected.map(({ key, ...chip }) => ({
            key, text: chip.label, pillClass: chip.className,
            node: <Chip {...chip} />,
          }))} />
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
// vocabulary, create-on-miss, no external link. The mutation is updateChangeField.
function TagSelect({ id, tags, allTags, lines }) {
  const toggle = (t) => {
    const tag = t.trim();
    if (!tag) return;
    updateChangeField(id, 'tags', tags.includes(tag) ? tags.filter(x => x !== tag) : [...tags, tag]);
  };
  const selected = tags.map(t => ({ key: t, label: t, className: tagPillClass(t) }));
  const options = (allTags || []).map(t => ({ key: t, label: t }));
  return (
    <ChipMultiSelect selected={selected} options={options} onToggle={toggle} onCreate={toggle}
      triggerTitle="Edit tags" searchPlaceholder="Search or create…"
      emptyHint="no tags yet" lines={lines} />
  );
}

// Requires/unlocks configured on the shared shell: chips read as issue TITLES
// (from `known`, with the id as a dangling fallback), each with an external-link
// out; the add-vocabulary is every other issue by title (no free-text create).
// The mutation is setChangeDep, which maintains the INVERSE edge on the other
// issue's row — dropping a `requires` drops the matching `unlocks` there.
function DepSelect({ id, field, list, known, lines }) {
  const toggle = (dep) => {
    if (!dep || dep === id) return;
    const has = list.includes(dep);
    setChangeDep(id, field, dep, !has, has ? list.filter(d => d !== dep) : [...list, dep]);
  };
  const selected = list.map(dep => {
    const meta = known.get(dep);
    return {
      key: dep,
      label: meta ? (meta.title || dep) : dep,
      className: meta ? 'deps-chip' : 'deps-chip deps-chip--dangling',
      to: `/issues/${encodeURIComponent(dep)}`,
    };
  });
  const options = [...known.values()]
    .filter(r => r.id !== id)
    .map(r => ({ key: r.id, label: r.title || r.id }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return (
    <ChipMultiSelect selected={selected} options={options} onToggle={toggle}
      triggerTitle={`Edit ${field}`} searchPlaceholder="Search issues…"
      emptyHint="no other issues" lines={lines} />
  );
}

// Clickable status pill: looks like the static bucket pill but opens a menu of
// the six columns. Picking one writes the issue's status directly (setStatus —
// no column reorder, the card just changes lanes) and refreshes. This is the
// detail-view twin of dragging a card between columns on the board. Click-
// outside or Escape closes; the current status is marked and disabled.
function StatusPill({ id, status }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const { ref: menuRef, style: menuStyle } = useAnchoredPopover(open);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);
  // Escape closes the menu — capture phase, so it wins over the detail view's
  // bubble-phase "Escape → back to board" without also navigating.
  useHotkey('Escape', () => setOpen(false), { enabled: open, terminal: 'handle', allowInInput: true });

  // Menu closes at pick time; the write-through mutation paints the new status
  // in the same breath and confirms (or rolls back) behind it.
  const pick = (next) => {
    setOpen(false);
    if (next !== status) setChangeStatus(id, next);
  };

  return (
    <span className="status-menu-wrap" ref={wrapRef}>
      <button type="button" className={`pill bucket bucket-${status} status-trigger`}
        aria-haspopup="listbox" aria-expanded={open}
        title="Change status" onClick={() => setOpen(o => !o)}>
        {status}
      </button>
      {open ? (
        <ul className="status-menu" role="listbox" ref={menuRef} style={menuStyle}>
          {COLUMNS.map(b => (
            <li key={b.key} className={`status-item${b.key === status ? ' is-current' : ''}`}>
              <button type="button" className={`status-pick pill bucket bucket-${b.key}`}
                role="option" aria-selected={b.key === status}
                disabled={b.key === status} onClick={() => pick(b.key)}>
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
// clicking it swaps to a WYSIWYG markdown editor (MDXEditor — headings, lists,
// code blocks format as you type; the markdown string stays the source of
// truth). ⌘/Ctrl+Enter or Save commits via updateChangeField (a write-through
// mutation — every view repaints off the bus, so no onSaved callback); Escape
// or Cancel reverts. The empty state is itself the entry point — click "add a
// description" to start.
// The description. There is ONE thing you can do to it — write in it — so there
// is no save and no cancel: it writes itself once you pause, and leaving the
// editor writes whatever is left. What remains are two RENDERINGS of the same
// text, not two commit modes: the reading view does things the editor cannot
// (receipt gifs open to full size, task boxes tick), so it stays.
const AUTOSAVE_MS = 700;

function BodyEditor({ id, body }) {
  const [editing, setEditing] = useState(false);
  const [theme, setTheme] = useState(getTheme());
  // The editor is uncontrolled: markdown={} is the initial value only, and the
  // live string lives in a ref. Feeding onChange back into markdown={} would
  // reset the editor (and the caret) on every keystroke.
  const cur = useRef(body || '');
  // What the row already holds, so a pause that changed nothing writes nothing
  // and an issue's `updated` stamp still means someone edited it.
  const saved = useRef(body || '');
  const timer = useRef(null);
  const box = useRef(null);
  useEffect(() => onThemeChange(setTheme), []);
  // While not editing, follow the row — another window's edit, or our own write
  // coming back through the store.
  useEffect(() => { if (!editing) { cur.current = body || ''; saved.current = body || ''; } }, [body, editing]);

  // One writer, whatever prompted it — a pause in typing, leaving the editor, or
  // this pane unmounting under you.
  //
  // MDXEditor serializes a trailing space in the last paragraph as the hex entity
  // `&#x20;` (Lexical's way of preserving whitespace markdown would otherwise
  // strip). A description never wants trailing whitespace, so normalize the tail.
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const next = normalizeBody(cur.current);
    if (next === saved.current) return;
    saved.current = next;
    updateChangeField(id, 'body', next);
  }, [id]);

  // Navigating away mid-sentence must not lose it — the unmount is the last
  // chance to write, and it is exactly the case a debounce would drop.
  useEffect(() => () => flush(), [flush]);

  // Clicking anywhere outside the editor ends the edit. This is what replaced
  // Save/Cancel: the text is already written, so leaving is the whole gesture.
  useEffect(() => {
    if (!editing) return;
    const onDoc = (e) => {
      if (box.current && !box.current.contains(e.target)) { flush(); setEditing(false); }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [editing, flush]);

  const open = () => { cur.current = body || ''; saved.current = body || ''; setEditing(true); };

  if (editing) {
    return (
      <div
        ref={box}
        className="recap-body recap-body--editing"
        // ⌘↵ and Esc both mean "done" now that there is nothing to commit or
        // abandon — component-owned keys, kept local (not a global hotkey) so
        // they never fire from the title/tag inputs, and MDXEditor's inner
        // dialogs (link popup) take Escape first. The combo is SOURCED from the
        // registry (matchesCombo) like every other shortcut, so it can't drift.
        onKeyDown={e => {
          if (matchesCombo(e, hk('bodyDone'))) { e.preventDefault(); flush(); setEditing(false); }
        }}
      >
        <MDXEditor
          className={`body-mdx ${theme === 'dark' ? 'dark-theme' : ''}`}
          markdown={body || ''}
          autoFocus
          placeholder="Write a description… (markdown)"
          onChange={v => {
            cur.current = v;
            clearTimeout(timer.current);
            timer.current = setTimeout(flush, AUTOSAVE_MS);
          }}
          plugins={[
            headingsPlugin(), listsPlugin(), quotePlugin(), thematicBreakPlugin(),
            linkPlugin(), linkDialogPlugin(), imagePlugin(), tablePlugin(),
            codeBlockPlugin({ defaultCodeBlockLanguage: '' }),
            codeMirrorPlugin({ codeBlockLanguages: { js: 'JavaScript', jsx: 'JSX', ts: 'TypeScript', css: 'CSS', html: 'HTML', bash: 'Bash', sh: 'Shell', json: 'JSON', md: 'Markdown', '': 'Plain' } }),
            markdownShortcutPlugin(),
            toolbarPlugin({
              toolbarContents: () => (<>
                <UndoRedo />
                <BoldItalicUnderlineToggles />
                <BlockTypeSelect />
                <ListsToggle />
                <CreateLink />
                <InsertCodeBlock />
              </>),
            }),
          ]}
        />
      </div>
    );
  }

  if (!body) {
    return (
      <button type="button" className="empty body-empty-add" onClick={open}>
        <Pencil size={12} /> add a description
      </button>
    );
  }

  return (
    <div className="recap-body recap-body--editable">
      <button type="button" className="body-edit-btn" title="Edit description"
        aria-label="Edit description" onClick={open}><Pencil size={13} /></button>
      <Markdown text={body} onToggleTask={async (idx, checked) => {
        const next = toggleTask(body, idx, checked);
        if (next !== body) await updateChangeField(id, 'body', next);
      }} />
    </div>
  );
}

// Destructive delete for the whole issue, top-right of the detail head. Double
// opt-in (the issue body's requirement): a resting trash icon, first click
// reveals a "delete / cancel" confirm, only the second click drops the Supabase
// row — and leaves the now-dead detail route in the SAME breath (the mutation
// nulls this detail's cache synchronously, so lingering here would flash "not
// found" until the write round-trips). Write-through owns the rest: failure
// rolls back and the card visibly returns to the board. A two-step confirm,
// escalated to red because this can't be undone.
function DeleteIssue({ id, onDeleted }) {
  const [confirming, setConfirming] = useState(false);
  const del = () => {
    deleteChange(id);
    onDeleted?.();
  };
  if (confirming) {
    return (
      <span className="issue-delete-confirm">
        <button type="button" className="issue-delete-yes"
          title="Permanently delete this issue" onClick={del}>delete</button>
        <button type="button" className="issue-delete-no"
          title="Cancel" onClick={() => setConfirming(false)}>cancel</button>
      </span>
    );
  }
  return (
    <button type="button" className="icon-btn issue-delete-btn" title="Delete this issue"
      aria-label="Delete this issue" onClick={() => setConfirming(true)}><Trash size={15} /></button>
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
  useHotkey('Escape', () => setPicking(false), { enabled: picking, terminal: 'handle', allowInInput: true });

  const assign = (email) => {
    setPicking(false);
    if (email !== (owner || null)) updateChangeField(id, 'owner', email);
  };
  const key = normalizeEmail(owner);
  // The avatar is nameless on its face, so the tooltip/label must carry WHO —
  // otherwise a hover reads "Change owner" and the assignee's name is lost (it
  // used to sit in the row). Resolve from the roster; fall back to the email.
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

// Read-only value pills (branch names, session ids: derived worktree/chat
// metadata, not user-set). Same PillRun truncation as the editable chips — a line
// budget, each pill self-truncating — so every property value reads the same.
// Empty reads a dashed slot.
function PillValue({ values, lines }) {
  if (!values.length) return <EmptySlot label="nothing set" />;
  return (
    <PillRun lines={lines} items={values.map(v => ({
      key: v, text: v, node: <span className="field-pill" title={v}><span className="pill-text">{v}</span></span>,
    }))} />
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
// What has actually landed on this issue's branch. Read through the branch
// recorded on the row — never re-derived from the issue id, which is exactly the
// assumption readable branch names invalidate.
//
// The states are deliberately distinct. "No branch yet", "that branch isn't on
// this computer" and "the branch exists with nothing past main" are three
// different facts, and reporting all of them as an empty list would present
// unseen work as no work.
function IssueCommits({ id, lines }) {
  // No polling: commits change when the branch is committed to, which the card
  // has no way to observe anyway — one read per open, not a timer per card.
  const { data } = useFetch(`/api/dash/terminal/commits?issue=${encodeURIComponent(id)}`, { pollMs: 0 });
  if (!data) return <span className="field-word-empty">…</span>;
  if (data.state === 'no-branch') return <span className="field-word-empty">no branch yet</span>;
  if (data.state === 'branch-absent') return <span className="field-word-empty" title={`branch "${data.branch}" isn't on this computer`}>not on this computer</span>;
  if (data.state === 'no-commits') return <span className="field-word-empty">nothing past main</span>;
  // Same PillRun truncation as every other property value — a line budget, each
  // pill capped — so commits can't spill past the cell / the sidebar box either.
  return (
    <PillRun lines={lines} items={data.commits.map(c => ({
      key: c.sha, text: c.short,
      node: <span className="field-pill" title={`${c.short} — ${c.subject}`}><span className="pill-text">{c.short}</span></span>,
    }))} />
  );
}

function IssueProperties({ data, known, local, allTags, column }) {
  const [open, setOpen] = useState(false);
  const [rowH, setRowH] = useState(0);
  const [fit, setFit] = useState(0);
  const stripRef = useRef(null);
  const id = data.id;
  const status = data.status || DEFAULT_STATUS;
  const requires = data.requires || [];
  const unlocks = data.unlocks || [];
  const branches = (data.branches?.length ? data.branches : [data.branch]).filter(Boolean);
  const sessions = data.sessions || [];

  // Pills wrap to ONE line in the collapsed strip (the strip only shows its first
  // row of cells anyway), THREE lines in the sidebar column (it has the height).
  const lines = column ? 3 : 1;

  const pinned = [
    { key: 'status', label: 'status', value: <StatusPill id={id} status={status} /> },
    { key: 'owner', label: 'owner', value: <OwnerAvatar id={id} owner={data.owner} /> },
    { key: 'tags', label: 'tags', width: 190, value: <TagSelect id={id} tags={data.tags || []} allTags={allTags} lines={lines} /> },
  ];
  // Dependencies are cells like any other property — an empty one reads "Empty"
  // and is still the editor's trigger, which is how a first edge gets added.
  const rest = [
    { key: 'requires', label: 'requires', width: 210, has: requires.length > 0, attrs: { 'data-dep-field': 'requires' }, value: <DepSelect id={id} field="requires" list={requires} known={known} lines={lines} /> },
    { key: 'unlocks', label: 'unlocks', width: 210, has: unlocks.length > 0, attrs: { 'data-dep-field': 'unlocks' }, value: <DepSelect id={id} field="unlocks" list={unlocks} known={known} lines={lines} /> },
  ];
  // branch/sessions are read-only worktree/chat metadata. When empty they only
  // exist on a LOCAL backend — remotely they are structurally always empty, so
  // listing them there would be permanent noise. `local !== false` keeps them in
  // while the probe is still deciding (null).
  if (branches.length || local !== false) rest.push({ key: 'branch', label: 'branch', width: 200, has: branches.length > 0, value: <PillValue values={branches} lines={lines} /> });
  if (sessions.length || local !== false) rest.push({ key: 'sessions', label: 'sessions', width: 200, has: sessions.length > 0, value: <PillValue values={sessions} lines={lines} /> });
  // Commits are DERIVED from the branch recorded on the row, not stored — so
  // they can't drift and nobody has to remember to append a SHA. Fetched only
  // here, for the one open card: doing this per card on the board would be a git
  // call per card, which is the repository scan that used to freeze the dash.
  if (local !== false) rest.push({ key: 'commits', label: 'commits', width: 230, has: false, value: <IssueCommits id={id} lines={lines} /> });

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

// The properties column is a FIXED 200 with 32 of air beside it; the body keeps
// its 560px reading measure when there's room and gives way down to 360 when
// there isn't. So the column appears as soon as the pane can hold the narrow
// body plus the column — not only once the body is at full width — and the two
// together stay centred in the pane.
//
// These four numbers are the ONE definition of the detail's geometry. The
// threshold is computed here and the same values are handed to CSS as custom
// properties on .detail (DETAIL_GEOMETRY below), so the stylesheet can never
// drift from the measurement that decides which layout it is styling — and a
// test reads the live values off the element instead of restating them.
const BODY_MIN = 360, BODY_MAX = 560, PROPS_W = 200, PROPS_GAP = 32;
const SIDEBAR_MIN = BODY_MIN + PROPS_GAP + PROPS_W;
const DETAIL_GEOMETRY = {
  '--detail-body-min': `${BODY_MIN}px`,
  '--detail-body-max': `${BODY_MAX}px`,
  '--detail-props-w': `${PROPS_W}px`,
  '--detail-props-gap': `${PROPS_GAP}px`,
};

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
  const activity = useActivity();
  // Latest-value ref so the route-level chord handler (registered once) can
  // dismiss the CURRENT idle episode without re-subscribing on every activity
  // tick. Assigned below once `idle`/`data` are known; null until then.
  const dismissIdleRef = useRef(null);
  // Read the issue straight from Supabase (board-store) so detail works
  // remotely. useIssues refetches on every issues-change signal — including the
  // writes THIS view makes (rename, status, tags, body, convo unlink), which is
  // why the widgets below carry no refresh callbacks: they write, the bus
  // repaints every mounted view, board included.
  const { data, err, loading } = useIssues(`change:${id}`, () => changeDetail(id));
  // Known issues for the deps panel: id→row, powering the requires/unlocks chip
  // tooltips, typeahead options, and dangling detection. Shares the board's
  // 'changes' cache key — warm if the board's been visited, one cheap list fetch
  // (no bodies) otherwise.
  const { data: allIssues } = useIssues('changes', listChanges);
  const known = useMemo(() => new Map((allIssues || []).map(r => [r.id, r])), [allIssues]);
  // Every tag in use across the board — the tag multiselect's option list (issue
  // tags are free text, so this is a convenience set, not a closed vocabulary).
  const allTags = useMemo(() => [...new Set((allIssues || []).flatMap(r => r.tags || []))].sort(), [allIssues]);

  // Record which card we came in on, so ⌘← / Esc returns the board cursor here
  // (and prev/next nav below drags the board cursor along with it).
  useEffect(() => { setSelection(id); }, [id, setSelection]);
  // Prev/next nav on the board's published rail — the same `go` the breadcrumb
  // chevrons use (main.jsx), so both surfaces share one navigation semantics.
  const { prevId, nextId, go } = useIssueNav(id);
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
  // Nav chords belong to the ROUTE, not the focused pane. As modifier chords they
  // fire even while the chat terminal owns focus (the shared primitive's chord-
  // transparency), yet real text fields — the inline title/body editors — keep
  // every key. ⌘← (not bare ←, which collides with text-cursor / nav) → board;
  // ⌘↑/⌘↓ walk the board's visible order without leaving the detail (clamped at
  // the ends by `go`); ⌘Esc dismisses this issue's needs-input dot.
  // `isDetailRoute` is the event-time twin of the board's `isBoardRoute` gate:
  // after ⌘← navigates to the board, this detail stays mounted for a frame (its
  // listeners still attached), so without the route check a fast ⌘↓ would fire a
  // stale `go()` — re-navigating into an issue from the board. The board and
  // detail scopes are thus mutually exclusive at keydown, not a render behind.
  // ⌘↑/↓ check the route INSIDE the handler rather than via `when`, so they still
  // CONSUME the key in that hand-off frame (returning undefined → preventDefault)
  // instead of letting it native-scroll — the mirror of the board's reorder gate.
  useHotkey(hk('detailBack', 'arrow'), () => navigate('/issues'), { terminal: 'handle', when: isDetailRoute });
  useHotkey(hk('issuePrev'), () => { if (isDetailRoute()) go('up'); }, { terminal: 'handle' });
  useHotkey(hk('issueNext'), () => { if (isDetailRoute()) go('down'); }, { terminal: 'handle' });
  useHotkey(hk('detailDismissFlag'), () => dismissIdleRef.current?.(), { terminal: 'handle', when: isDetailRoute });
  // ⌘S copies the open issue's id — handled by the breadcrumb (CrumbCopy), so the
  // keystroke and a click on the crumb share ONE copy affordance and the same
  // "copied ✓" feedback, rather than a separate title flash.
  // Bare Esc → back to the board. Bubble phase (capture:false) so an open overlay
  // (status menu, lightbox) that stops Escape in capture wins first; it yields to
  // the terminal (default) so a focused terminal keeps Esc for the PTY.
  useHotkey(hk('detailBack', 'esc'), () => navigate('/issues'), { capture: false, when: isDetailRoute });

  if (loading && !data) return <div className="spin">loading…</div>;
  if (err) return <div className="error">{err}</div>;
  if (!data) return <div className="error">not found</div>;

  const isIssue = data.kind === 'issue';
  const status = data.status || DEFAULT_STATUS;
  // Same idle-chat marker as the board card, with the same gate: only an
  // in-progress issue's idle chat flags. Off that column, no flag.
  const idle = status === 'in-progress' && issueActivity(activity, data) === 'idle';
  // Keep the ⌘Esc handler pointed at the current idle state.
  dismissIdleRef.current = () => { if (idle) dismissIssueIdle(activity, data); };
  const body = data.body ?? data.recap_text ?? null;

  return (
    <div className={`detail${wide && isIssue ? ' detail--sidebar' : ''}`} style={DETAIL_GEOMETRY}>
      <div className="detail-head">
        <div className="title-block">
          <div className="detail-title-row">
            {idle ? (
              <button type="button" className="kcard-idle-dot detail-idle-dismiss"
                title={`chat idle — needs your input · click or ${hkCaps('detailDismissFlag')} to dismiss (also dismisses the selected card on the board)`}
                aria-label="Dismiss needs-input indicator"
                onClick={() => dismissIssueIdle(activity, data)}>
                <span className="idle-dot-fill"><X size={11} /></span>
              </button>
            ) : null}
            {isIssue
              ? <EditableTitle id={data.id} title={data.title || data.id} autoFocus={focusTitle} />
              : <h2>{data.title || data.id}</h2>}
          </div>
          {isIssue ? null : (
            <div className="detail-sub">
              <span className={`pill bucket bucket-${status}`}>{status}</span>
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
          onDeleted={() => { setSelection(nextId ?? prevId ?? null); navigate('/issues'); }} /> : null}
      </div>

      <div className="issue-fields">
        {isIssue ? (
          <IssueProperties key={data.id} data={data} known={known} local={local} allTags={allTags}
            column={wide} />
        ) : (
          <div className="props-strip">
            {(data.branches?.length ? data.branches : [data.branch]).filter(Boolean).length ? (
              <PropCell label="branch" width={200}><PillValue lines={1} values={(data.branches?.length ? data.branches : [data.branch]).filter(Boolean)} /></PropCell>
            ) : null}
            {data.sessions?.length ? <PropCell label="sessions" width={200}><PillValue lines={1} values={data.sessions} /></PropCell> : null}
          </div>
        )}
      </div>

      {isIssue ? (
        <BodyEditor id={data.id} body={body} />
      ) : body ? (
        <div className="recap-body"><Markdown text={body} /></div>
      ) : (
        <div className="empty">no recap for this branch yet</div>
      )}
    </div>
  );
}
