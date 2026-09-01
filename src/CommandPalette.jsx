import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useHotkey, matchesCombo } from './hotkeys.js';
import { hk } from './hotkey-registry.js';
import { useIssues } from './api.js';
import { listChanges, listBodies } from './board-store.js';
import { issueHaystack } from './issue-search.js';
import { searchChats } from '../server/chat-mirror.mjs';
import { agentById } from './agents.js';
import { AgentBadge } from './AgentBadge.jsx';
import { useChatControl } from './chat-control.jsx';
import { statusLabel } from './board-columns.mjs';

// ⌘K global search for the dash — a centered modal over any route that jumps
// straight to an issue. It reuses rather than reinvents: the SAME 'changes'
// cache the board paints (no second fetch), the SAME id/title/tag matcher the
// board's search box uses (issue-search.js), the SAME status pills the board
// and detail view use (.pill.bucket-*), and the ONE hotkey primitive so ⌘K
// fires even over the chat terminal (terminal:'handle').
//
// It adds two things the board can't. First, DESCRIPTION text: the board omits
// body from its list fetch (LIST_COLS) to stay lean, so the palette lazily
// fetches id+body once opened ('issue-bodies') and matches it on top of the
// shared matcher. A body hit shows a snippet under the title.
//
// Second — and this is the point of chat sync — everyone's CHATS. The reasoning
// behind past work used to be locked to whichever laptop produced it; every
// chat now mirrors its spoken turns into shared storage, so this box searches
// the whole team's conversations alongside their issues. That half cannot be
// client-side (the corpus is far too large to ship to a browser), so it is a
// database query, debounced as you type. It matches by case-insensitive
// substring exactly as the issue half does — one box, one mental model, and a
// trigram index is what makes that affordable.
//
// Matched text is bolded everywhere.
//
// Keyboard model, split by scope:
//   • ⌘K OPENS the palette → useHotkey (capture, terminal:'handle', allowInInput
//     so it fires while a non-modal field like the board search owns focus). It
//     never has to close: once open the panel is an aria-modal, so the primitive
//     yields ⌘K to it (a modal owns the keyboard) — closing is a local key below.
//   • Everything WHILE OPEN — ↑/↓ move the highlight, Enter opens, Esc AND a
//     second ⌘K (sourced via matchesCombo) close, Tab is trapped — is
//     palette-internal, a bubble-phase local onKeyDown on the focused input (the
//     accessible combobox / aria-activedescendant pattern), so the board's own
//     capture-phase ↑/↓/Enter yield to the focused field and Esc wins over the
//     detail view's Esc-to-board.

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

  // The one global command — OPENS the palette. Capture-phase + terminal:'handle'
  // so it beats the chat PTY; allowInInput so it fires while a non-modal field
  // (the board search box) owns focus. It never has to CLOSE: once open, the
  // palette is an aria-modal, so the primitive yields ⌘K to it — closing is a
  // local key on the focused input below (the modal owns its own keys).
  useHotkey(hk('search'), () => { if (!open) openPalette(); },
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

// The team's chats, matching `query`. Debounced because this one is a request
// per keystroke otherwise, and sequenced by a token so a slow early query can
// never overwrite the results of a later one you are actually looking at.
function useChatHits(query) {
  const [hits, setHits] = useState([]);
  const seq = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setHits([]); return undefined; }
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const rows = await searchChats(q, 30);
        if (seq.current === mine) setHits(rows);
      } catch { if (seq.current === mine) setHits([]); }
    }, 160);
    return () => clearTimeout(t);
  }, [query]);
  return hits;
}

// One thing somebody said, as a search result. The matched line leads — that is
// what you were looking for — and the row underneath says where it came from:
// which agent, whose chat, which issue. Without that a hit is a floating
// sentence with no way back to its context.
function ChatResult({ hit, snippet, q }) {
  const agent = agentById(hit.agent);
  return (
    <>
      <div className="cmdk-item-main">
        <span className="cmdk-item-title">{highlight(snippet, q)}</span>
        <span className="cmdk-item-sub cmdk-chat-where">
          <AgentBadge agent={agent.id} size={13} />
          <span className="cmdk-chat-title">{hit.title || `chat ${hit.session_id.slice(0, 8)}`}</span>
          <span className="cmdk-chat-sep">·</span>
          <span className="cmdk-chat-env">{hit.env}</span>
          {hit.role === 'user' ? <span className="cmdk-chat-role">said</span> : null}
        </span>
      </div>
      <span className="pill cmdk-chat-pill">chat</span>
    </>
  );
}

function PaletteModal({ onClose }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  // The same channel a convo pill uses to open a chat — so a search hit and a
  // click on the card land in the identical place, with no second mechanism.
  const requestChat = useChatControl();
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

  // The team's chats. Fetched, not filtered client-side: the corpus is every
  // turn everyone has ever spoken, so it stays in the database.
  const chatHits = useChatHits(query);

  // ONE list of rows, each tagged with what it is, so ↑/↓ and Enter work the
  // same whether you land on an issue or on something somebody said. Issues
  // come first: you usually know the card you want, and a chat hit is the
  // answer when you don't. Each row is { kind, key } plus its own payload.
  const results = useMemo(() => {
    const issues = (data ?? []).filter(i => i.kind === 'issue');
    const q = query.trim().toLowerCase();
    if (!q) return issues.map(i => ({ kind: 'issue', key: i.id, issue: i, snippet: null }));
    const out = [];
    for (const i of issues) {
      const base = issueHaystack(i).includes(q);
      const body = bodies.get(i.id) || '';
      const bi = body.toLowerCase().indexOf(q);
      if (base || bi >= 0) {
        out.push({
          kind: 'issue', key: i.id, issue: i,
          snippet: bi >= 0 ? snippetAround(body, bi, q.length) : null,
        });
      }
    }
    for (const h of chatHits) {
      const at = h.text.toLowerCase().indexOf(q);
      out.push({
        kind: 'chat', key: `${h.session_id}:${h.idx}`, hit: h,
        snippet: snippetAround(h.text, at < 0 ? 0 : at, q.length),
      });
    }
    return out;
  }, [data, bodies, query, chatHits]);

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

  // Open a row. An issue goes to its card. A chat hit goes to the card the chat
  // belongs to AND opens that chat at the matching turn — the search only pays
  // off if it lands you on the sentence, not merely near it. A `main` chat has
  // no card, so it opens the chat where it lives without navigating.
  const go = useCallback((row) => {
    onClose();
    if (row.kind === 'chat') {
      const { env, session_id: sid, idx } = row.hit;
      if (env !== 'main') navigate(`/issues/${encodeURIComponent(env)}`);
      requestChat?.(env, sid, idx);
      return;
    }
    navigate(`/issues/${encodeURIComponent(row.issue.id)}`);
  }, [onClose, navigate, requestChat]);

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
      if (r) go(r);
    } else if (matchesCombo(e, 'Escape') || matchesCombo(e, hk('search'))) {
      // BARE Esc closes; so does a second ⌘K — both via matchesCombo, so a
      // MODIFIED Escape (⌘Esc is a command, not a modal-close) doesn't steal it.
      // The modal owns its own keys now that the primitive yields all hotkeys.
      e.preventDefault(); e.stopPropagation();
      onClose();
    } else if (e.key === 'Tab') {
      // Trap focus: the input is the only focusable control, so Tab must not
      // leave the modal for the page behind it.
      e.preventDefault();
    }
  };

  const q = query.trim();
  const activeId = results[active]?.key;
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
            placeholder="Search issues and everyone's chats…"
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
            <div className="cmdk-empty">No matching issues or chats</div>
          ) : results.map((row, i) => (
            <div
              key={row.key}
              id={`cmdk-opt-${row.key}`}
              role="option"
              aria-selected={i === active}
              className={`cmdk-item${i === active ? ' is-active' : ''}${row.kind === 'chat' ? ' cmdk-item-chat' : ''}`}
              onMouseMove={() => setActive(i)}
              // Keep focus on the input (aria-activedescendant model) — the click
              // still fires and navigates.
              onMouseDown={e => e.preventDefault()}
              onClick={() => go(row)}
            >
              {row.kind === 'chat' ? <ChatResult hit={row.hit} snippet={row.snippet} q={q} /> : (
                <>
                  <div className="cmdk-item-main">
                    <span className="cmdk-item-title">{highlight(row.issue.title || row.issue.id, q)}</span>
                    {row.snippet ? <span className="cmdk-item-sub">{highlight(row.snippet, q)}</span> : null}
                  </div>
                  <span className={`pill bucket bucket-${row.issue.status}`}>{statusLabel(row.issue.status)}</span>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
