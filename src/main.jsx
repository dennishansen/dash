// Capture + strip the terminal ?token= from the URL before anything renders.
import './terminal-token.js';
import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter, Routes, Route, NavLink, Link, Navigate, useLocation,
} from 'react-router-dom';
import { Metrics } from './views/Metrics.jsx';
import { ChangesBoard } from './views/ChangesBoard.jsx';
import { ChangeDetail } from './views/ChangeDetail.jsx';
import { TestsList } from './views/TestsList.jsx';
import { TestDetail } from './views/TestDetail.jsx';
import { Recordings } from './views/Recordings.jsx';
import { RecordingDetail } from './views/RecordingDetail.jsx';
import { ChatEnvironment } from './views/Terminal.jsx';
import { SignIn } from './views/SignIn.jsx';
import { SelectionProvider, useIssueNav, isBoardRoute } from './selection.jsx';
import { ChatControlContext } from './chat-control.jsx';
import { WorkspacePanel } from './WorkspacePanel.jsx';
import { CommandPalette } from './CommandPalette.jsx';
import { ShortcutsOverlay } from './ShortcutsOverlay.jsx';
import { hk, hkCaps, hkTitle } from './hotkey-registry.js';
import { copyText, copyFailureHint } from './clipboard.js';
import { DockPanel } from './dock.jsx';
import { useControlPlane, staleNotice } from './control-plane.js';
import {
  startDockResize, loadW,
  CHAT_DEFAULT_W, APP_DEFAULT_W, DOCK_MIN_W, MAIN_MIN_W, LEFT_W,
} from './dock-geometry.js';
import { useLocalBackend } from './capabilities.js';
import { useHotkey } from './hotkeys.js';
import { ArrowUpRight, WorkspacePanelIcon, ChevronUp, ChevronDown, Search, Keyboard, NAV_ICON, NAV_CARET } from './icons.jsx';
import { useFetch, useIssues } from './api.js';
import { DiscardChanges } from './DiscardChanges.jsx';
import { listChanges, updateChangeFields } from './board-store.js';
import { emitIssuesChange } from './realtime.js';
import { normalizeAppPath, appLinkList, isBaseAppPath } from './app-env.mjs';
import { loadMainPath, saveMainPath, loadMainLinks, saveMainLinks } from './app-links.js';
import { DASH_BASENAME } from './routes.mjs';
import { onAuth, ensureFreshToken, ensureDevSession, signOut } from './auth.js';
import {
  Avatar, PersonLabel, useMyProfile, useDismiss, displayName,
  saveDisplayName, saveAvatar, clearAvatar, AVATAR_TYPES,
} from './profiles.jsx';
import { getTheme, getMode, setMode, onThemeChange } from './theme.js';
import {
  shellLabel, shellDetail, skewNotice, useShellSkew, useNewerDeploy,
} from './shell-build.js';
import { installGuestNav } from './embed.js';

// A dash embedded in the App pane (issue app_path = /dash/) honors the host's
// refresh and back/forward: acting in-place keeps the current route; a src
// remount would reset it.
installGuestNav();

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

// Theme picker — an icon in the sidebar's brand row whose dropdown offers the
// three modes; 'auto' (the default) follows the OS.
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
  // `state` is local-only (branch, in-flight, corpus counts) — null remotely.
  // The Issues count comes from Supabase directly so it's correct everywhere.
  // Fetched ONCE on load (pollMs:0), not on a timer: these git-derived counts
  // change rarely, and a recurring poll would spawn git every 15s for a header
  // stat. It refreshes on navigation (a fresh mount refetches).
  const { data: state } = useFetch('/api/dash/state', { pollMs: 0 });
  // Issues count derives from the same 'changes' cache the board paints — one
  // truth, so the badge moves in the same breath as any write-through edit.
  const { data: allChanges } = useIssues('changes', listChanges, { pollMs: 0 });
  return (
    <aside className="sidebar">
      <div className="brand">
        <h1>Dash</h1>
        <ThemeMenu />
        <button className="topbar-btn sidebar-collapse" title="Close sidebar"
          aria-label="Close sidebar" onClick={onCollapse}>
          <PanelIcon />
        </button>
      </div>
      <div className="tagline">
        {state?.branch ? state.branch : 'issue board'}
      </div>

      <nav>
        <NavLink to="/metrics">
          <span>Metrics</span>
          <span className="ct">{state?.in_flight_count ?? ''}</span>
        </NavLink>
        <NavLink to="/issues">
          <span>Issues</span>
          <span className="ct">{allChanges?.length ?? state?.change_count ?? ''}</span>
        </NavLink>
        {/* No count: recordings are a bucket listing, and a badge here would
            mean a storage read on every page of the Dash to say a number
            nobody acts on. */}
        <NavLink to="/recordings">
          <span>Recordings</span>
          <span className="ct" />
        </NavLink>
        <NavLink to="/tests">
          <span>Tests</span>
          <span className="ct">{state?.corpus_count ?? ''}</span>
        </NavLink>
      </nav>

      <div className="sidebar-footer">
        <a className="ext-link" href="/"><ArrowUpRight size={14} /><span>open canvas</span></a>
        <ProfileCard />
        <ShellBadge />
      </div>
    </aside>
  );
}

// WHICH BUILD IS THIS. On a box the shell is a deployed release
// (dash/server/shell-release.mjs), so the page in front of you is whatever was
// last deployed — not whatever main is at this second. A worktree preview is a
// dev shell from that checkout. One muted line in the footer answers which one
// is on screen without opening devtools.
function ShellBadge() {
  return <div className="shell-badge" title={shellDetail()}>{shellLabel()}</div>;
}

// ONE strip for the one condition a page can never work out from its own
// contents: the control plane behind it and this bundle do not match. It is a
// fact about the MACHINE, not about whatever route you are on, so it sits above
// the app chrome — and there is one of it, because two stacked warnings saying
// "the dash and its server disagree" would be the disagreement.
//
// Two independent ways to learn it, and neither subsumes the other:
//
//   DECLARED — the bundle and the supervisor announce different /api/dash
//   protocols (shell-build.js). Sharp, but it only fires when somebody bumped
//   the constant.
//
//   OBSERVED — a route this board needs 404s on a supervisor that is otherwise
//   up (control-plane.js), which is proof rather than a declaration and is what
//   actually caught needs-input dots vanishing for a day.
//
// Declared first when both hold: a protocol disagreement is the larger fact,
// and its remedy comes first anyway.
function ControlPlaneBanner() {
  const skew = useShellSkew();
  const stale = staleNotice(useControlPlane());
  const notice = skewNotice(skew) || stale;
  if (!notice) return null;
  return (
    <div className="skew-banner" role="status">
      <strong>{notice.headline}</strong>
      <span>{` ${notice.detail} ${notice.remedyLead} `}<code>{notice.remedy}</code></span>
    </div>
  );
}

// Derive breadcrumb segments from the current route. Each segment is a
// { label, to? } — the last has no link (it's the current page). This is the
// single source of truth for crumbs across all routes (lifted out of views).
// `pathname` is basename-relative (BrowserRouter strips /dash), so parts read
// the same "/issues"-relative segments the routes are declared with.
function useCrumbs() {
  const { pathname } = useLocation();
  const parts = pathname.split('/').filter(Boolean); // e.g. ['issues', 'abc1']
  // Bare /dash/ redirects to the board, so an empty path is just the transient
  // pre-Navigate frame — label it for the destination (issues), never a stale
  // "dashboard".
  if (parts.length === 0) return [{ label: 'issues' }];
  const SECTION = { issues: 'issues', tests: 'tests', recordings: 'recordings' };
  const crumbs = [];
  const section = SECTION[parts[0]];
  if (section) {
    // On an issue detail, the parent "issues" crumb is the pointer twin of ⌘←
    // (back to the list) — carry the hint so its hover names the chord.
    const parentHint = parts[1] && parts[0] === 'issues' ? 'detailBack' : undefined;
    crumbs.push({ label: section, to: `/${parts[0]}`, hint: parentHint });
    // The id is EVERYTHING after the section, not the next segment: a recording
    // in the tests namespace is `tests/agent-foo`, one id with a slash in it,
    // and a crumb reading "tests" would name something that doesn't exist.
    const id = parts.slice(1).map(decodeURIComponent).join('/');
    if (id) crumbs.push({ id, copy: true, section: parts[0] });
  } else {
    crumbs.push({ label: decodeURIComponent(parts[0]) });
  }
  return crumbs;
}

// Chat / terminal glyph for the right-sidebar toggle.
function ChatIcon() {
  return (
    <svg width={NAV_ICON} height={NAV_ICON} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="9" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 5.5l2 1.6L4 8.7M7.5 9h4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Two-arrow circle — the "sync" glyph (lucide refresh-cw), for the board's
// git-sync button. Spins via CSS while a sync is in flight.
function SyncIcon() {
  return (
    <svg width={NAV_ICON} height={NAV_ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  );
}

// Single circular arrow — the browser's "reload this page" mark, for the newer-
// deploy button. Deliberately NOT SyncIcon: that one sits immediately to its
// right, and two identical two-arrow circles side by side would read as one
// control rendered twice. Reloading a page and reconciling a branch with its
// remote are different acts and get different glyphs.
function ReloadIcon() {
  return (
    <svg width={NAV_ICON} height={NAV_ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
    </svg>
  );
}

// Panel glyph for the left-sidebar toggle — a framed rect with a filled left
// column, mirroring ChatIcon's weight so the two navbar toggles read as a pair.
function PanelIcon() {
  return (
    <svg width={NAV_ICON} height={NAV_ICON} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <rect x="1.5" y="2.5" width="4.5" height="11" rx="2" fill="currentColor" opacity="0.55" />
    </svg>
  );
}

// The leaf crumb on a detail route SHOWS the issue title but COPIES the id — the
// title reads better in the bar, the id is what you paste. Falls back to the id
// as the label until the issue list resolves (or on tests routes,
// which have no title here). Long titles ellipse at a max width (CSS).
//
// "copied ✓" means the id is ON THE CLIPBOARD. It used to mean the click
// happened — a blocked clipboard was a silent no-op followed by the same cheery
// flash, which on the box meant pasting the PREVIOUS id into a commit message
// (issue i-tailnet-secure-context). This crumb is the one copy control whose
// value is not already on screen — it shows the title — so a failure here also
// reveals the id and selects it, which is the manual copy this button was
// standing in for.
function CrumbCopy({ id, section }) {
  const [state, setState] = React.useState('idle');   // idle | copied | failed
  const timer = React.useRef(null);
  const btn = React.useRef(null);
  const { data } = useIssues('changes', listChanges, { pollMs: 0 });
  const title = section === 'issues' ? (data?.find(i => i.id === id)?.title || null) : null;
  const copied = state === 'copied';
  const failed = state === 'failed';
  const label = failed ? id : (title || id);
  const onCopy = async () => {
    const ok = await copyText(id);
    setState(ok ? 'copied' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), ok ? 1000 : 6000);
    // Put the id under a selection so ⌘C finishes the job by hand. After the
    // re-render, or the node still holds the title.
    if (!ok) requestAnimationFrame(() => {
      const node = btn.current;
      if (!node || typeof window.getSelection !== 'function') return;
      const range = document.createRange();
      range.selectNodeContents(node);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
  };
  // ⌘S copies the open id — same action + "copied ✓" flash as clicking the crumb.
  // CrumbCopy only mounts on a detail route, so this never fires on the board
  // (where ⌘S copies the selected card). terminal:'handle' so it works over chat.
  useHotkey(hk('detailCopyId'), () => { onCopy(); }, { terminal: 'handle', repeat: false });
  // The tooltip names the chord AND that the same chord copies the selected
  // card's id on the board — so the board-scoped twin (overlay-only) is findable
  // from the one control it mirrors.
  const copyHint = `${label} — click to copy id (${id}) · ${hkCaps('detailCopyId')} (also copies the selected card on the board)`;
  return (
    <button ref={btn} type="button"
      className={`crumb-cur crumb-copy${copied ? ' copied' : ''}${failed ? ' copy-failed' : ''}`}
      onClick={onCopy} title={copied ? 'Copied!' : failed ? copyFailureHint() : copyHint}>
      {copied ? 'copied ✓' : label}
    </button>
  );
}

// Prev/next chevrons beside the issue crumb — the pointer twin of ⌘↑/⌘↓ on the
// detail view. Both ride the board's published rail (selection.jsx), so they
// walk the exact visible board order and disable at either end (no wrap) or
// when the open issue isn't on the board (filtered out / hidden column).
function CrumbIssueNav() {
  const { pathname } = useLocation();
  const parts = pathname.split('/').filter(Boolean);
  // Same id derivation as Shell's issueId — ids may carry slashes (branch names).
  const id = parts[0] === 'issues' && parts[1] ? decodeURIComponent(parts.slice(1).join('/')) : null;
  // prevId/nextId are render-time (disabled states); go() re-aims from the live
  // location at click time so a fast second click can't fire on stale neighbors.
  const { prevId, nextId, go } = useIssueNav(id);
  if (!id) return null;
  return (
    <span className="crumb-nav">
      <button type="button" className="crumb-nav-btn" title={hkTitle('issuePrev')}
        aria-label="Previous issue" disabled={!prevId} onClick={() => go('up')}>
        <ChevronUp size={NAV_ICON} />
      </button>
      <button type="button" className="crumb-nav-btn" title={hkTitle('issueNext')}
        aria-label="Next issue" disabled={!nextId} onClick={() => go('down')}>
        <ChevronDown size={NAV_ICON} />
      </button>
    </span>
  );
}

// The workspace toggle opens the rightmost App/Code inspector. Code browsing is
// useful even when an issue has no running dev server, so availability is gated
// only on the local repository backend; App mode carries its own empty state.
function WorkspaceToggle({ onToggle }) {
  const local = useLocalBackend();
  if (local !== true) return null;
  return (
    <button type="button" className="topbar-btn app-toggle"
      title="Open App and Code view" onClick={onToggle}>
      <WorkspacePanelIcon size={NAV_ICON} />
    </button>
  );
}

// The board's git-sync button — GitHub-Desktop-style. Shows main's ahead/behind
// vs origin/main; one click fetches, fast-forwards main if behind, then pushes
// if ahead. A divergence it can't fast-forward is NOT auto-resolved: the server
// drops a note into the main chat and reports back, and the button flags it.
// Gated like the app toggle — git runs server-side, so it needs a local backend
// — and rendered only on the board nav (never issue detail).
// Last git-status, cached in module scope so the button repaints INSTANTLY from
// last-known state on every board revisit — the component remounts each time the
// board mounts (it's gated on `onBoard`), and without this it would start blank
// and only appear after the fetch round-trip, so a quick in/out never showed it.
// Stale-while-revalidate: paint the cache, refresh in the background.
const gitStatusCache = new Map(); // env → last status

function SyncButton({ env = MAIN_ENV }) {
  const local = useLocalBackend();
  const [status, setStatus] = React.useState(() => gitStatusCache.get(env) || null);
  const [syncing, setSyncing] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuRef = React.useRef(null);
  // How much this branch has, for the confirm to name. The code pane counts the
  // same delta; this asks the same endpoint rather than inventing a second count.
  const { data: tree } = useFetch(local ? `/api/dash/code/${encodeURIComponent(env)}` : null, { pollMs: menuOpen ? 5000 : 0 });
  const changedCount = tree?.files?.filter((f) => f.status).length || 0;
  React.useEffect(() => {
    if (!menuOpen) return undefined;
    const away = (event) => { if (!menuRef.current?.contains(event.target)) setMenuOpen(false); };
    const esc = (event) => { if (event.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc); };
  }, [menuOpen]);
  const [conflict, setConflict] = React.useState(false);
  const isMain = env === MAIN_ENV;

  const applyStatus = React.useCallback((s) => { gitStatusCache.set(env, s); setStatus(s); }, [env]);
  const refresh = React.useCallback(async () => {
    try {
      const r = await fetch(`/api/dash/terminal/git-status?env=${encodeURIComponent(env)}`);
      if (r.ok) applyStatus(await r.json());
    } catch { /* offline — keep last known counts */ }
  }, [applyStatus, env]);

  // Repaint from THIS env's cache the instant the env changes, so moving between
  // cards never shows the previous card's counts.
  React.useEffect(() => { setStatus(gitStatusCache.get(env) || null); setConflict(false); }, [env]);

  React.useEffect(() => {
    if (local !== true) return undefined;
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, [local, refresh]);

  // An issue with no worktree on this machine has nothing to sync — the server
  // says so and the button simply isn't there. Main additionally hides until a
  // remote exists; an ISSUE branch that has never been pushed is the normal
  // first-push case, so it stays visible when there is something to publish.
  if (local !== true || !status || !status.ok) return null;
  if (isMain && !status.hasRemote) return null;
  if (!isMain && !status.hasRemote && !status.publishable) return null;

  const { ahead = 0, behind = 0, branch, publishable } = status;
  const inSync = ahead === 0 && behind === 0 && (!isMain || branch === 'main');

  const onSync = async () => {
    if (syncing) return;
    setSyncing(true); setConflict(false);
    try {
      const r = await fetch('/api/dash/terminal/git-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env }),
      });
      const data = await r.json().catch(() => ({}));
      if (data.conflict) setConflict(true);
      if (data.branch) applyStatus(data); else await refresh();
    } catch { /* leave state; next poll reconciles */ }
    finally { setSyncing(false); }
  };

  const what = isMain ? 'main' : branch;
  const title = conflict
    ? `Sync hit a conflict — check the ${isMain ? 'main' : 'issue'} chat to resolve`
    : isMain && branch !== 'main' ? `Primary checkout is on ${branch}, not main`
    : syncing ? 'Syncing…'
    : publishable ? `Publish ${what} to origin — ${ahead} commit${ahead === 1 ? '' : 's'}, never pushed`
    : inSync ? `In sync with origin/${what}`
    : `Sync ${what} with origin${behind ? ` · ${behind} to pull` : ''}${ahead ? ` · ${ahead} to push` : ''}`;

  return (
    <span className="sync-split" ref={menuRef}>
      <button type="button"
        className={`topbar-btn sync-btn${syncing ? ' is-syncing' : ''}${conflict ? ' is-conflict' : ''}`}
        title={title} onClick={onSync} disabled={syncing}>
        <SyncIcon />
        {!inSync && !syncing ? (
          <span className="sync-counts">
            {behind ? <span className="sync-behind">↓{behind}</span> : null}
            {ahead ? <span className="sync-ahead">↑{ahead}</span> : null}
          </span>
        ) : null}
      </button>
      {/* The chevron, the same shape the app pane's refresh already uses: the
          button does the ordinary thing, the menu holds the rest of what can be
          done to this branch as a whole. Discarding lives here rather than in
          the file tree, where a destructive button sat one slip away from a
          tree you were only tidying. */}
      <button type="button" className="topbar-btn sync-caret"
        onClick={() => setMenuOpen((value) => !value)}
        title="Branch actions" aria-label="Branch actions"
        aria-haspopup="menu" aria-expanded={menuOpen}>
        <ChevronDown size={NAV_CARET} />
      </button>
      {menuOpen ? (
        <div className="sync-menu" role="menu">
          <DiscardChanges env={env} count={changedCount} onDone={() => setMenuOpen(false)} />
        </div>
      ) : null}
    </span>
  );
}

// A NEWER DEPLOY IS LIVE AND THIS TAB IS NOT ON IT. The deployed shell only
// changes on refresh, so the fix has always been available and never announced;
// the footer badge could say "refresh to pick up a newer deploy" while being
// entirely up to date, because it had no way to know.
//
// Present ONLY when there is something to get (shell-build.js compares two
// release ids, so its absence is as meaningful as its presence), and it does
// exactly the one thing that resolves the condition it reports. Green, not the
// warning colour: nothing is broken, there is simply something newer one click
// away — an invitation rather than an alarm.
function DeployRefreshButton() {
  const newer = useNewerDeploy();
  if (!newer) return null;
  return (
    <button type="button" className="topbar-btn deploy-refresh"
      title={`A newer dash deploy is live (${newer}).\nRefresh to pick it up.`}
      aria-label="Refresh to load the newer deploy"
      onClick={() => window.location.reload()}>
      <ReloadIcon />
    </button>
  );
}

function TopBar({ leftCollapsed, onToggleLeft, onBoard, chatOpen, onToggleChat, appOpen, onToggleApp }) {
  const crumbs = useCrumbs();
  const { pathname } = useLocation();
  const parts = pathname.split('/').filter(Boolean);
  // Same id derivation as Shell's issueId — ids may carry slashes (branch names).
  const issueId = parts[0] === 'issues' && parts[1] ? decodeURIComponent(parts.slice(1).join('/')) : null;
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
            {c.to ? <Link to={c.to} title={c.hint ? hkTitle(c.hint) : undefined}>{c.label}</Link>
              : c.copy ? <CrumbCopy id={c.id} section={c.section} />
              : <span className="crumb-cur">{c.label}</span>}
            {i < crumbs.length - 1 ? <span className="crumb-sep">/</span> : null}
          </span>
        ))}
        <CrumbIssueNav />
      </nav>
      {/* The trailing action buttons are one cluster — a tight internal gap so
          they read as a set, kept separate from the wide crumbs↔actions gap the
          topbar's own flex gap gives. */}
      <div className="topbar-actions">
      {/* Git sync, left of the search icon. ONE control, two places: the board
          syncs the trunk, an issue detail syncs that issue's own branch — so a
          teammate can push and pull the branch for a card from the card. */}
      <DeployRefreshButton />
      {onBoard ? <SyncButton /> : issueId ? <SyncButton env={issueId} /> : null}
      {/* Search opens the ⌘K palette by pointer — present on every route's nav,
          the mouse twin of the global chord. */}
      <button
        type="button"
        className="topbar-btn search-open"
        title={hkTitle('search')}
        aria-label="Search issues"
        onClick={() => window.dispatchEvent(new CustomEvent('dash:open-palette'))}
      >
        <Search size={NAV_ICON} />
      </button>
      {/* Keyboard shortcuts overlay opener, beside search — the pointer twin of
          the `?` chord, and the way in while a field or the terminal owns focus
          (where bare `?` yields). Present on every route's nav. */}
      <button
        type="button"
        className="topbar-btn shortcuts-open"
        title={hkTitle('shortcuts')}
        aria-label="Keyboard shortcuts"
        onClick={() => window.dispatchEvent(new CustomEvent('dash:open-shortcuts'))}
      >
        <Keyboard size={NAV_ICON} />
      </button>
      {/* Two panel toggles, each shown only while its panel is CLOSED — once open,
          the panel's own ✕ (top-left of its navbar) is how you close it. Ordered
          to mirror the columns: chat (inner) then app (outer, hugs the edge). */}
      {!EMBEDDED && !chatOpen ? (
        <button
          className="topbar-btn chat-toggle"
          title="Open AI chat"
          onClick={onToggleChat}
        >
          <ChatIcon />
        </button>
      ) : null}
      {!appOpen ? <WorkspaceToggle onToggle={onToggleApp} /> : null}
      </div>
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

// Is this dash running INSIDE the App-pane iframe (a dash pointed at /dash/, for
// dash-in-dash testing)? Deterministic — a framed window's `top` is a different
// window object than its `self`. When embedded we mount NO chats: the guest is a
// passive view of the board/detail, and spinning up its chat pool would launch
// nested agent sessions the host already owns. (Reading window.top is always
// permitted cross-origin; only the framed document's location is walled off.)
const EMBEDDED = typeof window !== 'undefined' && window.self !== window.top;

function useViewportW() {
  const [w, setW] = React.useState(() => window.innerWidth);
  React.useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return w;
}

// The right chat panel hosts one dev environment via the shared ChatEnvironment
// component — an issue's worktree chats or the MAIN env's repo-root chats, both a
// switcher. The panel exists on every route — the active env (issue on a detail
// route, else main) drives which one is visible. Docked mode carries a
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
      <ChatEnvironment key={envId} issueId={envId} active={open} requestSession={requestSession} />
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
  const issueId = parts[0] === 'issues' && parts[1] ? decodeURIComponent(parts.slice(1).join('/')) : null;
  // The chat is universal: an issue detail shows that issue's chat; every other
  // page shows the persistent main thread. Both stay mounted in the pool below.
  const activeEnv = issueId ?? MAIN_ENV;
  const onBoard = parts.length === 1 && parts[0] === 'issues';

  // The active issue's reserved dev-server port, read from the board's cache
  // (shared key — no extra fetch). null for the main env, where the app panel
  // falls back to this origin's port (the canvas).
  // Shares the 'changes' cache with the always-mounted board, which Realtime
  // keeps fresh — so no timer poll here either.
  const { data: changes } = useIssues('changes', listChanges, { pollMs: 0 });
  const activeChange = issueId ? changes?.find((c) => c.id === issueId) : null;
  const activePort = issueId ? (activeChange?.port ?? null) : null;
  // The App pane's links for whichever env is active. Two facts, one model: the
  // SELECTED route and the extra saved routes. An issue keeps both on its row
  // (read from the same board cache as the port, so no extra fetch); MAIN — this
  // origin, with no row — keeps both in the browser. The list itself is always
  // the base set every dev server serves plus those extras, so an issue that has
  // never been edited still opens with the canvas / dash / graph to hop between.
  const [mainAppPath, setMainAppPath] = React.useState(loadMainPath);
  const [mainAppPaths, setMainAppPaths] = React.useState(loadMainLinks);
  const activeAppPath = normalizeAppPath(issueId ? activeChange?.app_path : mainAppPath);
  const activeAppLinks = React.useMemo(
    () => appLinkList(issueId ? activeChange?.app_paths : mainAppPaths, activeAppPath),
    [issueId, activeChange?.app_paths, mainAppPaths, activeAppPath],
  );

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
  // A pending "open this chat" request from a convo pill or a ⌘K chat hit. The
  // nonce makes re-clicking the same session re-fire the selection in
  // ChatEnvironment; `turnIdx` (a search hit) opens the transcript AT that turn
  // rather than at the end, which is what makes a search result land on the
  // thing you searched for.
  const [reqChat, setReqChat] = React.useState(null);
  const requestChat = React.useCallback((reqIssueId, sessionId, turnIdx = null) => {
    setReqChat((prev) => ({ issueId: reqIssueId, sessionId, turnIdx, nonce: (prev?.nonce ?? 0) + 1 }));
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
  // Per-env App-pane remount nonces (env → count) and which env (if any) is
  // mid dev-server restart. BOTH are per-env so a slow action on issue A — a
  // route commit OR a server restart — can never remount issue B's pane or spin
  // B's ↻ after you've navigated there. `bumpReload(env)` is the single "remount
  // this pane" primitive (re-hits /open); `reloadingEnvs` drives the ↻ spinner.
  const [appReloads, setAppReloads] = React.useState({});
  // A SET of envs mid-restart, not a scalar: restarting A then B leaves BOTH
  // spinning until each finishes, instead of B's restart erasing A's spinner.
  const [reloadingEnvs, setReloadingEnvs] = React.useState(() => new Set());
  const bumpReload = React.useCallback((env) => {
    setAppReloads((m) => ({ ...m, [env]: (m[env] || 0) + 1 }));
  }, []);
  // Select an App-pane route, then remount THIS env's iframe so /open
  // re-redirects onto it. A route the env has never been sent to is SAVED in the
  // same write — that's how the list grows: you type an address, and it joins the
  // links. Base routes need no saving (every list already has them).
  //
  // Two guards make the issue write correct: (1) inspect the write — a rejected
  // write rolls the optimistic cache back, so the pane must stay put, not remount
  // onto the reverted path; (2) the AWAITED write means the remount's /open reads
  // the freshly-committed path, never the optimistic overlay the read could beat
  // to the server. The navbar updates instantly (optimistic), so only the iframe
  // waits on durability. '/' stores as null (canvas default). MAIN has no row:
  // its two facts land in the browser and the iframe follows its src.
  const setActiveAppPath = React.useCallback(async (raw) => {
    const path = normalizeAppPath(raw);
    const custom = (issueId ? activeChange?.app_paths : mainAppPaths) || [];
    const isNew = !isBaseAppPath(path) && !custom.includes(path);
    if (!issueId) {
      setMainAppPath(path);
      saveMainPath(path);
      if (isNew) { const next = [...custom, path]; setMainAppPaths(next); saveMainLinks(next); }
      return;
    }
    const fields = { app_path: path === '/' ? null : path };
    if (isNew) fields.app_paths = [...custom, path];
    const r = await updateChangeFields(issueId, fields);
    if (r?.error) return;
    bumpReload(issueId);
  }, [issueId, activeChange?.app_paths, mainAppPaths, bumpReload]);

  // Forget a saved route. Base routes have no × (they're the floor of every
  // list), so only a custom one gets here. Dropping the route you're ON moves
  // the pane to the link above it — the pane is never left pointing at a link the
  // list no longer offers.
  const removeActiveAppPath = React.useCallback(async (raw) => {
    const path = normalizeAppPath(raw);
    if (isBaseAppPath(path)) return;
    const custom = (issueId ? activeChange?.app_paths : mainAppPaths) || [];
    const next = custom.filter((p) => normalizeAppPath(p) !== path);
    const fallback = path === activeAppPath
      ? activeAppLinks[Math.max(0, activeAppLinks.indexOf(path) - 1)]
      : null;
    // A route can be in the list WITHOUT being saved — the selected one always
    // shows, whoever wrote it (a `board.mjs app-path`, a spawn). Then "remove" is
    // purely the move off it, and the list write is the no-op.
    if (next.length === custom.length && !fallback) return;
    if (!issueId) {
      setMainAppPaths(next);
      saveMainLinks(next);
      if (fallback) { setMainAppPath(fallback); saveMainPath(fallback); }
      return;
    }
    const fields = { app_paths: next };
    if (fallback) fields.app_path = fallback === '/' ? null : fallback;
    const r = await updateChangeFields(issueId, fields);
    if (r?.error || !fallback) return;
    bumpReload(issueId);
  }, [issueId, activeChange?.app_paths, mainAppPaths, activeAppPath, activeAppLinks, bumpReload]);

  // The .main scroller is SHARED by every route (the board and the chat pool
  // stay mounted beneath it), so scroll position is per-route state the element
  // itself can't keep: navigating board → detail collapses the scroller to the
  // detail's content and clamps scroll on BOTH axes — a too-wide board scrolls
  // horizontally on .main too (overflow-y:auto ⇒ overflow-x used-value auto), so
  // the detail (which fits) clamps scrollLeft to 0 just as it clamps scrollTop.
  // Remember each route's position (both axes) as the user scrolls, and restore
  // it when the route becomes active again — a route never visited opens at the
  // origin. The clamp fires its scroll event only after the commit, so it lands
  // under the NEW route's key and never corrupts the position being left
  // behind. Restoring in a layout effect runs after the DOM flip but before
  // paint: the board (always fully rendered, only display-flipped) comes back
  // exactly where it was, with no flash.
  const mainRef = React.useRef(null);
  const scrollMem = React.useRef(new Map());
  const onMainScroll = (e) => scrollMem.current.set(pathname, { left: e.currentTarget.scrollLeft, top: e.currentTarget.scrollTop });
  React.useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const pos = scrollMem.current.get(pathname);
    el.scrollLeft = pos?.left ?? 0;
    el.scrollTop = pos?.top ?? 0;
  }, [pathname]);
  // ⌘-wheel scrolls the .main scroller horizontally — the natural gesture for the
  // wide kanban when a mouse (or trackpad) only sends a vertical delta. Gated on
  // there actually being horizontal room to scroll (the board; not a detail
  // page), so ⌘-wheel keeps its native browser zoom everywhere else. Non-passive
  // so preventDefault takes.
  React.useEffect(() => {
    const el = mainRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (!e.metaKey || !e.deltaY) return;
      if (el.scrollWidth <= el.clientWidth) return; // no horizontal overflow → leave ⌘-wheel to the browser
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

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
  // Embedded, chat is an unavailable capability — the ONE gate that drives every
  // chat-derived thing: its claim on the row (geometry), whether it's open, and
  // the convo-pill affordance (context). Without gating chatRoomW here, a phantom
  // chat width would wrongly shove the nested App pane into overlay mode.
  const chatAvailable = !EMBEDDED;
  const chatRoomW = chatAvailable && chatPref && !chatThin ? chatDockW : 0; // chat's claim on the row
  const appThin = viewportW < sidebarW + chatRoomW + appDockW + MAIN_MIN_W;

  // Open = the user's pref when there's room to dock; the transient overlay flag
  // when the viewport is thin. Docked = open and roomy (drives the grid track).
  // Embedded (dash-in-dash), chat is an UNAVAILABLE capability, not just an
  // unmounted pool: forcing chatOpen false here cascades to chatDocked — so the
  // guest reserves no empty chat column — and the TopBar hides its toggle. The
  // guest is a passive view of the board/detail.
  const chatOpen = chatAvailable && (chatThin ? chatOverlayOpen : chatPref);
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
    if (EMBEDDED) return; // dash-in-dash: no chats (see EMBEDDED)
    if (chatOpen && activeEnv) {
      setOpenedEnvs((prev) => (prev.includes(activeEnv) ? prev : [...prev, activeEnv]));
    }
  }, [chatOpen, activeEnv]);

  // Seed the pool from the LIVE server-side chats (the `/terminal/live` pairs)
  // that each issue has EXPLICITLY selected — its `selected_session`. At most one
  // pane per issue, and only when that chat is already live, so the board still
  // never cold-spawns on load. The env is the SELECTING issue; however many
  // pooled issues later want the same session, only the ownership winner mounts
  // its ChatPane (see session-pool.js). Mounting the (hidden) ChatPane REATTACHES
  // to the running PTY (cheap — no claude spawn, no transcript scan), so opening
  // that card later shows a warm terminal with its scrollback already there.
  //
  // PRE-WARM IS ALL THIS DOES NOW. It was built to make the "needs input" dot
  // populate without a card open, and that reason is gone — the supervisor
  // publishes a state for every live chat and the board reads it directly
  // (activity-store.js), pane or no pane. What is left is a latency trade
  // (N hidden WebSockets and N scrollback replays per board load, against an
  // instant first card open) that should be decided on its own merits.
  //
  // Background work yields to the foreground: the initial seed is DEFERRED to
  // browser idle (first paint + any immediate card-open win) and THROTTLED a
  // couple per tick. A 30s poll catches chats that come alive (or get selected)
  // later (e.g. an autonomously-spawned issue). A ref tracks which SESSIONS have
  // been queued so re-seeds and openedEnvs changes don't double-mount.
  const seededRef = React.useRef(new Set());
  // Latest board rows for link resolution — a ref so the mount-once seed effect
  // below reads fresh data without re-running.
  const changesRef = React.useRef(null);
  changesRef.current = changes;
  React.useEffect(() => {
    if (EMBEDDED) return undefined; // dash-in-dash: never seed/reattach chats
    let cancelled = false;
    let pumpTimer = null;
    const trickleIn = (pairs) => {
      // Link resolution needs the board rows; until they land, defer the whole
      // batch (nothing is marked seeded) and retry shortly.
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
    // Capture the env NOW: navigating away mid-restart must leave the spinner and
    // the eventual remount on the env we actually restarted, not wherever we land.
    const env = activeEnv;
    if (env !== MAIN_ENV) {
      setReloadingEnvs((s) => new Set(s).add(env));
      try { await fetch(`/api/dash/terminal/${encodeURIComponent(env)}/restart`, { method: 'POST' }); } catch { /* show fresh anyway */ }
      setReloadingEnvs((s) => { const n = new Set(s); n.delete(env); return n; });
    }
    bumpReload(env);
  };

  // Make the issue's dev environment from the App pane. Until now the ONLY thing
  // that created a worktree and reserved a port was launching a chat — so anyone
  // working in their own editor instead of the dash chat could never get an app
  // preview at all, and the pane just said "no dev environment" forever. This is
  // the same server action the chat empty state performs, minus the chat: it
  // ensures the worktree and reserves the port. Once the port lands on the row,
  // the pane's existing lazy-start path (/open) brings vite up on its own.
  const createEnv = React.useCallback(async (env) => {
    const r = await fetch('/api/dash/terminal/worktree', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issue: env }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) throw new Error(data.error || 'could not create the dev environment');
    // The server just wrote this issue's row (port, branch, status) — announce it
    // like any other write so the board cache refetches and `activePort` lands.
    emitIssuesChange('UPDATE', { id: env });
    return data;
  }, []);

  // Board focus toggle: on the Issues board, ⌘← parks the keyboard on the kanban
  // (so arrows move the card cursor) and ⌘→ drops it into the chat (so you can
  // type). These are modifier chords, so the shared primitive fires them over
  // the chat terminal too — steering focus back out of xterm, which is the whole
  // point — while keeping them off the browser's native Back/Forward. Disabled
  // when embedded (dash-in-app-pane): there's no chat to focus into.
  useHotkey(hk('focusChat'), () => {
    if (!chatOpen) { if (chatThin) setChatOverlayOpen(true); else { setChatPref(true); localStorage.setItem('dash-chat-open', '1'); } }
    // Two frames: if the chat was just opened, its pane needs a beat to mount
    // before it can take focus; if already open, the extra frame is harmless.
    requestAnimationFrame(() => requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('dash:focus-chat'))));
  }, { enabled: onBoard && !EMBEDDED, terminal: 'handle', when: isBoardRoute });
  useHotkey(hk('focusBoard'), () => window.dispatchEvent(new CustomEvent('dash:focus-board')), { enabled: onBoard && !EMBEDDED, terminal: 'handle', when: isBoardRoute });

  // Drag a docked column's left edge. Width tracks live (the grid var follows
  // state) and persists on release; clamping keeps MAIN_MIN_W of content room
  // given the OTHER docked column's width (so two open panels can't scrunch it).
  // A pane width changed (user dragging a divider) → tell every mounted terminal
  // to refit. This is the ONLY app-driven resize signal besides the browser's own
  // window-resize; terminals no longer watch their own host element, so incidental
  // reflows (a board re-render, a pool show/hide) never reach the PTY.
  React.useEffect(() => {
    window.dispatchEvent(new Event('dash:refit'));
  }, [chatDockW, appDockW]);

  const onChatResizeStart = (e) => startDockResize(e, {
    startW: chatDockW, sidebarW, otherW: appDocked ? appDockW : 0,
    onWidth: setChatW, onEnd: (w) => localStorage.setItem('dash-chat-width', String(w)), setResizing,
  });
  const onAppResizeStart = (e) => startDockResize(e, {
    startW: appDockW, sidebarW, otherW: chatDocked ? chatDockW : 0,
    onWidth: setAppW, onEnd: (w) => localStorage.setItem('dash-app-width', String(w)), setResizing,
  });

  return (
    <ChatControlContext.Provider value={chatAvailable ? requestChat : null}>
    <div
      className={`app${collapsed ? ' collapsed' : ''}${chatDocked ? ' chat-open' : ''}${appDocked ? ' app-open' : ''}${resizing ? ' dock-resizing' : ''}`}
      style={{ '--chat-w': `${chatDockW}px`, '--app-w': `${appDockW}px` }}
    >
      <Sidebar onCollapse={toggleLeft} />
      <div className="content">
        <ControlPlaneBanner />
        <TopBar
          leftCollapsed={collapsed}
          onToggleLeft={toggleLeft}
          onBoard={onBoard}
          chatOpen={chatOpen}
          onToggleChat={toggleChat}
          appOpen={appOpen}
          onToggleApp={toggleApp}
        />
        <div className="main" ref={mainRef} onScroll={onMainScroll}>
          {/* The board mounts ONCE for the whole session and is only hidden when
              you're off the Issues route — never unmounted. Its realtime stream
              stays connected the entire time, so a card that moved while you were
              elsewhere is already in place on return: instant, no stale-paint
              flash. Same persistent-mount pattern as the chat panels below.
              `display:contents` makes the wrapper vanish from layout when shown,
              so the board lays out exactly as a direct .main child would. */}
          <div className="board-mount" style={{ display: onBoard ? 'contents' : 'none' }}>
            <ChangesBoard visible={onBoard} />
          </div>
          <Routes>
            {/* Bare /dash/ lands on the board — the primary surface. Metrics is
                secondary analytics at its own path. `replace` so the redirect
                isn't a back-button trap. */}
            <Route path="/" element={<Navigate to="/issues" replace />} />
            <Route path="/metrics" element={<Metrics />} />
            {/* Keyed by the open issue: prev/next nav changes only the :id
                param, which re-renders but never remounts an unkeyed element —
                so issue-local state (an open body editor, a delete confirm,
                useAsync's cache identity and in-flight refreshes) would leak
                from one issue onto the next and a stale save/confirm/fetch
                would hit the wrong issue. The key remounts the whole detail,
                keeping every closure self-consistent with one issue. */}
            <Route path="/issues/:id" element={<ChangeDetail key={issueId} />} />
            <Route path="/tests" element={<TestsList />} />
            <Route path="/tests/:name" element={<TestDetail />} />
            <Route path="/recordings" element={<Recordings />} />
            {/* `tests/<name>` ids carry a slash, so the id is a splat rather
                than a single param — one route for both namespaces. */}
            <Route path="/recordings/*" element={<RecordingDetail />} />
          </Routes>
        </div>
      </div>
      {/* Chat pool — mounted only in a top-level dash. An embedded dash (App
          pane pointed at /dash/) shows the board/detail but spins up no chats,
          so dash-in-dash never launches nested agent sessions (see EMBEDDED). */}
      {!EMBEDDED && openedEnvs.map((id) => (
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
          appPath={activeAppPath}
          appLinks={activeAppLinks}
          reloadKey={appReloads[activeEnv] || 0}
          reloading={reloadingEnvs.has(activeEnv)}
          mode={appThin ? 'overlay' : 'docked'}
          open
          onClose={toggleApp}
          onReload={reloadApp}
          onCreateEnv={createEnv}
          onSetAppPath={setActiveAppPath}
          onRemoveAppPath={removeActiveAppPath}
          onResizeStart={onAppResizeStart}
        />
      )}
      {/* ⌘K command palette — a route-agnostic modal (portals to body), so it
          works over the board, a detail view, or the chat terminal alike. */}
      <CommandPalette />
      {/* `?` keyboard-shortcuts overlay — same portal pattern, renders the one
          hotkey registry grouped by scope. */}
      <ShortcutsOverlay />
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
    <BrowserRouter basename={DASH_BASENAME} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <SelectionProvider>
        <Shell />
      </SelectionProvider>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')).render(<App />);
