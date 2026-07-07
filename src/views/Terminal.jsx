import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { getTheme, onThemeChange, XTERM_THEMES } from '../theme.js';
import { useLocalBackend } from '../capabilities.js';
import { Plus, X } from '../icons.jsx';
import { viewportText, spinnerState } from '../spinner.js';
import { reportActivity, clearActivity } from '../activity-store.js';
import { getTerminalToken } from '../terminal-token.js';

// Per-issue dev environment in the right sidebar.
//
//   issue ─▶ one git worktree ─▶ one or more chats (real `claude` sessions)
//
// States:
//   • no worktree yet      → empty state + "Create worktree & open chat"
//   • worktree + chats      → open the most-recent chat immediately; a switcher
//                             in the header flips between the issue's chats; a
//                             "+" mints a new chat in the same worktree.
// The PTY socket binds to the SELECTED chat's session id, so switching chats
// detaches one claude and attaches another. Each chat persists server-side, so
// a refresh re-attaches the same running session.

// One live xterm wired to one chat's PTY (issue + session id). Re-mounted (via
// React key) whenever the selected session changes, so teardown/reattach is clean.
// The terminal speaks for itself (cursor, output, an inline "[chat exited]"
// notice) — no separate connection-status text in the bar.
function ChatPane({ issueId, sessionId, mode, active }) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const webglRef = useRef(null);
  const navigate = useNavigate();
  // The main chat rides --continue and carries no client session id; every
  // other chat must name one before it can connect.
  const isMain = issueId === 'main';

  useEffect(() => {
    if (!issueId || (!sessionId && !isMain) || !hostRef.current) return;

    const term = new Xterm({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 12,
      cursorBlink: true,
      theme: XTERM_THEMES[getTheme()],
      allowProposedApi: true,
    });
    termRef.current = term;
    const offTheme = onThemeChange((t) => { term.options.theme = XTERM_THEMES[t]; });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    // GPU renderer is attached lazily, only while this pane is VISIBLE — see the
    // active-gated effect below. A WebGL context is a scarce GPU resource
    // (browsers cap ~16); now that board-load attaches every in-progress chat
    // into a hidden pool, handing each hidden terminal a context would starve
    // the one the user is actually looking at. Hidden panes never paint, so they
    // need no accelerator — their working/idle detection reads the buffer, not
    // the canvas. Visible panes get WebGL for Claude's heavy TUI redraws — and on
    // a visible pane WebGL is the ONLY renderer: xterm's DOM renderer paints those
    // redraws synchronously on the main thread, which freezes keystroke input
    // (type → freeze → keystrokes burst in), so degrading a visible pane to it is
    // worse than not rendering. There is no DOM fallback on the visible path (see
    // the active-gated effect).
    // ⌘← / Ctrl← is the "back to board" shortcut, but the terminal owns keystrokes
    // while focused (its hidden textarea swallows them before the window handler).
    // Intercept it here: navigate, and return false so xterm doesn't forward it
    // to the PTY. Everything else passes through to the shell untouched.
    term.attachCustomKeyEventHandler((e) => {
      // ⌘← jumps back to the board from an ISSUE chat. The main chat isn't scoped
      // to a route, so it leaves the shortcut alone (passes through to the shell).
      if (!isMain && e.type === 'keydown' && e.key === 'ArrowLeft' && (e.metaKey || e.ctrlKey)) {
        // preventDefault stops the browser's native Cmd+Left = Back, which would
        // otherwise double-navigate (our push to /changes, then a history pop
        // back to the detail — the visible flash).
        e.preventDefault();
        navigate('/changes');
        return false;
      }
      return true;
    });
    // Fit on mount. Focus too — EXCEPT the main chat, which is an ambient panel
    // shown on every page: auto-focusing it would steal the arrow keys from the
    // board (its window-level cursor nav), so the board keeps focus and the main
    // chat is typeable on click. Issue chats are opened deliberately → focus.
    requestAnimationFrame(() => { try { fit.fit(); } catch {} if (!isMain) term.focus(); });

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // The token is only required when Dash is network-exposed; on loopback it's
    // empty and omitted. It rides in the WS subprotocol, NOT the query string, so
    // it stays out of reverse-proxy/tunnel access logs (see server/ws-guard.mjs).
    const token = getTerminalToken();
    const ws = new WebSocket(
      `${proto}//${location.host}/api/dash/terminal`
      + `?issue=${encodeURIComponent(issueId)}`
      + (sessionId ? `&session=${encodeURIComponent(sessionId)}` : '')
      + `&mode=${encodeURIComponent(mode || 'resume')}`,
      token ? [`dash.token.${token}`] : undefined,
    );

    const sendResize = () => {
      // Panes live in a pool and are hidden with display:none when not active.
      // A hidden host measures 0×0, and fitting to that collapses the grid to ~1
      // row — which both mangles Claude's TUI (it's told the terminal is 1 row
      // tall) AND pushes the spinner line out of the visible window, so the
      // working/idle detector reads a bare "❯" and falsely reports idle. Skip the
      // reflow while hidden; the ResizeObserver fires again with real dimensions
      // the moment the pane is shown.
      const el = hostRef.current;
      if (!el || el.offsetParent === null || el.clientHeight === 0) return;
      try { fit.fit(); } catch {}
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };

    // Working/idle is read off the rendered VIEWPORT on a timer (see the
    // detection effect below), not off this stream — so reattach buffer replays
    // and stream silence don't matter here. Just write the bytes through.
    ws.onopen = () => sendResize();
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'output') {
        term.write(msg.data);
      }
      else if (msg.type === 'exit') {
        term.write(`\r\n\x1b[2m[chat exited${msg.code != null ? ` (${msg.code})` : ''}]\x1b[0m\r\n`);
      }
    };

    const dataDisp = term.onData((data) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data }));
    });

    const ro = new ResizeObserver(() => sendResize());
    ro.observe(hostRef.current);

    return () => {
      offTheme();
      ro.disconnect();
      dataDisp.dispose();
      try { ws.close(); } catch {}
      try { webglRef.current?.dispose(); } catch {}
      webglRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, [issueId, sessionId, mode]);

  // Attach the GPU renderer only while this pane is visible, and release its
  // context when it goes hidden — so the pool of attached-but-hidden chats holds
  // zero GPU contexts and the visible chat always has one. loadAddon must run
  // after open() (the canvas must exist). WebGL is the visible pane's ONLY
  // renderer: there is NO DOM fallback. If the addon can't load it throws (loud,
  // surfaced — not silently swallowed into a DOM render), and a lost context is
  // logged for diagnosis, not disposed-to-DOM. Disposing on HIDE below is a
  // deliberate context release, not a fallback — a hidden pane never paints, so
  // xterm's idle DOM baseline costs nothing.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return undefined;
    if (active && !webglRef.current) {
      const webgl = new WebglAddon();
      webgl.onContextLoss((e) => { console.error('[dash terminal] WebGL context lost', e); });
      term.loadAddon(webgl);
      webglRef.current = webgl;
    } else if (!active && webglRef.current) {
      try { webglRef.current.dispose(); } catch {}
      webglRef.current = null;
    }
    return undefined;
  }, [active, issueId, sessionId, mode]);

  // Opening an item with the chat already mounted (in the pool) doesn't remount
  // this pane, so the mount-focus above won't fire — focus when it becomes the
  // active, visible chat instead, so the terminal is typeable without a click.
  useEffect(() => {
    if (!active || isMain) return; // main chat stays hands-off so the board owns arrow keys
    const id = requestAnimationFrame(() => { try { termRef.current?.focus(); } catch {} });
    return () => cancelAnimationFrame(id);
  }, [active, isMain]);

  // ⌘→ / ⌘← focus toggle on the board: the Shell dispatches these so the active
  // pane (main or issue) takes/releases keyboard focus on demand. Unlike the
  // auto-focus above, an explicit ⌘→ focuses even the main chat — the hands-off
  // rule only governs IMPLICIT focus, and here the user deliberately asked for
  // the cursor. ⌘← blurs, handing the arrow keys back to the board cursor.
  useEffect(() => {
    if (!active) return undefined;
    const focusMe = () => { try { termRef.current?.focus(); } catch {} };
    const blurMe = () => { try { termRef.current?.blur(); } catch {} };
    window.addEventListener('dash:focus-chat', focusMe);
    window.addEventListener('dash:focus-board', blurMe);
    return () => {
      window.removeEventListener('dash:focus-chat', focusMe);
      window.removeEventListener('dash:focus-board', blurMe);
    };
  }, [active]);

  // Working/idle detection, read from the RENDERED VIEWPORT (not the stream).
  // Each tick snapshots the visible grid: working iff a live spinner glyph is on
  // screen OR the viewport changed since the last sample (covers text streaming,
  // which shows no spinner). A frozen viewport with no spinner == idle (the input
  // box, or a menu awaiting the human). Reading the buffer works for a hidden
  // pane too (term.write updates it regardless of painting) and survives stream
  // silence (the frozen frame keeps the spinner). GRACE bridges the gap between
  // viewport changes so steady work doesn't flicker idle. See spinner.js.
  useEffect(() => {
    if (!issueId || !sessionId) return;
    const GRACE_MS = 2500;
    const SETTLE_MS = 2500;  // ignore the mount-time replay burst (see below)
    const mountedAt = Date.now();
    let lastText = null;  // null = not yet primed; the first snapshot isn't a "change"
    let changes = [];     // timestamps of recent viewport changes
    const tick = () => {
      const term = termRef.current;
      if (!term) return;
      const text = viewportText(term);
      const now = Date.now();
      // The mount-time settle window. Attaching a chat replays its scrollback in
      // a burst (the server dumps its recent buffer; a fresh `claude --resume`
      // redraws its transcript). That burst is "screen changing, no spinner" —
      // BYTE-FOR-BYTE the same shape as a live response streaming in — so it
      // can't be told apart by content. We just don't count changes for the
      // first couple seconds after mount, which is when the replay lands. (A
      // chat that's genuinely THINKING on open still shows a live spinner and is
      // caught immediately; only a chat already mid-stream on open is delayed by
      // up to this window before the dot drops — a fine trade for never flashing.)
      const settling = now - mountedAt < SETTLE_MS;
      const changed = lastText !== null && text !== lastText;
      if (lastText === null) lastText = text;
      else if (changed) { lastText = text; if (!settling) changes.push(now); }
      changes = changes.filter((t) => now - t < GRACE_MS);
      const spin = spinnerState(text);
      // Working iff a live spinner is on screen, OR the grid is actively changing.
      // The two clauses cover the two phases of a turn, because they DON'T
      // overlap: Claude shows the "✻ Verb…" spinner while THINKING / between tool
      // calls (no text moving), then the spinner DISAPPEARS while it STREAMS the
      // answer (the bare input box sits at the bottom and text pours in above it).
      // So streaming has no spinner at all — its only tell is the viewport
      // changing. ≥2 changes in the grace window is "streaming" (one lone repaint
      // at a turn boundary isn't). The replay burst is excluded by the settle
      // window above, so a changing grid here means real output.
      const working = spin === 'live' || changes.length >= 2;
      reportActivity(sessionId, issueId, working ? 'working' : 'idle');
    };
    const iv = setInterval(tick, 300);
    return () => { clearInterval(iv); clearActivity(sessionId); };
  }, [issueId, sessionId]);

  return (
    <div className="issue-terminal">
      <div className="issue-terminal-host" ref={hostRef} />
    </div>
  );
}

function chatLabel(c, i) {
  return `chat ${i + 1} · ${c.sessionId.slice(0, 8)}${c.resumable ? '' : ' (unavailable)'}`;
}

// Custom chat dropdown (a native <select> can't carry a per-row unlink button).
// Trigger shows the open chat; the menu lists every chat with a select target
// and an × to unlink it from the issue. Resumable chats are pickable; the rest
// show disabled but are still unlinkable. Closes on outside-click / select.
function ChatSwitcher({ chats, selected, onSelect, onNew, onUnlink, busy }) {
  const [open, setOpen] = useState(false);
  const [confirmId, setConfirmId] = useState(null); // chat awaiting unlink confirm
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setConfirmId(null); } };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const selIdx = chats.findIndex(c => c.sessionId === selected);
  const triggerLabel = chats.length === 0 ? 'no chats'
    : selIdx >= 0 ? chatLabel(chats[selIdx], selIdx)
    : `${chats.length} chats`;

  return (
    <div className="issue-chat-switch" ref={ref}>
      <div className="issue-chat-menu-wrap">
        <button className="issue-chat-trigger" onClick={() => setOpen(v => !v)}
          disabled={!chats.length} aria-haspopup="listbox" aria-expanded={open}>
          <span className="issue-chat-trigger-label">{triggerLabel}</span>
          <svg className="issue-chat-caret" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
            <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {open && chats.length > 0 ? (
          <ul className="issue-chat-menu" role="listbox">
            {chats.map((c, i) => (
              <li key={c.sessionId} className={`issue-chat-item${c.sessionId === selected ? ' is-current' : ''}`}>
                <button className="issue-chat-pick" disabled={!c.resumable}
                  onClick={() => { onSelect(c.sessionId); setOpen(false); }}>{chatLabel(c, i)}</button>
                {confirmId === c.sessionId ? (
                  <span className="issue-chat-confirm">
                    <button className="issue-chat-confirm-yes" title="Confirm unlink"
                      onClick={() => { onUnlink(c.sessionId); setConfirmId(null); }}>unlink</button>
                    <button className="issue-chat-confirm-no" title="Cancel"
                      onClick={() => setConfirmId(null)}>cancel</button>
                  </span>
                ) : (
                  <button className="icon-btn issue-chat-unlink" title="Unlink this chat from the issue"
                    aria-label="Unlink chat" onClick={() => setConfirmId(c.sessionId)}><X size={13} /></button>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <button className="icon-btn issue-chat-new" onClick={onNew} disabled={busy} title="New chat in this worktree" aria-label="New chat"><Plus /></button>
    </div>
  );
}

// The universal MAIN chat: one persistent claude thread in the live repo root,
// shown in the sidebar on every page that isn't an issue detail. No worktree, no
// Supabase chats, no switcher — just the single thread. The server keys this PTY
// by the 'main' sentinel and keeps it alive, so reloads (and a mid-session
// /clear) reattach the same terminal. The FIRST open ever runs /main; every
// later open resumes the latest root session via --continue. The started-flag is
// flipped at mount so a reload resumes instead of re-initializing.
export function MainTerminal({ active }) {
  const [mode] = useState(() => {
    const started = localStorage.getItem('dash-main-started') === '1';
    localStorage.setItem('dash-main-started', '1');
    return started ? 'main' : 'main-init';
  });
  return (
    <div className="issue-terminal-wrap">
      <div className="issue-terminal-bar">
        <span className="main-chat-label">main</span>
      </div>
      <ChatPane key="main" issueId="main" sessionId={null} mode={mode} active={active} />
    </div>
  );
}

// Top-level per-issue terminal. Fetches the issue's worktree + chats, drives the
// empty-state → create → open → switch flow, and renders the active ChatPane.
export function IssueTerminal({ issueId, requestSession, active }) {
  // Worktrees + the `claude` PTY live on the machine running the dev server —
  // there is no terminal backend on Vercel. Model A: when there's no local
  // backend, show a clean "not on this machine" state instead of opening a
  // WebSocket to a 404. The board itself still works remotely; only this pane
  // is machine-bound.
  const local = useLocalBackend();
  const [state, setState] = useState({ loading: true });
  const [selected, setSelected] = useState(null);
  const [mode, setMode] = useState('resume'); // 'new' for a just-minted chat
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!issueId) return;
    try {
      const r = await fetch(`/api/dash/terminal/chats?issue=${encodeURIComponent(issueId)}`);
      const data = await r.json();
      setState({ loading: false, ...data });
      return data;
    } catch (e) {
      setState({ loading: false, worktree: false, chats: [] });
      setError(String(e));
    }
  }, [issueId]);

  // Reset + load whenever the issue changes. Skipped without a local backend —
  // there is nothing to load remotely (the guard render below takes over).
  useEffect(() => {
    if (local !== true) return;
    setSelected(null);
    setMode('resume');
    setError(null);
    setState({ loading: true });
    refresh();
  }, [issueId, refresh, local]);

  // Auto-open a chat once chats are known: the LAST-OPENED one (remembered per
  // issue) if it's still resumable, else the most-recently-linked resumable. A
  // chat is resumable wherever its transcript lives — not only inside the issue's
  // own worktree — so this does NOT gate on state.worktree.
  useEffect(() => {
    if (state.loading || selected) return;
    const resumable = (state.chats || []).filter(c => c.resumable);
    if (!resumable.length) return;
    const lastId = localStorage.getItem(`dash-chat-last:${issueId}`);
    const last = resumable.find(c => c.sessionId === lastId);
    // Prefer a chat whose PTY is already LIVE: reattaching to it is free, while
    // picking a dormant sibling would cold-spawn claude. This is what keeps
    // board-load auto-attach cheap (it only ever seeds issues that HAVE a live
    // chat). Honour the human's last-opened choice when it is itself live;
    // otherwise the live one wins, then last-opened, then most-recently-linked.
    const liveChat = resumable.find(c => c.live);
    const pick = (last && last.live ? last : null) || liveChat || last || resumable[resumable.length - 1];
    setSelected(pick.sessionId);
    setMode('resume');
  }, [state, selected, issueId]);

  // Remember the open chat per issue, so reopening the issue lands on it.
  useEffect(() => {
    if (selected && issueId) localStorage.setItem(`dash-chat-last:${issueId}`, selected);
  }, [selected, issueId]);

  // A convo pill in the detail view asked to open a specific chat. The nonce
  // re-fires the selection even when the same session is clicked again.
  useEffect(() => {
    if (requestSession?.sessionId) {
      setSelected(requestSession.sessionId);
      setMode('resume');
    }
  }, [requestSession?.nonce, requestSession?.sessionId]);

  const createWorktreeAndChat = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/dash/terminal/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue: issueId }),
      });
      const data = await r.json();
      if (!r.ok || data.error) { setError(data.error || 'create failed'); return; }
      await refresh();
      setSelected(data.sessionId);
      setMode('new');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const newChat = async () => {
    // Same endpoint as create — the worktree already exists, so it just mints a
    // new linked session.
    await createWorktreeAndChat();
  };

  // Unlink a chat from this issue (drops the association; transcript untouched).
  // If it was the open one, clear selection so auto-open lands on another.
  const unlinkChat = async (sessionId) => {
    setError(null);
    try {
      const r = await fetch('/api/dash/terminal/chat', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue: issueId, session: sessionId }),
      });
      const data = await r.json();
      if (!r.ok || data.error) { setError(data.error || 'unlink failed'); return; }
      if (localStorage.getItem(`dash-chat-last:${issueId}`) === sessionId) {
        localStorage.removeItem(`dash-chat-last:${issueId}`);
      }
      if (selected === sessionId) setSelected(null); // auto-open picks the next
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  // Probing the backend, or no backend at all (remote on Vercel).
  if (local === null) {
    return (
      <div className="issue-terminal issue-terminal-msg">
        <p className="dim">loading…</p>
      </div>
    );
  }
  if (local === false) {
    return (
      <div className="issue-terminal issue-terminal-msg">
        <div className="issue-empty">
          <p className="issue-empty-title">Not on this machine</p>
          <p className="dim">
            Worktrees and chats run on the machine serving the dev server. Open
            this issue from that machine's local Dash (its <code>localhost</code>
            dev server) to create a worktree or attach a chat. The board, issues
            and captures above work here remotely.
          </p>
        </div>
      </div>
    );
  }

  if (state.loading) {
    return (
      <div className="issue-terminal issue-terminal-msg">
        <p className="dim">loading…</p>
      </div>
    );
  }

  // Empty state ONLY when the issue has NEITHER a worktree NOR any linked chat.
  // (The create button makes the worktree + first chat in one click.) If a
  // worktree exists but has no chats, or chats exist but their worktree is gone,
  // fall through to the header below — the "＋" mints a new chat and any
  // present-but-unresumable chats render disabled in the switcher.
  const hasChats = (state.chats || []).length > 0;
  if (!state.worktree && !hasChats) {
    return (
      <div className="issue-terminal issue-terminal-msg">
        <div className="issue-empty">
          <p className="issue-empty-title">No dev environment yet</p>
          <p className="dim">
            Create an isolated git worktree for <code>{issueId}</code> and open a
            claude chat inside it.
          </p>
          <button className="issue-empty-btn" onClick={createWorktreeAndChat} disabled={busy}>
            {busy ? 'Creating…' : 'Create worktree & open chat'}
          </button>
          {error && <p className="issue-empty-err">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="issue-terminal-wrap">
      <div className="issue-terminal-bar">
        <ChatSwitcher
          chats={state.chats || []}
          selected={selected}
          onSelect={(sid) => { setSelected(sid); setMode('resume'); }}
          onNew={newChat}
          onUnlink={unlinkChat}
          busy={busy}
        />
      </div>
      {error && <p className="issue-empty-err">{error}</p>}
      {selected && (
        <ChatPane key={selected} issueId={issueId} sessionId={selected} mode={mode} active={active} />
      )}
    </div>
  );
}
