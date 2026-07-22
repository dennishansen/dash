// Capture + strip the terminal ?token= from the URL before anything renders.
import './terminal-token.js';
import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  HashRouter, Routes, Route, NavLink, Link, useLocation,
} from 'react-router-dom';
import { ChangesBoard } from './views/ChangesBoard.jsx';
import { ChangeDetail } from './views/ChangeDetail.jsx';
import { IssueTerminal, MainTerminal } from './views/Terminal.jsx';
import { SignIn } from './views/SignIn.jsx';
import { SelectionProvider } from './selection.jsx';
import { ChatControlContext } from './chat-control.jsx';
import { WorkspacePanel } from './WorkspacePanel.jsx';
import { CommandPalette } from './CommandPalette.jsx';
import {
  DockPanel, startDockResize, loadW,
  CHAT_DEFAULT_W, APP_DEFAULT_W, DOCK_MIN_W, MAIN_MIN_W, LEFT_W,
} from './dock.jsx';
import { useLocalBackend } from './capabilities.js';
import { appPortForEnv } from './app-env.js';
import { ArrowUpRight, WorkspacePanelIcon, Search } from './icons.jsx';
import { useFetch, useAsync } from './api.js';
import { stateCounts, listChanges } from './board-store.js';
import { onAuth, ensureFreshToken, ensureDevSession, signOut } from './auth.js';
import {
  Avatar, PersonLabel, useMyProfile, useDismiss, displayName,
  saveDisplayName, saveAvatar, clearAvatar, AVATAR_TYPES,
} from './profiles.jsx';
import { getTheme, getMode, setMode, onThemeChange } from './theme.js';
import { useHotkey } from './hotkeys.js';

// Sun / moon glyphs for the theme toggle, matched to the nav icon weight.
function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 1.2v2M8 12.8v2M1.2 8h2M12.8 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M12.8 3.2l-1.4 1.4M4.6 11.4l-1.4 1.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M13.3 9.6A5.6 5.6 0 0 1 6.4 2.7a5.6 5.6 0 1 0 6.9 6.9z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

// Theme picker — an icon whose dropdown offers the three modes; 'auto' (the
// default) follows the OS.
const THEME_MODES = [
  { mode: 'light', label: 'light' },
  { mode: 'dark', label: 'dark' },
  { mode: 'auto', label: 'automatic' },
];

function ThemeMenu() {
  const [theme, setThemeState] = React.useState(getTheme);
  const [mode, setModeState] = React.useState(getMode);
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef(null);
  React.useEffect(() => onThemeChange(setThemeState), []);
  React.useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  const pick = (m) => { setMode(m); setModeState(m); setOpen(false); };
  return (
    <div className="theme-menu-wrap" ref={wrapRef}>
      <button className="topbar-btn theme-toggle" title="Theme" aria-label="Theme"
        onClick={() => setOpen((o) => !o)}>
        {theme === 'light' ? <SunIcon /> : <MoonIcon />}
      </button>
      {open && (
        <div className="theme-menu">
          {THEME_MODES.map(({ mode: m, label }) => (
            <button key={m} className={`theme-pick${m === mode ? ' is-current' : ''}`}
              onClick={() => pick(m)}>
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Who you are, in the sidebar's footer — the one place the Dash renders YOU, so
// it's also where you say what to call yourself and what you look like. Resting
// state is avatar · name; clicking opens the editor above it (a popover, not a
// route: a profile is two fields, and a whole page for two fields is ceremony).
// The picture and name are the same surfaces every card reads, so a change here
// lands on every avatar on the board the moment it saves.
function ProfileCard() {
  const { email, profile } = useMyProfile();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [err, setErr] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const fileRef = React.useRef(null);
  const wrapRef = useDismiss(open, () => setOpen(false));
  // Escape closes — capture phase, so it doesn't also fall through to a view's
  // "Escape → back to the board".
  useHotkey('Escape', () => setOpen(false), { enabled: open, terminal: 'handle', allowInInput: true });
  // Reopening always starts from the saved name and a clean slate — never a
  // stale draft, and never the error from a picture you already gave up on.
  React.useEffect(() => { if (open) { setName(displayName(profile, email)); setErr(null); } }, [open]);

  if (!email) return null;

  const commitName = async () => {
    if (name.trim() === displayName(profile, email)) return;
    setErr(null);
    const r = await saveDisplayName(email, name);
    if (r?.error) setErr(r.error);
  };
  const pickFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';               // same file twice still fires a change
    if (!file) return;
    setErr(null); setBusy(true);
    const r = await saveAvatar(email, file);
    setBusy(false);
    if (r?.error) setErr(r.error);
  };

  return (
    <div className="profile-card" ref={wrapRef}>
      {open ? (
        <div className="profile-pop">
          <button type="button" className="profile-pop-avatar" disabled={busy}
            title="Upload a picture" onClick={() => fileRef.current?.click()}>
            <Avatar email={email} size={56} showTooltip={false} />
            <span className="profile-pop-avatar-hint">{busy ? 'uploading…' : 'change'}</span>
          </button>
          {/* The picker offers exactly what the bucket accepts — one list, so
              the file dialog and the refusal message can never disagree. */}
          <input ref={fileRef} type="file" className="profile-file"
            accept={Object.keys(AVATAR_TYPES).join(',')}
            aria-label="Profile picture" onChange={pickFile} />
          <input className="profile-name-input" value={name} spellCheck={false}
            aria-label="Display name" placeholder="your name"
            onChange={e => setName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commitName(); setOpen(false); }
              else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
            }}
            onBlur={commitName} />
          <div className="profile-pop-email dim">{email}</div>
          {profile?.avatar_key ? (
            <button type="button" className="profile-pop-remove"
              onClick={() => clearAvatar(email)}>remove picture</button>
          ) : null}
          {err ? <div className="profile-pop-err">{err}</div> : null}
        </div>
      ) : null}
      <button type="button" className="profile-trigger" title="Your profile"
        aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <PersonLabel email={email} size={22} />
      </button>
      <button className="signout-btn" onClick={signOut} title="Sign out">sign out</button>
    </div>
  );
}

function Sidebar({ onCollapse }) {
  // `state` is local-only (branch) — null remotely. The Issues count comes from
  // Supabase directly so it's correct everywhere.
  const { data: state } = useFetch('/api/dash/state');
  const { data: counts } = useAsync('state-counts', stateCounts, { pollMs: 60000 });
  return (
    <aside className="sidebar">
      <div className="brand">
        <h1>Dash</h1>
        <button className="topbar-btn sidebar-collapse" title="Close sidebar"
          aria-label="Close sidebar" onClick={onCollapse}>
          <PanelIcon />
        </button>
      </div>
      <div className="tagline">
        {state?.branch ? state.branch : 'issue board'}
      </div>

      <nav>
        <NavLink to="/" end>
          <span>Board</span>
          <span className="ct">{counts?.change_count ?? state?.change_count ?? ''}</span>
        </NavLink>
      </nav>

      <div className="sidebar-footer">
        <a className="ext-link" href="/"><ArrowUpRight size={14} /><span>open canvas</span></a>
        <ThemeMenu />
        <ProfileCard />
      </div>
    </aside>
  );
}

// Derive breadcrumb segments from the current hash route. Each segment is a
// { label, to? } — the last has no link (it's the current page). This is the
// single source of truth for crumbs across all routes (lifted out of views).
function useCrumbs() {
  const { pathname } = useLocation();
  const parts = pathname.split('/').filter(Boolean); // e.g. ['changes', 'abc1']
  if (parts.length === 0) return [{ label: 'board' }];
  const SECTION = { changes: 'board' };
  const crumbs = [];
  const section = SECTION[parts[0]];
  if (section) {
    crumbs.push({ label: section, to: '/' });
    if (parts[1]) crumbs.push({ id: decodeURIComponent(parts[1]), copy: true, section: parts[0] });
  } else {
    crumbs.push({ label: decodeURIComponent(parts[0]) });
  }
  return crumbs;
}

// Chat / terminal glyph for the right-sidebar toggle.
function ChatIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="9" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 5.5l2 1.6L4 8.7M7.5 9h4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Panel glyph for the left-sidebar toggle — a framed rect with a filled left
// column, mirroring ChatIcon's weight so the two navbar toggles read as a pair.
function PanelIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <rect x="1.5" y="2.5" width="4.5" height="11" rx="2" fill="currentColor" opacity="0.55" />
    </svg>
  );
}

// The leaf crumb on a detail route SHOWS the issue title but COPIES the id — the
// title reads better in the bar, the id is what you paste. Falls back to the id
// as the label until the issue list resolves. Long titles ellipse at a max width
// (CSS). Flashes "copied" for ~1s; clipboard blocked → silent no-op.
function CrumbCopy({ id, section }) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef(null);
  const { data } = useAsync('changes', listChanges, { pollMs: 0 });
  const title = section === 'changes' ? (data?.find(i => i.id === id)?.title || null) : null;
  const label = title || id;
  const onCopy = async () => {
    try { await navigator.clipboard.writeText(id); } catch { /* blocked */ }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1000);
  };
  // ⌘S copies the open id — same action + "copied ✓" flash as clicking the crumb.
  // CrumbCopy only mounts on a detail route, so this never fires on the board
  // (where ⌘S copies the selected card). terminal:'handle' so it works over chat.
  useHotkey('Mod+KeyS', () => { onCopy(); }, { terminal: 'handle', repeat: false });
  return (
    <button type="button" className={`crumb-cur crumb-copy${copied ? ' copied' : ''}`}
      onClick={onCopy} title={copied ? 'Copied!' : `${label} — click to copy id (${id}) · ⌘S`}>
      {copied ? 'copied ✓' : label}
    </button>
  );
}

// The "view app" toggle in the topbar — opens the in-dash app panel. Gated like
// the panel itself: only shows with a local backend AND an env that has a running
// app (an issue with no reserved port has nothing to view). Hidden while the
// panel is open (its own ✕ closes it), so the topbar never duplicates the panel.
function AppToggle({ env, port, onToggle }) {
  const local = useLocalBackend();
  if (local !== true) return null;
  if (!appPortForEnv(env, port)) return null;
  return (
    <button type="button" className="topbar-btn app-toggle"
      title="View the running app" onClick={onToggle}>
      <WorkspacePanelIcon />
    </button>
  );
}

function TopBar({ leftCollapsed, onToggleLeft, chatOpen, onToggleChat, appOpen, onToggleApp, appEnv, appPort }) {
  const crumbs = useCrumbs();
  return (
    <header className="topbar">
      {leftCollapsed ? (
        <button
          className="topbar-btn panel-toggle"
          title="Open sidebar"
          onClick={onToggleLeft}
        >
          <PanelIcon />
        </button>
      ) : null}
      <nav className="topbar-crumbs" aria-label="Breadcrumb">
        {crumbs.map((c, i) => (
          <span key={i} className="crumb">
            {c.to ? <Link to={c.to}>{c.label}</Link>
              : c.copy ? <CrumbCopy id={c.id} section={c.section} />
              : <span className="crumb-cur">{c.label}</span>}
            {i < crumbs.length - 1 ? <span className="crumb-sep">/</span> : null}
          </span>
        ))}
      </nav>
      {/* Search opens the ⌘K palette by pointer — present on every route's nav,
          the mouse twin of the global chord. */}
      <button
        type="button"
        className="topbar-btn search-open"
        title="Search issues (⌘K)"
        aria-label="Search issues"
        onClick={() => window.dispatchEvent(new CustomEvent('dash:open-palette'))}
      >
        <Search size={15} />
      </button>
      {/* Two panel toggles, each shown only while its panel is CLOSED — once open,
          the panel's own ✕ (top-left of its navbar) is how you close it. Ordered
          to mirror the columns: chat (inner) then app (outer, hugs the edge). */}
      {!chatOpen ? (
        <button
          className="topbar-btn chat-toggle"
          title="Open AI chat"
          onClick={onToggleChat}
        >
          <ChatIcon />
        </button>
      ) : null}
      {!appOpen ? <AppToggle env={appEnv} port={appPort} onToggle={onToggleApp} /> : null}
    </header>
  );
}

// --- Right-dock geometry ---
// The chat and the app panel are the two right-docked columns; both dock beside
// readable content on a wide screen and flip to a full-screen overlay when the
// viewport is too thin to leave room. The width math, resize drag, persistence,
// and panel shell all live in ./dock.jsx — Shell only wires the two panels' state
// and the per-panel thin threshold (chat has dock priority; the app docks only if
// it also fits beside it). The universal main-chat env id (must match the server in
// terminal.js): the active env is the open issue on a detail route, else this —
// so chat + app panel both show on every page, switching to the main thread /
// canvas off the detail.
const MAIN_ENV = 'main';

function useViewportW() {
  const [w, setW] = React.useState(() => window.innerWidth);
  React.useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return w;
}

// The right chat panel hosts one dev environment. For an issue it's that issue's
// worktree + chats (a switcher); for the MAIN env it's the single persistent
// root thread. The panel exists on every route — the active env (issue on a
// detail route, else main) drives which one is visible. Docked mode carries a
// drag handle on its left edge for resizing. ONE stable element per env: `mode`
// (docked vs overlay) and `open` (visible vs hidden) are class swaps only — the
// <aside> and the terminal inside it never unmount, so resizing across the
// docked↔overlay threshold, closing/reopening, and switching routes all keep the
// live PTY attached.
function ChatPanel({ envId, mode, open, onClose, onResizeStart, requestSession }) {
  // Close is an ✕ top-left of the chat's own nav bar (the switcher/header below);
  // the topbar opener disappears while the chat is open.
  return (
    <DockPanel
      prefix="chat"
      mode={mode}
      open={open}
      onClose={onClose}
      onResizeStart={onResizeStart}
      closeLabel="Close AI chat"
      env={envId}
    >
      {envId === MAIN_ENV
        ? <MainTerminal active={open} />
        : <IssueTerminal key={envId} issueId={envId} active={open} requestSession={requestSession} />}
    </DockPanel>
  );
}

// Shell lives inside the router. The active env (open issue, else main) drives
// which chat shows, but the chats themselves are an app-level persistent pool
// (see openedEnvs) that outlives any single route — visibility follows the
// route, the live sessions do not.
function Shell() {
  const { pathname } = useLocation();
  const parts = pathname.split('/').filter(Boolean);
  const issueId = parts[0] === 'changes' && parts[1] ? decodeURIComponent(parts.slice(1).join('/')) : null;
  // The chat is universal: an issue detail shows that issue's chat; every other
  // page shows the persistent main thread. Both stay mounted in the pool below.
  const activeEnv = issueId ?? MAIN_ENV;
  const onBoard = parts.length === 0;

  // The active issue's reserved dev-server port, read from the board's cache
  // (shared key — no extra fetch). null for the main env, where the app panel
  // falls back to this origin's port (the canvas).
  const { data: changes } = useAsync('changes', listChanges, { pollMs: 60000 });
  const activePort = issueId ? (changes?.find((c) => c.id === issueId)?.port ?? null) : null;

  const [collapsed, setCollapsed] = React.useState(
    () => localStorage.getItem('dash-sidebar-collapsed') === '1'
  );
  // 'dash-chat-open' is the docked-mode preference. Default OPEN: landing on a
  // change with enough room shows the chat; an explicit close is remembered.
  const [chatPref, setChatPref] = React.useState(
    () => localStorage.getItem('dash-chat-open') !== '0'
  );
  const [chatW, setChatW] = React.useState(() => loadW('dash-chat-width', CHAT_DEFAULT_W));
  // The app panel is the second right-docked column — same machinery, default
  // CLOSED (you open it by clicking the localhost link). Its width persists too.
  const [appPref, setAppPref] = React.useState(
    () => localStorage.getItem('dash-app-open') === '1'
  );
  const [appW, setAppW] = React.useState(() => loadW('dash-app-width', APP_DEFAULT_W));
  // One resizing flag for both columns: it kills width transitions and shields
  // the app iframe from swallowing the drag's pointer moves.
  const [resizing, setResizing] = React.useState(false);
  // A pending "open this chat" request from a convo pill. The nonce makes
  // re-clicking the same session re-fire the selection in IssueTerminal.
  const [reqChat, setReqChat] = React.useState(null);
  const requestChat = React.useCallback((reqIssueId, sessionId) => {
    setReqChat((prev) => ({ issueId: reqIssueId, sessionId, nonce: (prev?.nonce ?? 0) + 1 }));
    // Force the panel visible (docked pref or thin overlay) so the chat shows.
    setChatPref(true);
    localStorage.setItem('dash-chat-open', '1');
    setChatOverlayOpen(true);
  }, []);
  // Overlay (thin-screen) visibility is transient per panel: opened by the
  // toggle/link, closed by ✕ — and neither survives leaving the detail view.
  const [chatOverlayOpen, setChatOverlayOpen] = React.useState(false);
  const [appOverlayOpen, setAppOverlayOpen] = React.useState(false);
  React.useEffect(() => { setChatOverlayOpen(false); setAppOverlayOpen(false); }, [pathname]);
  // Bumped by ↻ to remount the app iframe; `appReloading` spins the navbar ↻
  // while a server-side restart is in flight.
  const [appReloadKey, setAppReloadKey] = React.useState(0);
  const [appReloading, setAppReloading] = React.useState(false);

  const viewportW = useViewportW();
  const sidebarW = collapsed ? 0 : LEFT_W;
  // Each docked column HOLDS its user-set width on window resize — the main
  // column (minmax(0,1fr)) absorbs the change. We floor each at DOCK_MIN_W. Thin
  // is per-panel with the CHAT taking dock priority: the chat docks whenever it
  // leaves MAIN_MIN_W of content beside the sidebar; the app docks only if it
  // ALSO fits beside an already-docked chat. So opening the app on a screen too
  // narrow for both flips just the app to a full-screen overlay (the chat stays
  // put) — never squishing content, never yanking the chat out from under you.
  // Thin is a "would it FIT if open?" test, so a panel's OWN width always counts
  // (independent of whether it's currently open) — otherwise the first click on a
  // closed panel computes not-thin, sets the pref, then re-renders thin and shows
  // nothing (a dead first click). Only the SIBLING's claim is gated on it being
  // actually docked.
  const chatDockW = Math.max(chatW, DOCK_MIN_W);
  const appDockW = Math.max(appW, DOCK_MIN_W);
  const chatThin = viewportW < sidebarW + chatDockW + MAIN_MIN_W;
  const chatRoomW = chatPref && !chatThin ? chatDockW : 0; // chat's claim on the row
  const appThin = viewportW < sidebarW + chatRoomW + appDockW + MAIN_MIN_W;

  // Open = the user's pref when there's room to dock; the transient overlay flag
  // when the viewport is thin. Docked = open and roomy (drives the grid track).
  const chatOpen = chatThin ? chatOverlayOpen : chatPref;
  const appOpen = appThin ? appOverlayOpen : appPref;
  const chatDocked = chatOpen && !chatThin;
  const appDocked = appOpen && !appThin;

  // Persistent chat pool. Every env whose chat is opened stays MOUNTED for the
  // session — hidden when it isn't the active env, but its live claude session +
  // scrollback stay attached, so switching routes (issue↔main↔another issue) is
  // instant with no PTY reattach. Because the element never unmounts, docked↔
  // overlay is a pure class swap on resize, never a remount. Lazy: an env whose
  // chat was never opened isn't in the pool — so the main thread spins up its PTY
  // only once the chat is actually open (which, with the default-open pref, is on
  // first load → its /main bootstrap), and an issue never viewed spins up nothing.
  const [openedEnvs, setOpenedEnvs] = React.useState([]);
  React.useLayoutEffect(() => {
    if (chatOpen && activeEnv) {
      setOpenedEnvs((prev) => (prev.includes(activeEnv) ? prev : [...prev, activeEnv]));
    }
  }, [chatOpen, activeEnv]);

  // Seed the pool from the LIVE server-side chats (the `/terminal/live` pairs)
  // that each issue has EXPLICITLY selected — its `selected_session`. At most one
  // pane per issue, and only when that chat is already live, so the board still
  // never cold-spawns on load AND a reviewer / a second work chat never warms or
  // dots a card (they're never an issue's selected_session). The env is the
  // SELECTING issue; however many pooled issues later want the same session, only
  // the ownership winner mounts its ChatPane (see session-pool.js). Mounting the
  // (hidden) ChatPane REATTACHES to the running PTY (cheap — no claude spawn, no
  // transcript scan) and starts reporting working/idle, so the selected chat's
  // "needs input" dot populates without a manual card open.
  //
  // Background work yields to the foreground: the initial seed is DEFERRED to
  // browser idle (first paint + any immediate card-open win) and THROTTLED a
  // couple per tick. A 30s poll catches chats that come alive (or get selected)
  // later (e.g. an autonomously-spawned issue). A ref tracks which SESSIONS have
  // been queued so re-seeds and openedEnvs changes don't double-mount.
  const seededRef = React.useRef(new Set());
  // Latest board rows for selected_session resolution — a ref so the mount-once
  // seed effect below reads fresh data without re-running.
  const changesRef = React.useRef(null);
  changesRef.current = changes;
  React.useEffect(() => {
    let cancelled = false;
    let pumpTimer = null;
    const trickleIn = (pairs) => {
      // Resolution needs the board rows; until they land, defer the whole batch
      // (nothing is marked seeded) and retry shortly.
      const rows = changesRef.current;
      if (!rows) { pumpTimer = setTimeout(seed, 1000); return; }
      // Warm EXACTLY the chat each issue points its explicit selected_session at —
      // and only because it turned up in /terminal/live is it already LIVE, so
      // this still never cold-spawns. A live session that NO issue has selected (a
      // reviewer, a second work chat, a revived dormant sibling) is deliberately
      // skipped: the board dot speaks for the one chat you'd actually resume, and
      // a reviewer must never flag a card. The env is the SELECTING issue itself.
      const envFor = (session) => rows.find((r) => r.selected_session === session)?.id;
      const queue = pairs.filter((p) => p && p.session && !seededRef.current.has(p.session) && envFor(p.session));
      if (!queue.length) return;
      let i = 0;
      const STEP = 2;
      const pump = () => {
        if (cancelled) return;
        const batch = queue.slice(i, i + STEP);
        i += STEP;
        if (batch.length) {
          batch.forEach((p) => seededRef.current.add(p.session));
          // Set-dedupe: two live sessions can resolve to the SAME issue, and a
          // duplicate env id would mount duplicate same-key panels.
          const envs = [...new Set(batch.map((p) => envFor(p.session)))];
          setOpenedEnvs((prev) => {
            const add = envs.filter((id) => id && !prev.includes(id));
            return add.length ? [...prev, ...add] : prev;
          });
        }
        if (i < queue.length) pumpTimer = setTimeout(pump, 300);
      };
      pump();
    };
    const seed = async () => {
      try {
        const r = await fetch('/api/dash/terminal/live');
        const d = await r.json();
        if (!cancelled && Array.isArray(d.sessions)) trickleIn(d.sessions);
      } catch { /* no local backend (remote) — nothing to seed */ }
    };
    const ric = window.requestIdleCallback;
    const startHandle = ric ? ric(seed, { timeout: 2000 }) : setTimeout(seed, 1200);
    const poll = setInterval(seed, 30000);
    return () => {
      cancelled = true;
      if (ric && window.cancelIdleCallback) window.cancelIdleCallback(startHandle); else clearTimeout(startHandle);
      clearTimeout(pumpTimer);
      clearInterval(poll);
    };
  }, []);

  const toggleLeft = () => {
    setCollapsed((v) => {
      const next = !v;
      localStorage.setItem('dash-sidebar-collapsed', next ? '1' : '0');
      return next;
    });
  };
  const toggleChat = () => {
    if (chatThin) { setChatOverlayOpen((v) => !v); return; }
    setChatPref((v) => {
      const next = !v;
      localStorage.setItem('dash-chat-open', next ? '1' : '0');
      return next;
    });
  };
  // The topbar "view app" icon opens/toggles the app panel — thin → transient
  // overlay, wide → persisted docked pref.
  const toggleApp = () => {
    if (appThin) { setAppOverlayOpen((v) => !v); return; }
    setAppPref((v) => {
      const next = !v;
      localStorage.setItem('dash-app-open', next ? '1' : '0');
      return next;
    });
  };
  // ↻ restarts the app in-dash, no browser tab. Force the panel open; for an
  // ISSUE env, first POST `/restart` to actually kill + relaunch that worktree's
  // dev server (the refresh-restarts-dev-server contract) and spin the ↻ while it
  // works; then bump the reload key so the iframe remounts onto the fresh server.
  // The MAIN env is the canvas at THIS origin (the same vite that serves the
  // Dash) — restarting it would kill the Dash, so main just remounts (reload).
  const reloadApp = async () => {
    if (appThin) setAppOverlayOpen(true);
    else { setAppPref(true); localStorage.setItem('dash-app-open', '1'); }
    if (activeEnv !== MAIN_ENV) {
      setAppReloading(true);
      try { await fetch(`/api/dash/terminal/${encodeURIComponent(activeEnv)}/restart`, { method: 'POST' }); } catch { /* show fresh anyway */ }
      setAppReloading(false);
    }
    setAppReloadKey((k) => k + 1);
  };

  // Board focus toggle: on the Issues board, ⌘← parks the keyboard on the kanban
  // (so arrows move the card cursor) and ⌘→ drops it into the chat (so you can
  // type). A capture-phase listener is what makes this work when the chat owns
  // focus — xterm's textarea swallows keystrokes, so we intercept on the way
  // DOWN (preventing native Back/Forward and stopping the event before the
  // terminal or the board's own arrow-nav sees it) and steer focus by event.
  React.useEffect(() => {
    if (!onBoard) return undefined;
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        if (!chatOpen) { if (chatThin) setChatOverlayOpen(true); else { setChatPref(true); localStorage.setItem('dash-chat-open', '1'); } }
        // Two frames: if the chat was just opened, its pane needs a beat to mount
        // before it can take focus; if already open, the extra frame is harmless.
        requestAnimationFrame(() => requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('dash:focus-chat'))));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent('dash:focus-board'));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onBoard, chatOpen, chatThin]);

  // Drag a docked column's left edge. Width tracks live (the grid var follows
  // state) and persists on release; clamping keeps MAIN_MIN_W of content room
  // given the OTHER docked column's width (so two open panels can't scrunch it).
  const onChatResizeStart = (e) => startDockResize(e, {
    startW: chatDockW, sidebarW, otherW: appDocked ? appDockW : 0,
    onWidth: setChatW, onEnd: (w) => localStorage.setItem('dash-chat-width', String(w)), setResizing,
  });
  const onAppResizeStart = (e) => startDockResize(e, {
    startW: appDockW, sidebarW, otherW: chatDocked ? chatDockW : 0,
    onWidth: setAppW, onEnd: (w) => localStorage.setItem('dash-app-width', String(w)), setResizing,
  });

  return (
    <ChatControlContext.Provider value={requestChat}>
    <div
      className={`app${collapsed ? ' collapsed' : ''}${chatDocked ? ' chat-open' : ''}${appDocked ? ' app-open' : ''}${resizing ? ' dock-resizing' : ''}`}
      style={{ '--chat-w': `${chatDockW}px`, '--app-w': `${appDockW}px` }}
    >
      <Sidebar onCollapse={toggleLeft} />
      <div className="content">
        <TopBar
          leftCollapsed={collapsed}
          onToggleLeft={toggleLeft}
          chatOpen={chatOpen}
          onToggleChat={toggleChat}
          appOpen={appOpen}
          onToggleApp={toggleApp}
          appEnv={activeEnv}
          appPort={activePort}
        />
        <div className="main">
          {/* The board is home: it mounts ONCE for the whole session and is only
              hidden when you're off the home route (a change detail) — never
              unmounted. Its realtime stream stays connected the entire time, so a
              card that moved while you were elsewhere is already in place on
              return: instant, no stale-paint flash. Same persistent-mount pattern
              as the chat panels below. `display:contents` makes the wrapper vanish
              from layout when shown, so the board lays out exactly as a direct
              .main child would. */}
          <div className="board-mount" style={{ display: onBoard ? 'contents' : 'none' }}>
            <ChangesBoard visible={onBoard} />
          </div>
          <Routes>
            <Route path="/changes/:id" element={<ChangeDetail />} />
          </Routes>
        </div>
      </div>
      {openedEnvs.map((id) => (
        <ChatPanel
          key={id}
          envId={id}
          mode={chatThin ? 'overlay' : 'docked'}
          open={id === activeEnv && chatOpen}
          onClose={toggleChat}
          onResizeStart={onChatResizeStart}
          requestSession={reqChat && reqChat.issueId === id ? reqChat : null}
        />
      ))}
      {/* The app panel mounts only while open (no per-env pool): one iframe,
          keyed on the active env, so opening on a new page loads that env's app
          — and closing tears the iframe down so we never lazy-start a worktree's
          dev server the user didn't ask to see. */}
      {appOpen && (
        <WorkspacePanel
          env={activeEnv}
          port={activePort}
          reloadKey={appReloadKey}
          reloading={appReloading}
          mode={appThin ? 'overlay' : 'docked'}
          open
          onClose={toggleApp}
          onReload={reloadApp}
          onResizeStart={onAppResizeStart}
        />
      )}
      {/* ⌘K command palette — a route-agnostic modal (portals to body), so it
          works over the board, a detail view, or the chat terminal alike. */}
      <CommandPalette />
    </div>
    </ChatControlContext.Provider>
  );
}

// Auth gate. The whole Dash sits behind email sign-in: no session ⇒ <SignIn>,
// signed in ⇒ the app. The board reads Supabase directly with the user's token,
// and RLS only answers for authenticated + allow-listed emails — so the gate
// isn't cosmetic, it's the same identity the database enforces. A short
// interval keeps the access token fresh while the tab is open.
function App() {
  const [session, setSession] = React.useState(undefined); // undefined = deciding
  // Don't flash <SignIn> while the local-dev auto-session is still in flight:
  // hold until ensureDevSession settles (instant 404 on remote, quick mint on
  // localhost). Once it resolves, either a session arrived via onAuth or we know
  // none is coming.
  const [devChecked, setDevChecked] = React.useState(false);
  React.useEffect(() => onAuth(setSession), []);
  React.useEffect(() => {
    ensureDevSession().finally(() => { setDevChecked(true); ensureFreshToken(); });
    const t = setInterval(ensureFreshToken, 60000);
    return () => clearInterval(t);
  }, []);

  // No idle-warm needed: the board mounts at app start and stays mounted (see
  // Shell), so its useAsync('changes') fetches Supabase immediately on load —
  // earlier than any requestIdleCallback warm would have fired.

  if (session === undefined) return null; // first paint before localStorage read settles
  if (!session && !devChecked) return null; // local-dev auto-session may still arrive
  if (!session) return <SignIn />;

  return (
    <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <SelectionProvider>
        <Shell />
      </SelectionProvider>
    </HashRouter>
  );
}

createRoot(document.getElementById('root')).render(<App />);
