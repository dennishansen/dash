import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { getTheme, onThemeChange, XTERM_THEMES } from '../theme.js';
import { useLocalBackend } from '../capabilities.js';
import { Plus, X, Pencil, NAV_ICON } from '../icons.jsx';
import { AgentBadge } from '../AgentBadge.jsx';
import { viewportText } from '../spinner.js';
import { agentById, agentChoices, DEFAULT_AGENT } from '../agents.js';
import { setSelectedChat } from '../../server/profiles-store.mjs';
import { userEmail } from '../auth.js';
import { useSessionOwner } from '../session-pool.js';
import { acquireWebgl, releaseWebgl } from './term-renderer.js';
import { CopyButton } from './CopyButton.jsx';
import { Avatar, useMyProfile, useRosterSettled } from '../profiles.jsx';
import { PaneEmpty, PaneEmptyButton } from '../PaneEmpty.jsx';
import { ChatTranscript } from './ChatTranscript.jsx';
import { mirroredChats } from '../../server/chat-mirror.mjs';
import { emitIssuesChange, subscribeIssues, subscribeChats } from '../realtime.js';
import { getTerminalToken } from '../terminal-token.js';
import { useChatStatus, useIssues } from '../api.js';
import { setEnvSession } from '../chat-session-store.js';
import { updateChangeField, listChanges } from '../board-store.js';
import { chatDefaultLabel, chatLabel, chatElsewhere, mergeChats, orderChats } from '../chat-list.js';

const AGENTS = agentChoices();
const LAST_AGENT_KEY = 'dash-chat-agent';

// Which agent CLIs this computer can actually run. Fetched ONCE per page and
// held in module scope: it answers a question about the machine, not about any
// one issue, and every picker on every card asks it. Null until the first fetch
// resolves — every consumer treats "not known yet" as available, so a slow probe
// never makes a working agent look broken.
let agentAvail = null;
const agentAvailListeners = new Set();
let agentAvailFetch = null;
function loadAgentAvailability() {
  if (!agentAvailFetch) {
    agentAvailFetch = fetch('/api/dash/terminal/agents')
      .then(r => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.agents) {
          agentAvail = Object.fromEntries(data.agents.map(a => [a.id, a]));
          for (const fn of agentAvailListeners) fn();
        }
      })
      .catch(() => { /* no local backend — the pane's own guard covers it */ });
  }
  return agentAvailFetch;
}
function useAgentAvailability() {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump(n => n + 1);
    agentAvailListeners.add(fn);
    loadAgentAvailability();
    return () => agentAvailListeners.delete(fn);
  }, []);
  // Unknown ⇒ treat as available: an agent that IS installed must never render
  // as missing just because the probe hasn't answered yet.
  return (id) => (agentAvail ? agentAvail[id] : null) || { id, available: true };
}
const lastAgent = () => {
  try { const v = localStorage.getItem(LAST_AGENT_KEY); return AGENTS.some(a => a.id === v) ? v : DEFAULT_AGENT; }
  catch { return DEFAULT_AGENT; }
};
const rememberAgent = (id) => { try { localStorage.setItem(LAST_AGENT_KEY, id); } catch {} };

// The switcher's lead slot. In the trigger it holds a chevron — pure decoration
// that says "there is a list under this"; in a list row the same slot holds the
// unlink, or nothing at all. One column, so a row and the trigger line up glyph
// for glyph.
const CHEVRON = (
  <span className="issue-chat-lead" aria-hidden="true">
    <svg width="10" height="6" viewBox="0 0 10 6">
      <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  </span>
);

// A ROLE pill shown ALONGSIDE the agent badge. A reviewer chat is still a
// claude/codex CLI, so its role reads as an extra tag next to the agent, not a
// swap — and it's what makes a reviewer read distinctly in the switcher (it's
// never the default selection and never dots the card).
function RoleBadge({ role }) {
  if (!role) return null;
  return <span className={`agent-badge role-badge role-badge-${role}`} title={`${role} chat`}>{role}</span>;
}

// Claude Code auto-compacts BEFORE the window is 100% full. The trigger is its
// documented default ~83.5% of the context window (anthropics/claude-code#31806),
// lowerable via CLAUDE_AUTOCOMPACT_PCT_OVERRIDE. The statusline publishes the live
// threshold (and whether it's the exact override or the est. default); codex chats
// report their own compactAt the same way (90 — codex's window*9/10 default). So
// the gauge tracks each CLI's real number instead of guessing — the arc still fills
// to a true 100% at raw-full, and goes red once only the compaction buffer remains.
// `used` is null before the first message and right after /compact; the ring shows
// a neutral "no data yet" state then, never a false 0%.
const COMPACT_DEFAULT = 83.5; // Claude Code's default auto-compact point (%)

// The context-window gauge that replaced the terminal status bar.
function ContextRing({ used, compactAt = COMPACT_DEFAULT, compactExact = false }) {
  const r = 6;
  const circ = 2 * Math.PI * r;
  // No live number yet (before the first message / just after /compact): a
  // neutral ring with no arc, so the gauge reads "waiting" instead of false-empty.
  if (used == null) {
    return (
      <span className="ctx-ring ctx-ring--idle" tabIndex={0} aria-label="context usage: no data yet">
        <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
          <circle className="ctx-ring-track" cx="7.5" cy="7.5" r={r} fill="none" strokeWidth="2" />
        </svg>
        <span className="ctx-ring-pop" role="tooltip">no data yet</span>
      </span>
    );
  }
  const pct = Math.max(0, Math.min(100, Math.round(used)));
  const level = pct >= compactAt ? 'crit' : pct >= 70 ? 'warn' : 'ok';
  const toCompact = Math.max(0, Math.round(compactAt - pct));
  const offset = circ * (1 - pct / 100);
  const tilde = compactExact ? '' : '~';
  return (
    <span className={`ctx-ring ctx-ring--${level}`} tabIndex={0}
      aria-label={toCompact > 0 ? `${compactExact ? '' : 'about '}${toCompact}% until auto-compaction` : 'auto-compaction imminent'}>
      <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
        <circle className="ctx-ring-track" cx="7.5" cy="7.5" r={r} fill="none" strokeWidth="2" />
        <circle className="ctx-ring-arc" cx="7.5" cy="7.5" r={r} fill="none" strokeWidth="2"
          strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
          transform="rotate(-90 7.5 7.5)" />
      </svg>
      <span className="ctx-ring-pop" role="tooltip">
        {toCompact > 0 ? <><strong>{tilde}{toCompact}%</strong> to compaction</> : <strong>compacting soon</strong>}
      </span>
    </span>
  );
}

// The choice popover shared by the "+" button and the empty state: one row per
// agent. Selecting fires onPick(agentId). Absolute-positioned; the caller owns
// the open/close and outside-click.
function AgentMenu({ onPick, className = '' }) {
  const availability = useAgentAvailability();
  return (
    <ul className={`agent-menu ${className}`} role="menu">
      {AGENTS.map(a => {
        // An agent whose CLI isn't on this computer is shown but not pickable —
        // visibly unavailable BEFORE the click, instead of failing at spawn.
        const av = availability(a.id);
        return (
          <li key={a.id} role="none">
            <button role="menuitem" className={`agent-menu-item agent-menu-item-${a.id}`}
              disabled={!av.available}
              title={av.available ? undefined : `${a.label} isn't installed on this computer`}
              onClick={() => onPick(a.id)}>
              <AgentBadge agent={a.id} />
              <span className="agent-menu-label">{a.label}</span>
              {av.available ? null : <span className="agent-menu-missing">not installed</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// Does this chat get the READER instead of a terminal? Phrased as the five
// things we positively KNOW rule out running it here, never as "is it
// resumable" — a chat minted seconds ago is not resumable either (its agent has
// not written a transcript yet) and it very much wants a terminal. Getting that
// backwards is what once blanked the pane for every brand-new chat.
//
//   1. there is no dash on this computer at all (the deployed board)
//   2. it is a Cursor chat — an editor writes it, nothing can drive it
//   3. it was created on another computer (the recorded stamp, nothing softer)
//   4. its workspace was collected, so there is nowhere to run it UNTIL someone
//      asks for that workspace back (the offer below)
//   5. this computer no longer has it, but the shared copy does — so reading
//      succeeds where attaching would certainly fail
//
// Anything else keeps the old behaviour: the pane mounts and the socket reports
// honestly.
function readOnlyHere(chat, machine, local, mode) {
  if (local !== true) return true;
  if (!chat) return false;
  // A chat being CREATED here runs here by definition — it has no transcript
  // yet and (since rows register at creation) is already readable, so the
  // readable-but-not-resumable rule below would misread it as someone else's.
  if (mode === 'new') return false;
  if (chat.agent === 'cursor') return true;
  if (chatElsewhere(chat, machine)) return true;
  if (chat.restorable) return true;
  return !!chat.readable && !chat.resumable && !chat.live;
}

// The way back from read-only. A chat that is `restorable` is not stranded: its
// workspace was a git worktree, and the dash can build that again at the exact
// path this chat ran in — after which it takes keystrokes like any other chat.
//
// Deliberately an OFFER, not something that happens when you open the card.
// Rebuilding a checkout is seconds of git and a dev-server port; the person
// asks for it, and reads the conversation meanwhile. Same shape and the same
// sentence as the app pane's "No dev environment yet" — one system, two doors
// into it, rather than two ideas that resemble each other.
function RestoreOffer({ issueId, onRestore }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try { await onRestore(); } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };
  return (
    <div className="chat-restore">
      <div className="chat-restore-say">
        <p className="chat-restore-title">This chat’s dev environment was collected</p>
        <p>
          Its git worktree is gone, so there is nowhere for it to run — but it can be
          rebuilt for <code>{issueId}</code>, and the chat picks up where it left off.
        </p>
      </div>
      <div className="chat-restore-do">
        <PaneEmptyButton onClick={go} disabled={busy}>
          {busy ? 'Rebuilding…' : 'Create dev env & reopen chat'}
        </PaneEmptyButton>
        {err ? <p className="pane-empty-err">{err}</p> : null}
      </div>
    </div>
  );
}


// "This agent isn't on this computer" — as an empty state, not an error. Says
// which CLI, how to install it, and where the docs are. The dash never installs
// anything; this is guidance.
function AgentMissing({ agents, title, children }) {
  const list = agents.filter(a => a?.install);
  return (
    <PaneEmpty title={title}>
      {children}
      {list.map(a => (
        <p key={a.install.name} className="pane-empty-install">
          <span className="pane-empty-install-name">{a.install.name}</span>
          <code>{a.install.command}</code>
          {a.install.url ? <a href={a.install.url} target="_blank" rel="noreferrer">Installation docs ↗</a> : null}
        </p>
      ))}
      <p className="pane-empty-agent-missing">Nothing is installed for you — run the command yourself, then reopen this.</p>
    </PaneEmpty>
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
//
// It reads xterm's BUFFER, which is the only renderer-independent answer: with
// the WebGL renderer attached xterm paints to a canvas and .xterm-rows is
// empty, so a test that scrapes the DOM is really asserting "this machine has
// no WebGL2" — true of headless chromium on macOS, false on Linux.
//
// Called with no session id it returns every live terminal's viewport joined,
// for the callers that want "did this land anywhere on screen" and have no
// business knowing which chat the ambient main pane happens to be showing.
const liveTerms = new Map();
if (typeof window !== 'undefined') {
  window.__dashViewport = (sessionId) => {
    if (sessionId === undefined) return [...liveTerms.values()].map(viewportText).join('\n');
    const t = liveTerms.get(sessionId);
    return t ? viewportText(t) : null;
  };
}

// One live xterm wired to one chat's PTY (issue + session id). Re-mounted (via
// React key) whenever the selected session changes, so teardown/reattach is clean.
// The terminal speaks for itself (cursor, output, an inline "[chat exited]"
// notice) — no separate connection-status text in the bar.
function ChatPane({ issueId, sessionId, mode, active, agent, onFatal }) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const webglRef = useRef(null);
  const resizeRef = useRef(null); // calls the live pane's sendResize (set on mount)
  // Every chat is id-addressed now — main included. `isMain` survives only to
  // keep the main chat hands-off of keyboard focus (so the board keeps the arrow
  // keys); it no longer changes how the pane connects.
  const isMain = issueId === 'main';

  useEffect(() => {
    if (!issueId || !sessionId || !hostRef.current) return;

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
    const termKey = `${issueId}:${sessionId}`;
    (window.__dashTerms ??= new Map()).set(termKey, term);
    liveTerms.set(sessionId, term);
    const offTheme = onThemeChange((t) => { term.options.theme = XTERM_THEMES[t]; });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    // GPU renderer is attached lazily, only while this pane is VISIBLE — see the
    // active-gated effect below. A WebGL context is a scarce GPU resource
    // (browsers cap ~16); now that board-load attaches every in-progress chat
    // into a hidden pool, handing each hidden terminal a context would starve
    // the one the user is actually looking at. Hidden panes never paint, so they
    // need no accelerator. Visible panes get WebGL for Claude's heavy TUI
    // redraws; only a client with no WebGL2 at all falls back to the DOM
    // renderer (see term-renderer.js) — slower under TUI floods, but alive.
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
    // Every PTY lives in the one supervisor, reached through whichever edge
    // serves this page — the multi-dash redirect dance died with the fleet.
    const wsHost = location.host;
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
    // with our own codes: 1000 (deliberate close — the chat lives
    // in another dash server) and 1011 (refusals: not resumable, claim
    // refused). Reconnecting on those would chase a server that just told us
    // where (or why not) to attach. A socket that dies WITHOUT one of those
    // frames (1006 abnormal, or anything else) is the freeze condition, and
    // reconnecting is always safe: the server just reattaches — multi-attach
    // means joining alongside any other pane, never stealing from it.
    let ws = null;
    let disposed = false;
    let exited = false;    // PTY is gone — reconnecting would resurrect claude
    let ready = false;     // this socket got an answer
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
      // prompt — /main for a new main chat, the issue brief for an issue chat);
      // every reconnect is a plain reattach — re-sending a spawning mode could
      // double-run the first turn.
      const wireMode = everReady ? 'resume' : (mode || 'resume');
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

      // Nothing is derived from this stream — working/idle is the supervisor's
      // answer now (server/chat-activity.mjs), read from the PTY it owns. Just
      // write the bytes through.
      ws.onopen = () => { retryDelay = 300; };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'ready') {
          ready = true; // the server answered — a later close is teardown
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
          // A chat that couldn't start because its CLI isn't installed is not an
          // exit to print — it's a state to explain. The server types that case
          // (reason:'agent-missing', never a text match), so the pane hands it up
          // for the guidance empty state instead of writing `spawn … ENOENT` into
          // a terminal at someone who has no way to read it.
          if (msg.reason === 'agent-missing') { onFatal?.({ reason: msg.reason, agent: msg.agent, install: msg.install }); return; }
          term.write(`\r\n\x1b[2m[chat exited${msg.code != null ? ` (${msg.code})` : ''}${msg.error ? ` — ${msg.error}` : ''}]\x1b[0m\r\n`);
        }
      };

      ws.onclose = (ev) => {
        if (disposed) return;
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
  }, [issueId, sessionId, mode, agent]);

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
  }, [active, issueId, sessionId, mode]);

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

  // Working / needs-input detection is NOT here. The supervisor owns the PTYs
  // and runs one detector per chat for its whole life
  // (server/chat-activity.mjs), so the dot no longer restarts when a pane
  // mounts, unmounts or hands the session to another pane — and two viewers of
  // the same board see the same dots. This pane just renders the terminal.

  return (
    <div className="issue-terminal">
      <div className="issue-terminal-host" ref={hostRef} />
    </div>
  );
}

// Copy icon for the open chat's session id — the address other agents use to
// message this chat (agent-chat). Icon-only; the tooltip carries the short id.
function ChatCopy({ sessionId }) {
  if (!sessionId) return null;
  return <CopyButton text={sessionId} title={`Copy chat session id (${sessionId.slice(0, 8)})`} />;
}

// Custom chat dropdown (a native <select> can't carry a per-row unlink button).
// Trigger shows the open chat; the menu lists every chat with a select target
// and an × to unlink it from the issue. Every chat that can be RUN or READ is
// pickable — which is now nearly all of them, since a chat this computer cannot
// run still opens its transcript.
// `local` is whether this computer can act on the list at all. Reading a chat
// needs nothing; making, naming and unlinking one all go through the local dash,
// so on a board without one they are absent rather than broken.
function ChatSwitcher({ chats, selected, onSelect, onNew, onUnlink, onRename, busy, local, machine }) {
  const [open, setOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false); // the "+" agent-choice popover
  const [confirmId, setConfirmId] = useState(null); // chat awaiting unlink confirm
  const [editingId, setEditingId] = useState(null); // sessionId being renamed inline
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
  useEffect(() => { settled.current = true; setEditingId(null); }, [selected]);

  const selChat = chats.find(c => c.sessionId === selected) || null;
  const triggerLabel = chats.length === 0 ? 'no chats'
    : selChat ? chatLabel(selChat, machine)
    : `${chats.length} chats`;

  const pickNew = (agent) => { setNewOpen(false); rememberAgent(agent); onNew(agent); };
  const status = useChatStatus(selected);
  const toggle = () => setOpen(v => !v);

  // Rename seeds from the CUSTOM name only — never the chat's number, which a
  // stray Enter would freeze in as a real name. The number shows as placeholder
  // instead, so clearing the field reads as "go back to that" and saves the
  // empty string that means exactly it.
  // Renaming is keyed to a CHAT, not to "the open one" — the switcher's rows
  // carry their own pencil, so any chat in the list can be named where it is
  // read without first being opened.
  const editChat = editingId ? chats.find(c => c.sessionId === editingId) || null : null;
  const startEdit = (c) => {
    if (!c) return;
    settled.current = false;
    setDraft(c.name || '');
    setEditingId(c.sessionId);
  };
  const finish = (save) => {
    if (settled.current) return;
    settled.current = true;
    const target = editChat;
    setEditingId(null);
    // The chat can vanish mid-edit (unlinked in another window), and there is
    // nothing left to name — drop the draft rather than write it onto whichever
    // chat happens to be selected next.
    if (save && target && draft.trim() !== (target.name || '')) onRename(target.sessionId, draft.trim());
  };
  // The field is the same control wherever it appears: seeded from the CUSTOM
  // name only — never the chat's number, which a stray Enter would freeze in as
  // a real name. The number shows as placeholder, so clearing the field reads as
  // "go back to that".
  const nameField = (c) => (
    <input className="issue-chat-name-input" autoFocus value={draft}
      placeholder={chatDefaultLabel(c)}
      aria-label="Chat name"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      }} />
  );
  // The pencil, wherever it sits. Renaming needs the dash on the machine the
  // chat runs on, so it says why when it can't.
  const renameBtn = (c) => (
    <button className="icon-btn issue-chat-rename" onClick={() => startEdit(c)}
      disabled={!c || editingId === c?.sessionId || !local}
      title={local ? 'Rename this chat' : 'Renaming needs the dash on the computer this chat runs on'}
      aria-label="Rename chat"><Pencil size={NAV_ICON} /></button>
  );

  return (
    <div className="issue-chat-switch" ref={ref}>
      <div className="issue-chat-menu-wrap">
        {/* The trigger and every list row are the SAME cell: a lead-in slot,
            the name, then rename · copy · rule · ring · agent · owner. The
            trigger's lead-in is empty (the whole cell opens the list, so a
            chevron would be a second target for one job); a row's holds its
            unlink. Hovering anywhere lights the cell; the glyphs stack their
            own highlight on top. */}
        <div className="issue-chat-trigger">
          {editingId === selected && selChat ? (
            /* The field takes the LABEL's slot only, so renaming happens where
               the name is read and nothing else in the cell shifts under the
               cursor. */
            <>
              {CHEVRON}
              <RoleBadge role={selChat.role} />
              {nameField(selChat)}
            </>
          ) : (
            <button className="issue-chat-trigger-main" onClick={toggle}
              disabled={!chats.length} aria-haspopup="listbox" aria-expanded={open}>
              {/* Decoration, INSIDE the one target rather than beside it — it
                  says "this opens", and clicking it opens, without being a
                  second thing to hit. */}
              {CHEVRON}
              {selChat ? <RoleBadge role={selChat.role} /> : null}
              <span className="issue-chat-trigger-label">{triggerLabel}</span>
            </button>
          )}
          {renameBtn(selChat)}
          <ChatCopy sessionId={selected} />
          {/* What you can DO to this chat, then a rule, then what it IS — how
              full it is, which agent runs it, whose it is. */}
          <span className="issue-chat-sep" aria-hidden="true" />
          <ContextRing used={status ? status.used : null}
            compactAt={status?.compactAt} compactExact={status?.compactExact} />
          {selChat ? <AgentBadge agent={selChat.agent} /> : null}
          {selChat ? <Avatar email={selChat.owner} size={20} /> : null}
        </div>
        {open && chats.length > 0 ? (
          <ul className="issue-chat-menu" role="listbox">
            {/* Most recently active first, and NOTHING else — what every chat
                list does, and the honest version of "the one you want is
                probably on top". Being live is not a rank: a chat left open
                since yesterday is not more recent than the one you spoke in a
                minute ago, and it used to outrank it. Ties (two chats that have
                never run) break to the most recently linked. Each row's number
                is stored on the chat, so reordering renumbers nothing. */}
            {orderChats(chats).map(({ c }) => {
              const away = chatElsewhere(c, machine);
              return (
              <li key={c.sessionId} className={`issue-chat-item${c.sessionId === selected ? ' is-current' : ''}${away ? ' is-away' : ''}`}>
                {/* Unlink drops a chat's LINK to the issue, and it leads the row
                    because that is where the trigger's lead-in sits — the two
                    cells line up glyph for glyph. A Cursor chat has no link (it
                    reached the board through the folder it ran in), so it gets
                    the empty slot instead of a button that would do nothing. */}
                {c.agent === 'cursor' || !local ? <span className="issue-chat-lead" /> : confirmId === c.sessionId ? (
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
                {editingId === c.sessionId ? (
                  <>
                    <RoleBadge role={c.role} />
                    {nameField(c)}
                  </>
                ) : (
                  /* Every chat is pickable — one on a teammate's computer, one
                     written by an editor, one this machine has never seen.
                     Picking a chat it cannot RUN opens the transcript instead,
                     which beats a disabled row saying "unavailable". */
                  <button className="issue-chat-pick" disabled={!c.resumable && !c.readable && !c.restorable && !away}
                    title={away ? `on ${away.host}` : undefined}
                    onClick={() => { onSelect(c.sessionId); setOpen(false); }}>
                    <RoleBadge role={c.role} />
                    <span className="issue-chat-pick-label">{chatLabel(c, machine)}</span>
                    {/* No machine-name chip — the avatar already says whose chat
                        it is, and opening it makes plain it's read-only. The host
                        is left in the hover title for anyone who wants it. */}
                  </button>
                )}
                {renameBtn(c)}
                <CopyButton text={c.sessionId} title="Copy chat session id" />
                <span className="issue-chat-sep" aria-hidden="true" />
                {/* Only the OPEN chat reports how full it is — a row shows the
                    ring's own "no data yet" state rather than a number it would
                    have to invent. */}
                <ContextRing used={null} />
                <AgentBadge agent={c.agent} />
                <Avatar email={c.owner} size={20} />
              </li>
              );
            })}
          </ul>
        ) : null}
      </div>
      {/* Starting a chat needs an agent CLI and a worktree, both of which live
          on a real computer — so on a board with no dash behind it the "+" is
          absent rather than offered and then failed. */}
      {local ? (
        <div className="issue-chat-new-wrap" ref={newRef}>
          <button className="icon-btn issue-chat-new" onClick={() => setNewOpen(v => !v)} disabled={busy}
            title="New chat" aria-label="New chat" aria-haspopup="menu" aria-expanded={newOpen}><Plus size={NAV_ICON} /></button>
          {newOpen ? <AgentMenu className="issue-chat-new-menu" onPick={pickNew} /> : null}
        </div>
      ) : null}
    </div>
  );
}

// One dev environment's chats in the right sidebar — an ISSUE (its worktree) or
// MAIN (the repo root). Fetches the env's tracked chats, drives the empty-state →
// open → switch flow, and renders the active ChatPane under a shared ChatSwitcher.
// The main chat is not special: it is this component with issueId='main', so it
// gets the same switcher, history, +new, per-chat unlink, context ring and copy.
// The only env-specific behavior is the empty state — an issue offers to create a
// worktree; main always has a workspace (the repo root) and an always-present
// thread, which the SERVER guarantees (POST /terminal/main-chat, idempotent) so
// that opening main twice can never produce two of them.
export function ChatEnvironment({ issueId, requestSession, active }) {
  const isMain = issueId === 'main';
  // Worktrees + the agent PTY live on the machine running the dev server — there
  // is no terminal backend on Vercel (this holds for main too: its chats run in
  // THIS machine's repo root). That still bounds what can RUN here. It no longer
  // bounds what can be READ: the mirrored corpus is fetched straight from shared
  // storage, so a board with no backend at all still shows every chat and every
  // word of it — read-only, which is what it always was for a non-owner.
  const local = useLocalBackend();
  const [state, setState] = useState({ loading: true });
  // The READABLE half of the list, from the shared corpus. Null until the first
  // fetch settles, so "no mirrored chats" and "not asked yet" stay distinct.
  const [mirror, setMirror] = useState(null);
  // TWO selection concepts, deliberately distinct:
  //   • `selected` (this local state) — the chat THIS view is showing. Sticky and
  //     user-driven: it can be a reviewer you clicked to PEEK at, and an external
  //     selected_session change never yanks it (that surprise-flip is exactly what
  //     this issue removed). It's what the pane mounts.
  //   • the issue's shared `selected_session` — the NEXT-OPEN DEFAULT and the
  //     board-warm signal: which chat a fresh open lands on and the board seeds.
  //     Reviewers never write it, so a fresh open / the board never pick a reviewer.
  // Switching to a work chat writes both; peeking at a reviewer moves only `selected`.
  const [selected, setSelected] = useState(null);
  // Which turn to open a transcript AT, when the open came from a search hit.
  // Cleared whenever the person picks a different chat — the index belongs to
  // the hit, not to the pane.
  const [focusIdx, setFocusIdx] = useState(null);
  const [mode, setMode] = useState('resume'); // 'new' for a just-minted chat
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Issue↔chat linking is many-to-many, but a session mounts ONE pane app-wide:
  // only the owning issue renders the ChatPane (its WebSocket). The visible pane
  // takes the session over; hidden co-linkers wait their turn (see
  // session-pool.js). Dots are unaffected either way — they come from the
  // supervisor now, not from whoever holds the pane.
  const owned = useSessionOwner(issueId, selected, active);
  // Which agent CLIs this computer has — the empty state offers only what can
  // actually run, and says why for the rest.
  const agentAvailability = useAgentAvailability();
  // A structured "this can't work here, and here's why" — currently only the
  // agent-CLI-missing case. Distinct from `error` (a sentence to show inline):
  // this REPLACES the pane with guidance.
  const [fatal, setFatal] = useState(null);

  const refresh = useCallback(async () => {
    if (!issueId) return;
    try {
      const r = await fetch(`/api/dash/terminal/chats?issue=${encodeURIComponent(issueId)}`);
      // A backend that answers with something that ISN'T JSON is a backend that
      // has gone away — a dev server restarting, a deploy the probe caught mid-
      // flight. That is "nothing runs here", the state the reader already
      // handles, and it must not surface as a raw parser error over a
      // transcript the person can perfectly well read.
      if (!(r.headers.get('content-type') || '').includes('json')) {
        setState({ loading: false, worktree: false, chats: [] });
        return null;
      }
      const data = await r.json();
      setState({ loading: false, ...data });
      return data;
    } catch (e) {
      setState({ loading: false, worktree: false, chats: [] });
      setError(String(e));
    }
  }, [issueId]);

  // The env's mirrored chats — fetched whether or not there is a backend here,
  // because that is the whole point of the mirror. Re-read on every issues
  // change too: a chat linked (or renamed) elsewhere shows up without a refresh,
  // the same way the local list already does.
  const refreshMirror = useCallback(async () => {
    if (!issueId) return;
    try { setMirror(await mirroredChats(issueId)); } catch { setMirror([]); }
  }, [issueId]);

  // Reset + load whenever the issue changes. The LOCAL list needs a backend; the
  // mirrored one never does.
  //
  // While the backend probe is STILL RUNNING (`local === null`) the state stays
  // `loading` — "we haven't asked yet" is not "we asked and there is nothing".
  // Collapsing the two wrote an authoritative-looking empty list on the first
  // frame of every page load, and whoever read it next believed it.
  useEffect(() => {
    setSelected(null);
    setMode('resume');
    setError(null);
    setFatal(null);
    setMirror(null);
    refreshMirror();
    if (local === null) { setState({ loading: true }); return; }
    if (local === false) { setState({ loading: false, worktree: false, chats: [] }); return; }
    setState({ loading: true });
    refresh();
  }, [issueId, refresh, refreshMirror, local]);

  // Which chat this issue OPENS ON, and what its chats are CALLED, are both
  // shared facts stored on the row — so they have to survive not having a local
  // dash to ask. The board's own cache carries the row (both ride in LIST_COLS),
  // which is the same row the local API would have read; asking it directly is
  // what makes a remote reader land on the chat the issue actually speaks through
  // rather than on whichever synced last, and see the chats by name and number
  // rather than by handle.
  const { data: boardRows } = useIssues('changes', listChanges, { pollMs: 0 });
  const boardRow = isMain ? null : (boardRows ?? []).find(i => i.id === issueId) ?? null;
  // The env's chats: what can run here, plus what can be read from anywhere.
  const chats = useMemo(() => mergeChats(state.chats, mirror, boardRow?.chat_meta),
    [state.chats, mirror, boardRow?.chat_meta]);
  // MAIN's saved chat is my profile row's selected_chat — same DB-is-the-source
  // rule as an issue's selected_session, just keyed to the person, not a card.
  const { profile: myProfile } = useMyProfile();
  const rosterKnown = useRosterSettled();
  const sharedSelection = state.selected_session ?? boardRow?.selected_session ?? null;
  // A chat that can run HERE must never wait on the shared copy. The local list
  // is a same-machine read; the mirror is a network round-trip, and gating the
  // pane on it delayed every terminal mount by that trip — enough to break the
  // attach/ownership timing the session pool depends on.
  //
  // So the spinner waits for the mirror only when the mirror is the ONLY source
  // there is. What the mirror genuinely gates is the empty state below: an issue
  // whose chats all live elsewhere must not flash "create a worktree" before its
  // readable chats arrive.
  const loading = state.loading || (local !== true && mirror === null);
  const mirrorSettled = mirror !== null;

  // Auto-open a chat once chats are known. The issue's EXPLICIT selected_session
  // (shared, stored on the row) is the source of truth: it wins whenever it names
  // a resumable work chat — even a dormant one, because opening the card resumes
  // it. A never-selected issue falls back to the live work chat, then to the TOP
  // OF THE LIST — the most recently active openable chat, in the same order the
  // switcher shows, so the card opens on the row you would have clicked. (It used
  // to take the LAST element of the merged array, which meant whatever that
  // array's order happened to encode; when the list stopped being a first_turn_at
  // timeline that quietly became "the stalest chat the mirror knows" for a board
  // with no dash behind it, since the corpus answers most-recently-active first.)
  // An ACTIVE first-open persists the pick so the choice becomes explicit and the
  // board can warm it thereafter. Reviewers are never
  // auto-opened. Main has no shared row — its selection is per-browser.
  // A chat is resumable wherever its transcript lives, so this doesn't gate on
  // state.worktree.
  //
  // A chat that can only be READ counts as openable, and is the fallback: an
  // issue whose chats all belong to a teammate opens on one and shows the
  // transcript, rather than sitting blank. A chat that can actually RUN here is
  // always preferred, so this never trades a working terminal for a reader.
  //
  // So does a chat whose workspace was collected — it is one click from running
  // here, and the card that opens on it is where that click lives. Without it a
  // merged issue whose only chat never reached the shared corpus would open on
  // nothing at all, which is the blank pane this fallback exists to prevent.
  useEffect(() => {
    if (loading || selected) return;
    const notReviewer = chats.filter(c => c.role !== 'reviewer');
    const work = notReviewer.filter(c => c.resumable);
    const readable = notReviewer.filter(c => c.readable || c.restorable || chatElsewhere(c, state.machine));
    const openable = work.length ? work : readable;
    if (!openable.length) return;
    const explicitId = isMain ? (myProfile?.selected_chat ?? null) : sharedSelection;
    // An explicit choice may name a read-only chat even when a local one exists —
    // the person picked it, so honour it.
    const explicit = explicitId && [...work, ...readable].find(c => c.sessionId === explicitId);
    // A stand-in must never displace an explicit choice. Three sources answer
    // in STAGES — the local list, the mirror's round-trip, and (for a remote
    // reader) the board-rows cache that carries selected_session — and picking
    // "some other chat" from a partial picture is exactly the flaky-selection
    // bug: the persist effect below then cements the stand-in as the new
    // explicit choice. So wait: while the preference could still be unknown, or
    // is named but not yet listed, hold off — only a settled picture can prove
    // a preference is truly absent or gone.
    const preferenceKnown = isMain ? rosterKnown : (state.selected_session != null || boardRows != null);
    if (!preferenceKnown) return;
    if (explicitId && !explicit && (state.loading || !mirrorSettled)) return;
    // MAIN with a backend keeps an always-present RUNNABLE thread (the ensure
    // below guarantees one is coming, existing or created) — never settle its
    // pane on a read-only mirror row that happened to load first. Reader-only
    // main opens remain the no-backend board's case.
    if (isMain && local === true && !work.length) return;
    const pick = explicit || openable.find(c => c.live) || orderChats(openable)[0].c;
    setSelected(pick.sessionId);
    setMode('resume');
    // Heal a never-selected issue to explicit on its first ACTIVE open (a real
    // open is a choice; a hidden pool mount is not, so it never persists). Only
    // a chat that RUNS here is worth persisting as the shared default — a reader
    // picking a teammate's chat must not retarget everyone's next open.
    if (!isMain && active && !sharedSelection && pick.resumable) {
      updateChangeField(issueId, 'selected_session', pick.sessionId);
    }
  }, [chats, loading, selected, issueId, isMain, active, local, state.machine, sharedSelection, state.loading, state.selected_session, mirrorSettled, boardRows, myProfile, rosterKnown]);

  // Publish the open chat to the code pane (its LOC badge tracks the same chat —
  // chat-session-store is the seam). MAIN's choice lives in my PROFILE row —
  // the same DB-is-the-source rule as an issue's selected_session, and the very
  // field the idle reaper already reads to never stop the chat I have open.
  // (localStorage is gone: a saved choice the server doesn't know is a choice
  // no other tab, machine, or housekeeper can honor.)
  useEffect(() => {
    if (isMain && selected && issueId) {
      const email = userEmail();
      if (email) setSelectedChat(email, selected).catch(() => {});
    }
    setEnvSession(issueId, selected);
  }, [selected, issueId, isMain]);

  // A convo pill in the detail view asked to open a specific chat. The nonce
  // re-fires the selection even when the same session is clicked again.
  //
  // Select a chat to open. Persists the choice as the issue's explicit shared
  // selected_session for a WORK chat; a reviewer is shown locally but NEVER
  // persisted, so selection can't flip to a reviewer and the card keeps speaking
  // for the work chat. Main has no shared row → per-browser via the persist effect.
  // A read-only chat is shown but NEVER persisted either, for the same reason a
  // reviewer isn't: the shared default is which chat the issue SPEAKS through,
  // and a teammate's transcript can't speak for it.
  const selectChat = useCallback((sid) => {
    setSelected(sid);
    setMode('resume');
    setFocusIdx(null);
    if (isMain) return;
    const chat = chats.find(c => c.sessionId === sid);
    if (chat && chat.role !== 'reviewer' && chat.resumable) updateChangeField(issueId, 'selected_session', sid);
  }, [isMain, issueId, chats]);

  useEffect(() => {
    if (!requestSession?.sessionId) return;
    selectChat(requestSession.sessionId);
    setFocusIdx(requestSession.turnIdx ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestSession?.nonce, requestSession?.sessionId]);

  // Mint a new chat of the given agent in this env. For an issue the server
  // creates the worktree (if needed) + reserves a port; for main it just runs in
  // the repo root. For codex the server spawns eagerly and returns the id it
  // minted; for claude it mints the id up front. Either way `data.sessionId` is
  // the chat to open.
  const createChat = async (agent = lastAgent()) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/dash/terminal/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue: issueId, agent }),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        // The CLI isn't installed here — the server says so in a typed field, so
        // show the install guidance rather than the raw sentence.
        if (data.reason === 'agent-missing') { setFatal({ reason: data.reason, agent: data.agent, install: data.install }); return; }
        setError(data.error || 'create failed');
        return;
      }
      // For an issue the server just wrote its row (conversation link, port) —
      // announce it like any local write so every view refetches. Main's list is
      // machine-local (no board row), so there's nothing to broadcast.
      if (!isMain) emitIssuesChange('UPDATE', { id: issueId });
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
    // Same endpoint as the first create — the workspace already exists, so it
    // just mints a new linked session of the chosen agent.
    await createChat(agent);
  };

  // Bring a dormant chat's workspace back: the same worktree endpoint the app
  // pane's "Create dev environment" uses, aimed at the path THIS chat recorded
  // (its transcript names that directory and always will). Once the directory is
  // there the chat is resumable like any other, so the refresh alone swaps the
  // reader for a terminal — there is no separate "reopen" call to make.
  const restoreChat = async (sessionId) => {
    setError(null);
    const r = await fetch('/api/dash/terminal/worktree', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issue: issueId, session: sessionId }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) throw new Error(data.error || 'could not rebuild the dev environment');
    // The server just wrote the row (branch, port, maybe status) — announce it
    // like any other write so the board and the app pane pick the port up.
    emitIssuesChange('UPDATE', { id: issueId });
    await refresh();
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
      // Issue unlink is a board-row write — announce it so views refetch. Main's
      // list is machine-local, so nothing to broadcast. The server clears a
      // now-dangling selected_session authoritatively (see the DELETE handler),
      // so the refresh below reflects the fallback without a second write here.
      if (!isMain) emitIssuesChange('UPDATE', { id: issueId });
      // Unlinking my profile's saved main chat clears the saved choice too —
      // the DB field is the only memory now, and it must not point at a chat
      // the list no longer holds.
      if (isMain && myProfile?.selected_chat === sessionId) {
        const email = userEmail();
        if (email) setSelectedChat(email, null).catch(() => {});
      }
      if (selected === sessionId) setSelected(null); // auto-open picks the next
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  // Name (or un-name) a chat. An empty name clears back to the derived default.
  // The server answers with the env's whole name map, so the switcher repaints
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
      // other so the rest of the app refetches. Main's are machine-local.
      if (!isMain) emitIssuesChange('UPDATE', { id: issueId });
    } catch (e) {
      setError(String(e));
    }
  };

  // An issue's chat list AND its chat names both live on the board row, so any
  // issues-change signal is a reason to re-read them: that's how a rename (or a
  // link) made in another window — or by an agent through the CLI — lands here
  // without a refresh. The mirrored half is re-read too, because a rename
  // propagates into it. Main still has no row to hear about, and its mirrored
  // half does not change on board writes either, so it subscribes to nothing.
  useEffect(() => {
    if (isMain || !issueId) return;
    return subscribeIssues(({ record }) => {
      if (record?.id && record.id !== issueId) return; // another card's write
      refreshMirror();
      if (local === true) refresh();
    });
  }, [isMain, local, issueId, refresh, refreshMirror]);

  // The chat corpus is the list's source of truth, and it pushes: a chat
  // registered (or renamed, or re-homed) anywhere — this machine, a teammate's,
  // the sweep — lands in this dropdown the moment its row changes. Main
  // subscribes too: unfiled and main-feed chats live under the 'main' env.
  useEffect(() => {
    if (!issueId) return;
    return subscribeChats(({ record }) => {
      if (record?.env && record.env !== issueId) return; // another env's chat
      refreshMirror();
    });
  }, [issueId, refreshMirror]);

  // Main always has a workspace (the repo root), so it is never a "create a
  // worktree" empty state — it has an always-present thread instead. Asking for
  // that thread is UNCONDITIONAL: the server decides whether one already exists,
  // because only it can read the list and the running PTYs in one settled step.
  // (An issue stays opt-in — its empty state waits for a click.)
  //
  // This used to be a client-side comparison — "does my copy of the list hold a
  // runnable chat? no? then mint one" — which asked before the list had
  // answered and minted a duplicate on every single page load, and raced itself
  // whenever two tabs opened at once. The client no longer has an opinion; it
  // just opens whatever comes back, as new when this call is what created it.
  const ensuredRef = useRef(false);
  useEffect(() => {
    if (!isMain || local !== true || ensuredRef.current) return;
    ensuredRef.current = true;
    (async () => {
      setBusy(true);
      try {
        const r = await fetch('/api/dash/terminal/main-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: lastAgent() }),
        });
        const data = await r.json();
        if (!r.ok || data.error) {
          if (data.reason === 'agent-missing') { setFatal({ reason: data.reason, agent: data.agent, install: data.install }); return; }
          setError(data.error || 'could not open the main chat');
          return;
        }
        // An EXISTING thread is left to the auto-open effect above, which honours
        // my saved choice (profile.selected_chat) — force-selecting here would
        // overrule it every load. Only a thread this call CREATED is opened
        // directly: nothing else could have picked it.
        if (!data.created) return;
        await refresh();
        setSelected(data.sessionId);
        setMode('new');
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    })();
  }, [isMain, local, refresh]);

  // Still probing the backend, or still fetching either half of the list.
  if (local === null || loading) {
    return (
      <div className="issue-terminal issue-terminal-msg">
        <p className="dim">loading…</p>
      </div>
    );
  }

  // No backend here (the deployed board) and nothing mirrored either. This used
  // to be the answer for EVERY remote open; now it is only the genuinely-empty
  // one, because a mirrored chat is readable from anywhere.
  if (local === false && !chats.length) {
    return (
      <div className="issue-terminal">
        <PaneEmpty title="No chats to read yet">
          <p>
            Chats run on the computer that starts them, and each one syncs a
            copy here as it goes. Nothing has synced for this issue yet — open
            it from a machine running the dash to start one.
          </p>
        </PaneEmpty>
      </div>
    );
  }

  // Empty state ONLY for an ISSUE with NEITHER a worktree NOR any linked chat
  // (the create button makes the worktree + first chat in one click). Main is
  // never here — it always has a workspace and auto-mints its first chat above.
  // If a worktree exists but has no chats, or chats exist but their worktree is
  // gone, fall through to the header — the "＋" mints a new chat and any present-
  // but-unresumable chats render disabled in the switcher.
  // The agent CLI isn't on this computer. Guidance, not an error — and it takes
  // the whole pane, because there is nothing else to show until it's installed.
  if (fatal?.reason === 'agent-missing') {
    return (
      <div className="issue-terminal">
        <AgentMissing agents={[{ install: fatal.install }]}
          title={`${fatal.install?.name || agentById(fatal.agent).label} isn't installed on this computer`}>
          <p>This chat runs <strong>{agentById(fatal.agent).label}</strong>, which isn't on this machine.</p>
        </AgentMissing>
      </div>
    );
  }

  // A chat you can READ counts here too: an issue whose only chats belong to a
  // teammate must open on their transcript, not on a "create a worktree" button
  // that hides the very work you came to look at. Which is also why an env with
  // nothing local waits for the mirror before claiming to be empty — "no chats
  // yet" and "not asked yet" are different sentences.
  const hasChats = chats.length > 0;
  if (!isMain && !hasChats && !mirrorSettled) {
    return (
      <div className="issue-terminal issue-terminal-msg">
        <p className="dim">loading…</p>
      </div>
    );
  }
  // Nothing to pick from: say what to install rather than showing a row of
  // choices none of which can be chosen. This is the first thing a teammate
  // meets on a new machine, so it has to be actionable, not just accurate.
  if (!isMain && !state.worktree && !hasChats && AGENTS.every(a => !agentAvailability(a.id).available)) {
    return (
      <div className="issue-terminal">
        <AgentMissing agents={AGENTS.map(a => agentAvailability(a.id))}
          title="No agent is installed on this computer">
          <p>
            The dash runs chats through an agent CLI, and neither is here yet.
            Install one and this becomes the usual “create a worktree and open a
            chat” button.
          </p>
        </AgentMissing>
      </div>
    );
  }
  if (!isMain && !state.worktree && !hasChats) {
    return (
      <div className="issue-terminal">
        <PaneEmpty
          title="No dev environment yet"
          error={error}
          actions={AGENTS.map(a => {
            // An agent that isn't installed here is offered as unavailable
            // rather than hidden — you learn WHY you can't pick it.
            const av = agentAvailability(a.id);
            return (
              <PaneEmptyButton key={a.id} tone="plain" disabled={busy || !av.available}
                title={av.available ? undefined : `${a.label} isn't installed on this computer`}
                onClick={() => { rememberAgent(a.id); createChat(a.id); }}>
                <AgentBadge agent={a.id} />
                <span>{busy ? 'Creating…' : a.label}</span>
                {av.available ? null : <span className="agent-menu-missing">not installed</span>}
              </PaneEmptyButton>
            );
          })}
        >
          <p>
            Create an isolated git worktree for <code>{issueId}</code> and open a
            chat inside it — pick the agent:
          </p>
        </PaneEmpty>
      </div>
    );
  }

  const selectedChat = chats.find(c => c.sessionId === selected);
  // The one question that decides the pane: can this chat take a keystroke HERE?
  // If it can, it gets a terminal. If it can't — a teammate's machine, an editor
  // the dash can't drive, a board with no backend — it gets the reader, which is
  // the same view in every one of those cases rather than three empty states.
  const readOnly = readOnlyHere(selectedChat, state.machine, local, mode);

  return (
    <div className="issue-terminal-wrap">
      <div className="issue-terminal-bar">
        <ChatSwitcher
          chats={chats}
          selected={selected}
          onSelect={selectChat}
          onNew={newChat}
          onUnlink={unlinkChat}
          onRename={renameChat}
          busy={busy}
          local={local === true}
          machine={state.machine}
        />
      </div>
      {error && <p className="pane-empty-err">{error}</p>}
      {/* Exactly ONE pane per issue: its selected chat. When this env is VISIBLE
          the user asked for it, so it mounts (resuming a dormant chat if need be);
          when HIDDEN (the board pool) it mounts only if the chat is already LIVE,
          never cold-spawning claude on board load. The needs-input dot therefore
          reflects the selected chat alone — a reviewer or a second work chat never
          flags the card. */}
      {!readOnly && selected && owned && (active || selectedChat?.live) ? (
        <ChatPane key={selected} issueId={issueId} sessionId={selected} mode={mode} active={active}
          agent={selectedChat?.agent || DEFAULT_AGENT} onFatal={setFatal} />
      ) : null}
      {/* The reader mounts only while the pane is VISIBLE. A hidden pool pane
          exists to keep a live PTY warm; a transcript has nothing to keep warm,
          and its poll would otherwise be one request every few seconds per card
          on the board.

          The restore offer sits UNDER the transcript, not in place of it: the
          conversation is the thing you came for, and it stays readable while you
          decide whether to spend a checkout on it. It lives here rather than
          inside ChatTranscript because it must appear even for a chat the mirror
          has never synced — the reader's own empty states are about the shared
          copy, and this is about the workspace. */}
      {readOnly && selected && active ? (
        <ChatTranscript key={selected} sessionId={selected} focusIdx={focusIdx} />
      ) : null}
      {readOnly && selected && active && selectedChat?.restorable ? (
        <RestoreOffer issueId={issueId} onRestore={() => restoreChat(selected)} />
      ) : null}
    </div>
  );
}
