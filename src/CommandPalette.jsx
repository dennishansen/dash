import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useHotkey } from './hotkeys.js';
import { useIssues } from './api.js';
import { listChanges, listBodies } from './board-store.js';
import { issueHaystack } from './issue-search.js';

// ⌘K global search for the dash — a centered modal over any route that jumps
// straight to an issue. It reuses rather than reinvents: the SAME 'changes'
// cache the board paints (no second fetch), the SAME id/title/tag matcher the
// board's search box uses (issue-search.js), the SAME status pills the board
// and detail view use (.pill.bucket-*), and the ONE hotkey primitive so ⌘K
// fires even over the chat terminal (terminal:'handle').
//
// It adds one thing the board can't: it also searches DESCRIPTION text. The
// board omits body from its list fetch (LIST_COLS) to stay lean, so the palette
// lazily fetches id+body once opened ('issue-bodies') and matches it on top of
// the shared matcher — description-search is a palette layer, not a board change.
// A body hit shows a snippet under the title; matched text is bolded everywhere.
//
// Keyboard model, split by scope:
//   • ⌘K is the one GLOBAL command → useHotkey (capture, terminal:'handle', and
//     allowInInput so it toggles closed while the palette's own input is focused).
//   • Everything WHILE OPEN — ↑/↓ move the highlight, Enter opens, Esc closes,
//     Tab is trapped — is palette-internal, a bubble-phase local onKeyDown on the
//     focused input (the accessible combobox / aria-activedescendant pattern), so
//     the board's own capture-phase ↑/↓/Enter yield to the focused field and Esc
//     wins over the detail view's Esc-to-board.

const STATUS_LABEL = {
  maybe: 'Maybe', future: 'Future', next: 'Next',
  'in-progress': 'In Progress', done: 'Done', rejected: 'Rejected',
};

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.6 10.6 14 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

// Split `text` into React nodes with each case-insensitive occurrence of `q`
// wrapped in <mark> for bolding. Returns the raw string when there's nothing to
// mark, so unmatched text stays a plain text node.
function highlight(text, q) {
  if (!q || !text) return text;
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const out = [];
  let i = 0, key = 0;
  for (;;) {
    const idx = lower.indexOf(ql, i);
    if (idx < 0) { out.push(text.slice(i)); break; }
    if (idx > i) out.push(text.slice(i, idx));
    out.push(<mark key={key++} className="cmdk-hit">{text.slice(idx, idx + ql.length)}</mark>);
    i = idx + ql.length;
  }
  return out;
}

// A one-line window of `body` around the match at `idx`, whitespace collapsed,
// ellipsed on each cut edge. highlight() re-finds the term in the cleaned
// snippet, so the collapse shifting positions doesn't matter.
function snippetAround(body, idx, len) {
  const start = Math.max(0, idx - 32);
  const end = Math.min(body.length, idx + len + 56);
  let s = body.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) s = '… ' + s;
  if (end < body.length) s = s + ' …';
  return s;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const restoreRef = useRef(null); // element focus returns to on close

  const close = useCallback(() => {
    setOpen(false);
    const el = restoreRef.current;
    restoreRef.current = null;
    // Return focus to wherever it was (the terminal, a card, the body) — a beat
    // later so React has torn the portal down first.
    if (el && el.isConnected) requestAnimationFrame(() => el.focus?.());
  }, []);

  const openPalette = useCallback(() => {
    restoreRef.current = document.activeElement;
    setOpen(true);
  }, []);

  // The one global command. Capture-phase + terminal:'handle' so it beats the
  // chat PTY; allowInInput so a second ⌘K (input focused) toggles it closed.
  useHotkey('Mod+KeyK', () => { open ? close() : openPalette(); },
    { terminal: 'handle', allowInInput: true, repeat: false });

  // The pointer twin of ⌘K: the topbar search icon dispatches this so a click
  // reaches the same modal the chord opens (one palette, two affordances).
  useEffect(() => {
    const onOpen = () => { if (!open) openPalette(); };
    window.addEventListener('dash:open-palette', onOpen);
    return () => window.removeEventListener('dash:open-palette', onOpen);
  }, [open, openPalette]);

  // The modal (and its lazy 'issue-bodies' fetch) mounts only while open — so
  // app-load never pays for description data nobody searched. The issues-cache
  // keeps it warm across opens.
  if (!open) return null;
  return createPortal(<PaletteModal onClose={close} />, document.body);
}

function PaletteModal({ onClose }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // Shared 'changes' cache — the board mounts it at app start and Realtime keeps
  // it fresh, so this reads the exact rows on screen with no extra fetch.
  const { data } = useIssues('changes', listChanges, { pollMs: 0 });
  // Description text, fetched lazily (this modal only mounts once opened) and
  // kept fresh by the same issues-change bus useIssues rides.
  const { data: bodyRows } = useIssues('issue-bodies', listBodies, { pollMs: 0 });
  const bodies = useMemo(() => {
    const m = new Map();
    for (const r of bodyRows ?? []) m.set(r.id, r.body || '');
    return m;
  }, [bodyRows]);

  // Each result is { issue, snippet } — snippet is the description window when
  // the hit is in the body (null otherwise). Base match (id/title/tags) is the
  // shared matcher; body match is the palette's own layer on top.
  const results = useMemo(() => {
    const issues = (data ?? []).filter(i => i.kind === 'issue');
    const q = query.trim().toLowerCase();
    if (!q) return issues.map(i => ({ issue: i, snippet: null }));
    const out = [];
    for (const i of issues) {
      const base = issueHaystack(i).includes(q);
      const body = bodies.get(i.id) || '';
      const bi = body.toLowerCase().indexOf(q);
      if (base || bi >= 0) out.push({ issue: i, snippet: bi >= 0 ? snippetAround(body, bi, q.length) : null });
    }
    return out;
  }, [data, bodies, query]);

  // Keep the highlight in range if the list shrinks (typing, a Realtime removal,
  // or body matches arriving/leaving as the lazy fetch settles).
  useEffect(() => {
    setActive(a => Math.min(a, Math.max(0, results.length - 1)));
  }, [results.length]);

  // Focus the input as the modal mounts.
  useEffect(() => { requestAnimationFrame(() => inputRef.current?.focus()); }, []);

  // Keep the highlighted row visible as the cursor walks the list.
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const go = useCallback((id) => {
    onClose();
    navigate(`/changes/${encodeURIComponent(id)}`);
  }, [onClose, navigate]);

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault(); e.stopPropagation();
      setActive(a => (results.length ? (a + 1) % results.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      setActive(a => (results.length ? (a - 1 + results.length) % results.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      const r = results[active];
      if (r) go(r.issue.id);
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      onClose();
    } else if (e.key === 'Tab') {
      // Trap focus: the input is the only focusable control, so Tab must not
      // leave the modal for the page behind it.
      e.preventDefault();
    }
  };

  const q = query.trim();
  const activeId = results[active]?.issue.id;
  return (
    // Backdrop dismiss on mousedown (not click), so a text-selection drag that
    // starts in the input and releases outside can't close the palette.
    <div className="cmdk-backdrop" onMouseDown={onClose}>
      <div
        className="cmdk-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Search issues"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="cmdk-input-row">
          <SearchIcon />
          <input
            ref={inputRef}
            type="text"
            className="cmdk-input"
            value={query}
            onChange={e => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onKeyDown}
            placeholder="Search issues by id, title, or description…"
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-listbox"
            aria-activedescendant={activeId ? `cmdk-opt-${activeId}` : undefined}
            autoComplete="off"
            spellCheck="false"
          />
        </div>
        <div className="cmdk-results" id="cmdk-listbox" role="listbox" ref={listRef}>
          {results.length === 0 ? (
            <div className="cmdk-empty">No matching issues</div>
          ) : results.map(({ issue, snippet }, i) => (
            <div
              key={issue.id}
              id={`cmdk-opt-${issue.id}`}
              role="option"
              aria-selected={i === active}
              className={`cmdk-item${i === active ? ' is-active' : ''}`}
              onMouseMove={() => setActive(i)}
              // Keep focus on the input (aria-activedescendant model) — the click
              // still fires and navigates.
              onMouseDown={e => e.preventDefault()}
              onClick={() => go(issue.id)}
            >
              <div className="cmdk-item-main">
                <span className="cmdk-item-title">{highlight(issue.title || issue.id, q)}</span>
                {snippet ? <span className="cmdk-item-sub">{highlight(snippet, q)}</span> : null}
              </div>
              <span className={`pill bucket-${issue.status}`}>{STATUS_LABEL[issue.status] || issue.status}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
