import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { getTheme, onThemeChange, XTERM_THEMES } from '../theme.js';
import { useLocalBackend } from '../capabilities.js';
import { Plus, X, Pencil } from '../icons.jsx';
import { viewportText } from '../spinner.js';
import { agentById, agentChoices, DEFAULT_AGENT } from '../agents.js';
import { reportActivity, clearActivity } from '../activity-store.js';
import { setSelectedChat } from '../../server/profiles-store.mjs';
import { userEmail } from '../auth.js';
import { useSessionOwner } from '../session-pool.js';
import { acquireWebgl, releaseWebgl } from './term-renderer.js';
import { CopyButton } from './CopyButton.jsx';
import { emitIssuesChange, subscribeIssues } from '../realtime.js';
import { getTerminalToken } from '../terminal-token.js';
import { updateChangeField } from '../board-store.js';

const AGENTS = agentChoices();
const LAST_AGENT_KEY = 'dash-chat-agent';
const lastAgent = () => {
  try { const v = localStorage.getItem(LAST_AGENT_KEY); return AGENTS.some(a => a.id === v) ? v : DEFAULT_AGENT; }
  catch { return DEFAULT_AGENT; }
};
const rememberAgent = (id) => { try { localStorage.setItem(LAST_AGENT_KEY, id); } catch {} };

// A small type pill so a Codex chat reads apart from a Claude one at a glance.
function AgentBadge({ agent }) {
  const m = agentById(agent);
  return <span className={`agent-badge agent-badge-${m.id}`} title={m.label}>{m.short}</span>;
}

// A ROLE pill shown ALONGSIDE the agent badge. A reviewer chat is still a
// claude/codex CLI, so its role reads as an extra tag next to the agent, not a
// swap — and it's what makes a reviewer read distinctly in the switcher (it's
// never the default selection and never dots the card).
function RoleBadge({ role }) {
  if (!role) return null;
  return <span className={`agent-badge role-badge role-badge-${role}`} title={`${role} chat`}>{role}</span>;
}

// The choice popover shared by the "+" button and the empty state: one row per
// agent. Selecting fires onPick(agentId). Absolute-positioned; the caller owns
// the open/close and outside-click.
function AgentMenu({ onPick, className = '' }) {
  return (
    <ul className={`agent-menu ${className}`} role="menu">
      {AGENTS.map(a => (
        <li key={a.id} role="none">
          <button role="menuitem" className={`agent-menu-item agent-menu-item-${a.id}`}
            onClick={() => onPick(a.id)}>
            <AgentBadge agent={a.id} />
            <span className="agent-menu-label">{a.label}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

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

// Mounted terminals by session id — a test/debug seam (window.__dashViewport)
// for reading what a session's terminal actually shows, e.g. asserting that
// typed keystrokes echo back through the attached PTY.
const liveTerms = new Map();
if (typeof window !== 'undefined') {
  window.__dashViewport = (sessionId) => {
    const t = liveTerms.get(sessionId);
    return t ? viewportText(t) : null;
  };
}

// One live xterm wired to one chat's PTY (issue + session id). Re-mounted (via
// React key) whenever the selected session changes, so teardown/reattach is clean.
// The terminal speaks for itself (cursor, output, an inline "[chat exited]"
// notice) — no separate connection-status text in the bar.
function ChatPane({ issueId, sessionId, mode, active, onSession, agent }) {
  const hostRef = useRef(null);
  // The PTY's `ready` names the real session id — the only place the MAIN chat
  // (which connects without one) can learn it. Ref-carried so the mount effect
  // needn't depend on the callback's identity.
  const onSessionRef = useRef(onSession);
  onSessionRef.current = onSession;
  const termRef = useRef(null);
  const webglRef = useRef(null);
  const resizeRef = useRef(null); // calls the live pane's sendResize (set on mount)
  // The chat's PTY may be hosted by ANOTHER dash server on this machine (one
  // owner per session, machine-wide). This server answers the attach with
  // { type: 'redirect', port } and we reconnect there — set here, effect re-runs.
  const [hostPort, setHostPort] = useState(null);
  // The protocol allows EXACTLY ONE redirect: the server you connect to either
  // owns the chat or names the single machine-wide owner to go to. A second
  // redirect (or one pointing back at the server we're already on) means the
  // owner moved or died — not something to chase, so we stop and show a visible
  // notice instead of looping or silently blanking. This ref persists across the
  // hostPort-driven remount; a fresh chat (new React key) resets it.
  const redirectedRef = useRef(false);
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
    // Test hook (same pattern as __dashActivity): the suite reads grid geometry
    // and buffer text straight off the live xterm — no DOM scraping, renderer-
    // agnostic (a WebGL pane has no readable text nodes).
    const termKey = `${issueId}:${sessionId || 'main'}`;
    (window.__dashTerms ??= new Map()).set(termKey, term);
    if (sessionId) liveTerms.set(sessionId, term);
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
    // the canvas. Visible panes get WebGL for Claude's heavy TUI redraws; only a
    // client with no WebGL2 at all falls back to the DOM renderer (see
    // term-renderer.js) — slower under TUI floods, but alive.
    // Route chords (⌘← back to board, ⌘↑/⌘↓ prev/next) are NOT handled here: a
    // focused issue terminal only exists on its own detail route, whose capture-
    // phase window listener (ChangeDetail) intercepts them before xterm's own
    // keydown handler — and on the board, main.jsx's capture handler owns ⌘←/⌘→.
    // Everything else passes through to the shell untouched.
    // A pane's grid has exactly two legitimate sources: the LAYOUT when the host
    // is visible (fit proposes cols/rows from real pixels), and the PTY when it
    // isn't (a `display:none` pool pane has no pixels — FitAddon would collapse
    // to its 2×1 floor and the scrollback replay would render into confetti).
    // `unsized` picks the source: no layout → mirror the PTY grid, bytes render
    // in the geometry they were formatted for.
    const unsized = () => {
      const el = hostRef.current;
      return !el || el.offsetParent === null || el.clientHeight === 0;
    };

    // Fit on mount — only if the host has layout (a pool pane mounts hidden; its
    // grid arrives with the PTY's `ready` below). Focus is NOT handled here:
    // panes also mount hidden (pool seeding, shadow panes for sibling live
    // chats), where grabbing focus would be wrong — the active-gated effect
    // below already focuses a pane the moment it's the visible one, which
    // includes a deliberate fresh open.
    requestAnimationFrame(() => { if (!unsized()) { try { fit.fit(); } catch {} } });

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // After a redirect, the socket goes to the owning server's port (same
    // machine, different dev server) instead of the one serving this page.
    const wsHost = hostPort ? `${location.hostname}:${hostPort}` : location.host;
    // The token is only required when Dash is network-exposed; on loopback it's
    // empty and omitted. It rides in the WS subprotocol, NOT the query string, so
    // it stays out of reverse-proxy/tunnel access logs. We offer a token-free
    // base subprotocol alongside it; the server echoes back only the base, so the
    // token never appears in the response headers either (see server/ws-guard.mjs).
    const token = getTerminalToken();

    // The socket is a SUPERVISED resource, not a single-shot one: it can die
    // while the pane is mounted (a backgrounded tab — Chrome tab freeze, sleep,
    // a network change — kills it with no action in the page), and the PTY
    // stays alive server-side by design. So the pane reconnects on any
    // ABNORMAL close and reattaches (the server replays scrollback), instead
    // of sitting frozen until a manual refresh (issue i-terminal-freeze).
    //
    // DELIBERATE server closes must NOT reconnect — each carries a close frame
    // with our own codes: 1000 (sent to the redirect target — the chat lives
    // in another dash server) and 1011 (refusals: not resumable, claim
    // refused). Reconnecting on those would chase a server that just told us
    // where (or why not) to attach. A socket that dies WITHOUT one of those
    // frames (1006 abnormal, or anything else) is the freeze condition, and
    // reconnecting is always safe: the server just reattaches — multi-attach
    // means joining alongside any other pane, never stealing from it.
    let ws = null;
    let disposed = false;
    let exited = false;    // PTY is gone — reconnecting would resurrect claude
    let ready = false;     // this socket got an answer (gates redirect fallback)
    let everReady = false; // this term has shown a session → reset before replay
    let retryTimer = null;
    let retryDelay = 300;

    const scheduleReconnect = () => {
      if (disposed || retryTimer) return;
      retryTimer = setTimeout(() => { retryTimer = null; if (!disposed) connect(); }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15000);
    };
    // A hidden tab throttles timers, so a pending retry can sit for minutes —
    // returning to the tab (or the network coming back) brings it forward to
    // NOW. Only ever accelerates a retry the close handler already judged
    // legitimate; it never initiates one, so a superseded pane stays detached.
    const wake = () => {
      if (disposed || !retryTimer) return;
      clearTimeout(retryTimer);
      retryTimer = null;
      connect();
    };

    // Resize is driven ONLY by real layout intent — a window resize or a user
    // dragging a pane's width (the Shell broadcasts 'dash:refit' on both) — never
    // by watching the host element. Watching it fired on every incidental reflow
    // (a board re-render when the needs-input dot flips, a pool show/hide), and
    // each resize makes Claude's TUI repaint its whole screen instead of echoing
    // keystrokes — that was the "freeze → keys burst in" and the squished-on-
    // reopen text. Two guards keep it quiet: skip while hidden (a 0×0 host would
    // collapse the grid), and only message the PTY when the integer cols/rows
    // ACTUALLY change (pixel drags rarely cross a cell boundary), so a refit that
    // lands on the same grid sends nothing.
    //
    // DELIVERY IS GUARANTEED, NOT BEST-EFFORT (issue i-term-corrupt): sentCols/
    // sentRows record what the PTY was actually TOLD, so they change only when a
    // send happens. Recording before the readyState check poisoned the dedupe —
    // a refit that ran while the socket was still connecting (the mount-time
    // rAF refit reliably beats the handshake on a busy dev server) marked the
    // fitted grid as sent, every later refit early-returned, and the PTY kept
    // its stale grid forever: claude formatted every byte for a grid the pane
    // didn't have — the persistently mangled terminal that only a width nudge
    // (a real cols change) healed.
    let sentCols = 0, sentRows = 0;
    const sendResize = () => {
      if (unsized()) return;
      try { fit.fit(); } catch {}
      if (ws?.readyState !== 1) return; // not connected — nothing sent, nothing recorded
      if (term.cols === sentCols && term.rows === sentRows) return;
      sentCols = term.cols; sentRows = term.rows;
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    const connect = () => {
      ready = false;
      // Fresh dedupe per socket: the guard exists to suppress chatter within a
      // connection, but a NEW socket has seen nothing — a grid change during
      // the outage must not be skipped because the OLD socket saw the size.
      sentCols = 0; sentRows = 0;
      // The FIRST connect carries the pane's mode ('new' spawns with the intro
      // prompt, 'main-init' runs /main); every reconnect is a plain reattach —
      // re-sending a spawning mode could double-run the first turn.
      const wireMode = everReady ? (isMain ? 'main' : 'resume') : (mode || 'resume');
      ws = new WebSocket(
        `${proto}//${wsHost}/api/dash/terminal`
        + `?issue=${encodeURIComponent(issueId)}`
        + (sessionId ? `&session=${encodeURIComponent(sessionId)}` : '')
        + `&mode=${encodeURIComponent(wireMode)}`
        // Tell the server which CLI this chat is, so a cold resume reopens with
        // the right one (claude --resume vs codex resume). Absent → claude.
        + (agent ? `&agent=${encodeURIComponent(agent)}` : ''),
        token ? ['dash.terminal.v1', `dash.token.${token}`] : ['dash.terminal.v1'],
      );
      // Test hook (same key as __dashTerms): the live socket, so the suite can
      // kill it out from under the pane — the shape a backgrounded tab produces.
      (window.__dashSockets ??= new Map()).set(termKey, ws);

      // Working/idle is read off the rendered VIEWPORT on a timer (see the
      // detection effect below), not off this stream — so reattach buffer replays
      // and stream silence don't matter here. Just write the bytes through.
      ws.onopen = () => { retryDelay = 300; };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'ready') {
          ready = true; // the server answered — a later close is teardown, not a failed redirect
          // A reconnect replays scrollback this term has already rendered —
          // reset first so the replay repaints the screen instead of
          // duplicating it (same clean slate a refresh would give).
          if (everReady) { try { term.reset(); } catch {} }
          everReady = true;
          // The PTY announces its grid, then replays scrollback formatted for
          // exactly that grid. A hidden pane can't fit from layout, so it MIRRORS
          // the announced grid — the replay (and all output while hidden) renders
          // in the geometry it was written for. A visible pane pushes ITS grid to
          // the PTY instead: `ready` is the delivery anchor (not ws.onopen) —
          // it proves the server's message handler is installed, where a resize
          // sent at onopen can land before a slow attach registers one and
          // silently evaporate. sendResize self-gates: hidden panes skip it.
          if (unsized() && msg.cols > 0 && msg.rows > 0) {
            try { term.resize(msg.cols, msg.rows); } catch {}
          }
          sendResize();
          if (msg.sessionId) onSessionRef.current?.(msg.sessionId);
        }
        else if (msg.type === 'output') {
          ready = true;
          everReady = true;
          term.write(msg.data);
        }
        else if (msg.type === 'grid') {
          // Another attached pane owns the PTY grid now (last resize assertion
          // wins — see attachChat). Mirror it so output keeps rendering in the
          // geometry it's formatted for; our own resizes are ignored server-
          // side until ownership comes back, so don't record them as sent.
          if (msg.cols > 0 && msg.rows > 0) {
            sentCols = 0; sentRows = 0;
            try { term.resize(msg.cols, msg.rows); } catch {}
          }
        }
        else if (msg.type === 'owner') {
          // The grid's owner detached — assert our fit to claim it. A hidden
          // pane self-gates inside sendResize (unsized) and stays a mirror;
          // a visible pane re-fits and pushes its geometry (dedupe reset:
          // what the PTY has is the DEPARTED pane's grid, whatever we
          // recorded before is stale).
          sentCols = 0; sentRows = 0;
          sendResize();
        }
        else if (msg.type === 'exit') {
          ready = true;
          exited = true; // the PTY is gone; a socket close after this must not respawn it
          term.write(`\r\n\x1b[2m[chat exited${msg.code != null ? ` (${msg.code})` : ''}${msg.error ? ` — ${msg.error}` : ''}]\x1b[0m\r\n`);
        }
        else if (msg.type === 'redirect') {
          // Another dash server owns this chat's PTY — reconnect there once, rather
          // than letting this one fork a duplicate claude (i-chat-collision). A
          // redirect to the port we're already on, or a SECOND redirect, is a
          // protocol violation (the owner moved or died): surface it, don't chase.
          const current = hostPort || Number(location.port);
          const target = msg.port;
          if (!target || target === current || redirectedRef.current) {
            term.write(`\r\n\x1b[2m[chat owner unavailable — reopen this chat to retry]\x1b[0m\r\n`);
            return;
          }
          redirectedRef.current = true;
          setHostPort(target);
        }
      };

      ws.onclose = (ev) => {
        if (disposed) return;
        // A redirected socket dying before the owner ever answered — the owning
        // server exited between the redirect and our reconnect — falls back to
        // the origin server once (clear hostPort → remount). The origin
        // re-resolves ownership: a cleanly-exited owner released its claim, so
        // the origin resumes locally; a CRASHED owner's claim is deliberately
        // never auto-reclaimed (server-side race-safety), so the origin
        // surfaces the honest stale-record error instead of stranding a dead
        // pane silently. redirectedRef stays set, so it can't bounce us again.
        if (hostPort && !ready) { setHostPort(null); return; }
        if (exited) return;
        if (ev.code === 1000 || ev.code === 1011) return; // deliberate server close
        scheduleReconnect();
      };
    };
    connect();

    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);

    const dataDisp = term.onData((data) => {
      if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'input', data }));
    });

    // Refit on the only two real triggers: the window changing size, and the
    // Shell telling us a pane width was dragged. Both refit every mounted pane so
    // "drag one width → they all reflow" holds, but the cols/rows guard above
    // means hidden/unchanged panes stay silent.
    window.addEventListener('resize', sendResize);
    window.addEventListener('dash:refit', sendResize);
    resizeRef.current = sendResize;

    return () => {
      disposed = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
      offTheme();
      window.removeEventListener('resize', sendResize);
      window.removeEventListener('dash:refit', sendResize);
      resizeRef.current = null;
      dataDisp.dispose();
      try { ws?.close(); } catch {}
      releaseWebgl(webglRef.current);
      webglRef.current = null;
      window.__dashTerms?.delete(termKey);
      if (window.__dashSockets?.get(termKey) === ws) window.__dashSockets.delete(termKey);
      if (sessionId && liveTerms.get(sessionId) === term) liveTerms.delete(sessionId);
      term.dispose();
      termRef.current = null;
    };
  }, [issueId, sessionId, mode, hostPort, agent]);

  // Attach the GPU renderer only while this pane is visible, and release its
  // context when it goes hidden — so the pool of attached-but-hidden chats holds
  // zero GPU contexts and the visible chat always has one. acquireWebgl runs
  // after open() (the canvas must exist) and never throws: a WebGL-less client
  // degrades to the DOM renderer, and a context lost mid-flight releases the
  // addon and clears the ref (via onLost) so the next activation reacquires —
  // see term-renderer.js for the full contract. Disposing on HIDE is a
  // deliberate context release, not a fallback — a hidden pane never paints, so
  // xterm's idle DOM baseline costs nothing.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return undefined;
    if (active && !webglRef.current) {
      webglRef.current = acquireWebgl(term, () => { webglRef.current = null; });
    } else if (!active && webglRef.current) {
      releaseWebgl(webglRef.current);
      webglRef.current = null;
    }
    return undefined;
    // hostPort is a dep because a redirect remounts the xterm (the mount effect
    // depends on it and disposes the old term + WebGL addon on teardown). Without
    // hostPort here, a redirected VISIBLE pane would get a fresh term with no
    // renderer — and WebGL is its ONLY renderer, so the pane would go blank.
  }, [active, issueId, sessionId, mode, hostPort]);

  // Becoming visible is the one moment a pane may be stale: a window or pane-width
  // change while it was hidden was skipped (a hidden host is 0×0). Refit once on
  // show — the cols/rows guard makes it a no-op (no PTY message, no Claude redraw)
  // unless the grid genuinely changed, so a plain chat-switch stays silent.
  useEffect(() => {
    if (!active) return undefined;
    const id = requestAnimationFrame(() => { try { resizeRef.current?.(); } catch {} });
    return () => cancelAnimationFrame(id);
  }, [active]);

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
  // The shared loop owns sampling and recent-change tracking; the client agent
  // adapter owns what a frozen viewport means for its TUI. Reading the buffer
  // works for hidden panes too and survives stream silence. GRACE bridges the
  // gap between viewport changes so steady streaming doesn't flicker idle.
  useEffect(() => {
    if (!issueId || !sessionId) return;
    const adapter = agentById(agent);
    const activityKey = adapter.activityKey(sessionId);
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
      // The adapter combines its frozen-status grammar with the common
      // streaming fallback (>=2 changes). The replay burst is excluded by the
      // settle window above, so recent changes here mean real output.
      const working = adapter.isWorking({ viewport: text, recentChanges: changes });
      reportActivity(activityKey, working ? 'working' : 'idle');
    };
    // First tick immediately, not at +300ms: on an ownership handoff the
    // predecessor's unmount cleared this session's activity in the same commit,
    // and an immediate report closes the dot gap before the board can repaint.
    tick();
    const iv = setInterval(tick, 300);
    return () => { clearInterval(iv); clearActivity(activityKey); };
  }, [issueId, sessionId, agent]);

  return (
    <div className="issue-terminal">
      <div className="issue-terminal-host" ref={hostRef} />
    </div>
  );
}

// What a chat is CALLED, in one place: the name the user gave it if there is
// one, else the derived default. The default stays positional ("chat 2") — it
// describes where the chat sits in this env's list, which is exactly what an
// unnamed chat has to go on. "(unavailable)" is a suffix on both: it reports
// liveness, not identity, so naming a chat never hides that it can't resume.
function chatDefaultLabel(c, i) {
  return `chat ${i + 1}`;
}
function chatLabel(c, i) {
  return `${c.name || chatDefaultLabel(c, i)}${c.resumable ? '' : ' (unavailable)'}`;
}

// Copy icon for the open chat's session id — the address other agents use to
// message this chat (agent-chat). Icon-only; the tooltip carries the short id.
function ChatCopy({ sessionId }) {
  // 'main' is the server's env key, not an addressable session — a warm main
  // chat spawned before the server learned to resolve the real uuid reports it.
  if (!sessionId || sessionId === 'main') return null;
  return <CopyButton text={sessionId} title={`Copy chat session id (${sessionId.slice(0, 8)})`} />;
}

// Custom chat dropdown (a native <select> can't carry a per-row unlink button).
// Trigger shows the open chat; the menu lists every chat with a select target
// and an × to unlink it from the issue. Resumable chats are pickable; the rest
// show disabled but are still unlinkable. Closes on outside-click / select.
function ChatSwitcher({ chats, selected, onSelect, onNew, onUnlink, onRename, busy }) {
  const [open, setOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false); // the "+" agent-choice popover
  const [confirmId, setConfirmId] = useState(null); // chat awaiting unlink confirm
  const [editing, setEditing] = useState(false); // renaming the open chat inline
  const [draft, setDraft] = useState('');
  // Leaving the field settles the name exactly once. Enter and Escape both
  // decide it themselves and then unmount the input, which fires a blur — this
  // says "already handled", so a cancel can't come back as a save.
  const settled = useRef(false);
  const ref = useRef(null);
  const newRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setConfirmId(null); } };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  useEffect(() => {
    if (!newOpen) return;
    const onDoc = (e) => { if (newRef.current && !newRef.current.contains(e.target)) setNewOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [newOpen]);
  // Switching chats abandons an open rename — the field was seeded from the chat
  // that just left, so committing it would name the wrong one.
  useEffect(() => { settled.current = true; setEditing(false); }, [selected]);

  const selIdx = chats.findIndex(c => c.sessionId === selected);
  const selChat = selIdx >= 0 ? chats[selIdx] : null;
  const triggerLabel = chats.length === 0 ? 'no chats'
    : selChat ? chatLabel(selChat, selIdx)
    : `${chats.length} chats`;

  const pickNew = (agent) => { setNewOpen(false); rememberAgent(agent); onNew(agent); };

  // Rename seeds from the CUSTOM name only — never the derived default, which
  // would let a stray Enter freeze "chat 1 · 3f2a…" in as a real name. The
  // default shows as placeholder instead, so clearing the field reads as
  // "go back to that" and saves the empty string that means exactly it.
  const startEdit = () => {
    if (!selChat) return;
    settled.current = false;
    setDraft(selChat.name || '');
    setEditing(true);
    setOpen(false);
  };
  const finish = (save) => {
    if (settled.current) return;
    settled.current = true;
    setEditing(false);
    // selChat can vanish mid-edit (the chat was unlinked in another window), and
    // there is nothing left to name — drop the draft rather than write it onto
    // whichever chat happens to be selected next.
    if (save && selChat && draft.trim() !== (selChat.name || '')) onRename(selChat.sessionId, draft.trim());
  };

  return (
    <div className="issue-chat-switch" ref={ref}>
      <div className="issue-chat-menu-wrap">
        {/* The trigger opens the list; a rename pencil sits beside it so the pill
            reads label → edit it. Renaming swaps the label's slot for an input,
            leaving the badge in place so nothing shifts under the cursor. */}
        <div className="issue-chat-trigger">
          {editing ? (
            <>
              {selChat ? <AgentBadge agent={selChat.agent} /> : null}
              {selChat ? <RoleBadge role={selChat.role} /> : null}
              <input className="issue-chat-name-input" autoFocus value={draft}
                placeholder={selChat ? chatDefaultLabel(selChat, selIdx) : ''}
                aria-label="Chat name"
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => finish(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); finish(true); }
                  else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
                }} />
            </>
          ) : (
            <button className="issue-chat-trigger-main" onClick={() => setOpen(v => !v)}
              disabled={!chats.length} aria-haspopup="listbox" aria-expanded={open}>
              {selChat ? <AgentBadge agent={selChat.agent} /> : null}
              {selChat ? <RoleBadge role={selChat.role} /> : null}
              <span className="issue-chat-trigger-label">{triggerLabel}</span>
            </button>
          )}
          <button className="icon-btn issue-chat-rename" onClick={startEdit} disabled={!selChat || editing}
            title="Rename this chat" aria-label="Rename chat"><Pencil size={13} /></button>
          <button className="issue-chat-caret-btn" onClick={() => setOpen(v => !v)} disabled={!chats.length}
            aria-hidden="true" tabIndex={-1}>
            <svg className="issue-chat-caret" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
              <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        {open && chats.length > 0 ? (
          <ul className="issue-chat-menu" role="listbox">
            {chats.map((c, i) => (
              <li key={c.sessionId} className={`issue-chat-item${c.sessionId === selected ? ' is-current' : ''}`}>
                <button className="issue-chat-pick" disabled={!c.resumable}
                  onClick={() => { onSelect(c.sessionId); setOpen(false); }}>
                  <AgentBadge agent={c.agent} />
                  <RoleBadge role={c.role} />
                  <span className="issue-chat-pick-label">{chatLabel(c, i)}</span>
                </button>
                <CopyButton text={c.sessionId} title="Copy chat session id" />
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
      <ChatCopy sessionId={selected} />
      <div className="issue-chat-new-wrap" ref={newRef}>
        <button className="icon-btn issue-chat-new" onClick={() => setNewOpen(v => !v)} disabled={busy}
          title="New chat in this worktree" aria-label="New chat" aria-haspopup="menu" aria-expanded={newOpen}><Plus /></button>
        {newOpen ? <AgentMenu className="issue-chat-new-menu" onPick={pickNew} /> : null}
      </div>
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
  // The main chat connects without a session id — the PTY's `ready` names the
  // real one, surfaced here so the header can show a copyable address.
  const [sid, setSid] = useState(null);
  // Mirror the open main chat to my profile so the idle reaper (a separate
  // process) can see which main chat I have open and never stop it. Main chats
  // are machine-local and have no board row, so the profile is the only signal;
  // an issue's selection lives in its row's selected_session, which the reaper
  // already reads, so issues need no per-user write.
  useEffect(() => {
    if (!active || !sid) return;
    const email = userEmail();
    if (email) setSelectedChat(email, sid).catch(() => {});
  }, [active, sid]);
  return (
    <div className="issue-terminal-wrap">
      <div className="issue-terminal-bar">
        <span className="main-chat-label">main</span>
        <ChatCopy sessionId={sid} />
      </div>
      <ChatPane key="main" issueId="main" sessionId={null} mode={mode} active={active} onSession={setSid} />
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
  // Issue↔chat linking is many-to-many, but a session mounts ONE pane app-wide:
  // only the owning issue renders the ChatPane (socket + activity detector).
  // The visible pane takes the session over; hidden co-linkers wait their turn
  // (see session-pool.js). Activity still reaches every linked card via the
  // session-keyed store join, so dots don't depend on owning the pane.
  const owned = useSessionOwner(issueId, selected, active);

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

  // Auto-open a chat once chats are known. The issue's EXPLICIT selected_session
  // (shared, stored on the row) is the source of truth: it wins whenever it names
  // a resumable work chat — even a dormant one, because opening the card resumes
  // it. A never-selected issue falls back to the live work chat, then the most-
  // recently-linked one, and an ACTIVE first-open persists that pick so the choice
  // becomes explicit and the board can warm it thereafter. Reviewers are never
  // auto-opened. A chat is resumable wherever its transcript lives, so this
  // doesn't gate on state.worktree.
  useEffect(() => {
    if (state.loading || selected) return;
    const work = (state.chats || []).filter(c => c.resumable && c.role !== 'reviewer');
    if (!work.length) return;
    const explicit = state.selected_session && work.find(c => c.sessionId === state.selected_session);
    const pick = explicit || work.find(c => c.live) || work[work.length - 1];
    setSelected(pick.sessionId);
    setMode('resume');
    // Heal a never-selected issue to explicit on its first ACTIVE open (a real
    // open is a choice; a hidden pool mount is not, so it never persists).
    if (active && !state.selected_session) {
      updateChangeField(issueId, 'selected_session', pick.sessionId);
    }
  }, [state, selected, issueId, active]);

  // Select a chat to open. Persists the choice as the issue's explicit shared
  // selected_session for a WORK chat; a reviewer is shown locally but NEVER
  // persisted, so selection can't flip to a reviewer and the card keeps speaking
  // for the work chat.
  const selectChat = useCallback((sid) => {
    setSelected(sid);
    setMode('resume');
    const chat = (state.chats || []).find(c => c.sessionId === sid);
    if (chat && chat.role !== 'reviewer') updateChangeField(issueId, 'selected_session', sid);
  }, [issueId, state.chats]);

  // A convo pill in the detail view asked to open a specific chat. The nonce
  // re-fires the selection even when the same session is clicked again.
  useEffect(() => {
    if (requestSession?.sessionId) selectChat(requestSession.sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestSession?.nonce, requestSession?.sessionId]);

  // Create a worktree (if needed) + a new chat of the given agent. For codex the
  // server spawns eagerly and returns the id it minted; for claude it mints the
  // id up front. Either way `data.sessionId` is the chat to open.
  const createWorktreeAndChat = async (agent = lastAgent()) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/dash/terminal/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue: issueId, agent }),
      });
      const data = await r.json();
      if (!r.ok || data.error) { setError(data.error || 'create failed'); return; }
      // The server just wrote this issue's row (conversation link, port) on our
      // behalf — announce it like any local write so every view refetches.
      emitIssuesChange('UPDATE', { id: issueId });
      await refresh();
      setSelected(data.sessionId);
      setMode('new');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const newChat = async (agent) => {
    // Same endpoint as create — the worktree already exists, so it just mints a
    // new linked session of the chosen agent.
    await createWorktreeAndChat(agent);
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
      // Server-mediated row write (conversation unlink) — announce it too. The
      // server clears a now-dangling selected_session authoritatively (see the
      // DELETE handler), so the refresh below reflects the fallback with no second
      // write here.
      emitIssuesChange('UPDATE', { id: issueId });
      if (selected === sessionId) setSelected(null); // auto-open picks the next
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  // Name (or un-name) a chat. An empty name clears back to the derived default.
  // The server answers with the issue's whole name map, so the switcher repaints
  // from the write itself — no refetch, no window where the old label lingers.
  const renameChat = async (sessionId, name) => {
    setError(null);
    try {
      const r = await fetch('/api/dash/terminal/chat-name', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue: issueId, session: sessionId, name }),
      });
      const data = await r.json();
      if (!r.ok || data.error) { setError(data.error || 'rename failed'); return; }
      setState(s => ({ ...s, chats: (s.chats || []).map(c => ({ ...c, name: data.names[c.sessionId] || null })) }));
      // An issue's names live on its board row — announce the write like any
      // other so the rest of the app refetches.
      emitIssuesChange('UPDATE', { id: issueId });
    } catch (e) {
      setError(String(e));
    }
  };

  // An issue's chat list AND its chat names both live on the board row, so any
  // issues-change signal is a reason to re-read them: that's how a rename (or a
  // link) made in another window — or by an agent through the CLI — lands here
  // without a refresh.
  useEffect(() => {
    if (local !== true || !issueId) return;
    return subscribeIssues(({ record }) => {
      if (record?.id && record.id !== issueId) return; // another card's write
      refresh();
    });
  }, [local, issueId, refresh]);

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
            chat inside it — pick the agent:
          </p>
          <div className="issue-empty-agents">
            {AGENTS.map(a => (
              <button key={a.id} className={`issue-empty-btn issue-empty-btn-${a.id}`}
                onClick={() => { rememberAgent(a.id); createWorktreeAndChat(a.id); }} disabled={busy}>
                <AgentBadge agent={a.id} />
                <span>{busy ? 'Creating…' : a.label}</span>
              </button>
            ))}
          </div>
          {error && <p className="issue-empty-err">{error}</p>}
        </div>
      </div>
    );
  }

  const selectedChat = (state.chats || []).find(c => c.sessionId === selected);

  return (
    <div className="issue-terminal-wrap">
      <div className="issue-terminal-bar">
        <ChatSwitcher
          chats={state.chats || []}
          selected={selected}
          onSelect={selectChat}
          onNew={newChat}
          onUnlink={unlinkChat}
          onRename={renameChat}
          busy={busy}
        />
      </div>
      {error && <p className="issue-empty-err">{error}</p>}
      {/* Exactly ONE pane per issue: its selected chat. When this env is VISIBLE
          the user asked for it, so it mounts (resuming a dormant chat if need be);
          when HIDDEN (the board pool) it mounts only if the chat is already LIVE,
          never cold-spawning claude on board load. The needs-input dot therefore
          reflects the selected chat alone — a reviewer or a second work chat never
          flags the card. */}
      {selected && owned && (active || selectedChat?.live) && (
        <ChatPane key={selected} issueId={issueId} sessionId={selected} mode={mode} active={active}
          agent={selectedChat?.agent || DEFAULT_AGENT} />
      )}
    </div>
  );
}
