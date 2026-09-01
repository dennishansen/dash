import React from 'react';
import { DockPanel } from './dock.jsx';
import { useHotkey } from './hotkeys.js';
import { hk, hkCaps, formatCombo } from './hotkey-registry.js';
import { MAIN_ENV, appUrlForEnv, appPortForEnv, normalizeAppPath, isBaseAppPath } from './app-env.mjs';
import { emptyPaneHistory, recordPaneRoute, stepPaneHistory, canStepPane, paneEntry } from './pane-history.mjs';
import { sameHostAuthority, sameHostOrigin } from './same-host-origin.mjs';
import { copyText, copyFailureHint } from './clipboard.js';
import {
  Refresh, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, ArrowUpRight,
  Copy, Check, X, NAV_ICON, NAV_CARET,
} from './icons.jsx';
import { useChatStatus } from './api.js';
import { useEnvSession } from './chat-session-store.js';
import { PaneEmpty, PaneEmptyButton } from './PaneEmpty.jsx';

// The code view loads lazily, and a lazy pane's failure must stay pane-sized:
// an uncaught import error here unmounts the whole dash shell, and because the
// App|Code segment persists, the crash replays on every load. React.lazy holds
// on to a rejection forever, so retrying means minting a fresh lazy component.
const makeCodeBrowser = () => React.lazy(() => import('./CodeBrowser.jsx').then((module) => ({ default: module.CodeBrowser })));

class CodePaneBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  retry = () => { this.props.onRetry(); this.setState({ error: null }); };
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <PaneEmpty
        title="Code view failed to load"
        error={String(this.state.error?.message || this.state.error)}
        actions={<PaneEmptyButton onClick={this.retry}>Retry</PaneEmptyButton>}
      >
        <p>
          Usually a stale module cache after the dev server re-bundled. If retry
          doesn&apos;t fix it, hard-reload with the cache bypassed
          (Ctrl/Cmd-Shift-R). The App view keeps working either way.
        </p>
      </PaneEmpty>
    );
  }
}

// The App|Code segment persists as a single browser-wide preference, so reopening
// any workspace lands on the view you last used instead of resetting to App.
const APP_VIEW_KEY = 'dash-app-view';
const loadAppView = () => {
  try { return localStorage.getItem(APP_VIEW_KEY) === 'code' ? 'code' : 'app'; }
  catch { return 'app'; }
};

// App = the running preview (a monitor); Code = the repo view (a </> glyph).
const AppIcon = () => (
  <svg width={NAV_ICON} height={NAV_ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" />
  </svg>
);
const CodeIcon = () => (
  <svg width={NAV_ICON} height={NAV_ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />
  </svg>
);

// The +/- LOC badge that used to live in Claude Code's terminal status bar, now
// native in the code-pane nav. Same number (lines added/removed this chat, reset
// on /clear) — it just tracks whichever chat the chat pane has selected.
function LocBadge({ added, removed }) {
  return (
    <span className="loc-badge" title="Lines changed this chat (added / removed)">
      <span className="loc-badge-add">+{added}</span>
      <span className="loc-badge-del">−{removed}</span>
    </span>
  );
}

// The rightmost dock is one workspace inspector with two stable modes. App owns
// the running iframe and its lifecycle actions; Code owns repository navigation
// and review. Both remain mounted after first use, so changing the segment never
// resets the iframe or the selected file.
export function WorkspacePanel({ env, port, appPath = '/', appLinks = ['/'], reloadKey = 0, reloading = false, mode, open, onClose, onReload, onCreateEnv, onSetAppPath, onRemoveAppPath, onResizeStart }) {
  const shownPort = appPortForEnv(env, port);
  const available = !!shownPort;
  // Creating the dev environment from here (see the empty state below). MAIN
  // always has one — it's this origin — so only an issue can be in this state.
  const [creating, setCreating] = React.useState(false);
  const [createErr, setCreateErr] = React.useState(null);
  const canCreate = !available && env !== MAIN_ENV && !!onCreateEnv;
  const createEnv = async () => {
    setCreating(true);
    setCreateErr(null);
    try { await onCreateEnv(env); } catch (e) { setCreateErr(e.message); }
    finally { setCreating(false); }
  };
  // Every env's route is editable — an issue stores it on its row, MAIN in the
  // browser (app-links.js). The panel only needs the setter to exist.
  const pathEditable = !!onSetAppPath;
  const [view, setView] = React.useState(loadAppView);
  const chatSession = useEnvSession(env);
  const chatStatus = useChatStatus(chatSession);
  const [codeMounted, setCodeMounted] = React.useState(() => loadAppView() === 'code');
  const [codeGen, setCodeGen] = React.useState(0);
  const CodeBrowser = React.useMemo(makeCodeBrowser, [codeGen]);
  const [frameBust, setFrameBust] = React.useState(0);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const actionsRef = React.useRef(null);
  const iframeRef = React.useRef(null);
  const inputRef = React.useRef(null);
  // The saved-links dropdown, open while the address input holds focus. The
  // address bar stays a plain text field — typing a route it hasn't seen adds
  // that route to the list — so this is a shortcut to the saved ones, never the
  // only way to reach a page.
  const [linksOpen, setLinksOpen] = React.useState(false);

  // appLinks ALWAYS contains the selected path (appLinkList guarantees it), so
  // stepping wraps through a list the current page is really in — no "not found"
  // branch, no dead first press. This is where the pane OPENS, which is what the
  // links, the steppers and the iframe's src are all about; where it currently
  // IS is `liveRoute` below, and the two part company as soon as the app inside
  // navigates.
  const selected = normalizeAppPath(appPath);
  const linkIndex = Math.max(0, appLinks.indexOf(selected));
  const stepLink = React.useCallback((delta) => {
    if (appLinks.length < 2) return;
    const next = appLinks[(linkIndex + delta + appLinks.length) % appLinks.length];
    if (next !== selected) onSetAppPath?.(next);
  }, [appLinks, linkIndex, selected, onSetAppPath]);

  React.useEffect(() => {
    if (!menuOpen) return undefined;
    const onDoc = (event) => {
      if (actionsRef.current && !actionsRef.current.contains(event.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

  const selectView = (next) => {
    setView(next);
    setMenuOpen(false);
    if (next === 'code') setCodeMounted(true);
    try { localStorage.setItem(APP_VIEW_KEY, next); } catch { /* private mode: skip */ }
  };
  const onViewKeyDown = (event) => {
    const next = event.key === 'ArrowRight' || event.key === 'End' ? 'code'
      : event.key === 'ArrowLeft' || event.key === 'Home' ? 'app'
        : null;
    if (!next) return;
    event.preventDefault();
    const tablist = event.currentTarget.parentElement;
    selectView(next);
    requestAnimationFrame(() => tablist?.querySelector(`[data-view="${next}"]`)?.focus());
  };
  // Default refresh PRESERVES the in-iframe route. The app view is cross-origin
  // (worktree port ≠ dash origin), so the parent can neither read its live URL
  // nor call reload() on it — both throw. Instead we ping the embedded app,
  // which reloads ITSELF same-origin (see installGuestReload); whatever route it
  // navigated to survives. This is a COOPERATING-guest capability — our own
  // entry points (canvas, dash, graph) install the listener; a launch route on
  // some page that doesn't is simply a no-op here, and Hard refresh (which
  // remounts src with a cache-bust) is the universal fallback that reloads ANY
  // route back to its launch point.
  const refreshApp = () => iframeRef.current?.contentWindow?.postMessage({ type: 'artifact:reload' }, '*');
  const hardRefreshApp = () => setFrameBust(Date.now());
  const frameUrl = appUrlForEnv(env, appPath);

  // ── The pane's own back/forward ──────────────────────────────────────────
  // The chrome keeps the stack, because the browser's own history can't be
  // walked one frame at a time — one joint session history per TAB, so a guest
  // told to step "its own" history steps whoever navigated last, which is this
  // dash as often as the pane (i-app-pane-history). See pane-history.mjs. The
  // guest reports where it is; we tell it where to go.
  const [paneHistory, setPaneHistory] = React.useState(emptyPaneHistory);
  // A new iframe is a new page, so the record starts over with it. Same key the
  // element gets, so the two can never disagree about which page this is.
  const frameKey = `${env}:${reloadKey}:${frameBust}`;
  React.useEffect(() => { setPaneHistory(emptyPaneHistory()); }, [frameKey]);
  React.useEffect(() => {
    // Only our own frame's reports count. Cross-origin hides the guest's URL
    // from us — that's the whole reason it has to tell us — so identity is the
    // window itself, which no other sender can forge.
    const onMessage = (event) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type !== 'artifact:route' || typeof event.data.path !== 'string') return;
      setPaneHistory((history) => recordPaneRoute(history, event.data));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  const stepFrame = (delta) => {
    const stepped = stepPaneHistory(paneHistory, delta);
    if (!stepped) return;
    setPaneHistory(stepped.history);
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'artifact:go', path: stepped.target.path, state: stepped.target.state }, '*',
    );
  };
  // Where the pane IS — the address a URL bar is supposed to show. Until the
  // guest's first report we have nothing better than where we sent it, and a
  // guest that never reports (a route that isn't one of our apps) keeps showing
  // that forever, which is the honest answer for a frame we cannot read.
  const liveRoute = paneEntry(paneHistory)?.path ?? selected;
  // ↗ opens what the bar is showing. Only MAIN can honour that: an issue env is
  // reached through /open, whose whole job is to START the dev server and then
  // redirect onto the route stored on its row — a direct link to the port would
  // be a dead one whenever the server is asleep. appUrlForEnv already knows that
  // difference, so it is handed the live route and each env gives its best.
  // Deliberately NOT the iframe's src: that is keyed on the launch route, and
  // rewriting it as the guest navigates would drive the frame from behind.
  const openUrl = appUrlForEnv(env, liveRoute);
  // The address bar's editable path segment. It shows the LIVE route, the way a
  // browser's does — click a link inside the pane and the address follows it.
  // Re-synced whenever that route changes, except while you are typing into it:
  // the pane can move under your caret, and clobbering a half-typed route would
  // be the field editing itself.
  const [pathDraft, setPathDraft] = React.useState(selected);
  React.useEffect(() => {
    if (typeof document !== 'undefined' && document.activeElement === inputRef.current) return;
    setPathDraft(liveRoute);
  }, [liveRoute]);
  // What the field was showing when you took the caret. An edit is a change from
  // THAT, not from the stored launch route — otherwise merely clicking into a
  // bar that had followed the pane somewhere would commit a route you never typed.
  const shownOnFocus = React.useRef(selected);

  // The bar LABELS the pane with an authority and a route; a copy has to hand
  // you something you can paste into a browser, so it carries the scheme this
  // dash is on as well. Same route the field shows, so a copy is the page you
  // are looking at rather than the one the pane opened on.
  const appAddress = !available || typeof location === 'undefined' ? null
    : `${sameHostOrigin(location.host, shownPort, location.protocol)}${liveRoute}`;
  // "copied ✓" means it is ON the clipboard — the write's own answer, never the
  // click's (src/clipboard.js). A failure keeps the ✓ off and says why.
  const [copyState, setCopyState] = React.useState('idle');   // idle | copied | failed
  const copyTimer = React.useRef(null);
  React.useEffect(() => () => clearTimeout(copyTimer.current), []);
  const copyAddress = async () => {
    const ok = await copyText(appAddress);
    setCopyState(ok ? 'copied' : 'failed');
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopyState('idle'), ok ? 1000 : 6000);
    // The value is right there in the field, so the manual fallback is to hand
    // you the caret in it — focus selects the route (onFocus), the one part the
    // ⌘C is for.
    if (!ok) inputRef.current?.focus();
  };
  // Hard refresh cache-busts by MERGING a param, not by appending `?cb=` — a
  // saved route is allowed to carry its own query (`/dash/issues?tag=x`), and a
  // second `?` would make the whole thing one nonsense path.
  const frameSrc = React.useMemo(() => {
    if (!frameBust) return frameUrl;
    const u = new URL(frameUrl, window.location.origin);
    u.searchParams.set('cb', String(frameBust));
    return `${u.pathname}${u.search}${u.hash}`;
  }, [frameUrl, frameBust]);

  // Commit an edited App-pane route on blur: normalize, and only write when you
  // actually changed what was in front of you. onSetAppPath persists it as the
  // launch route and remounts the iframe onto it. Escape must CANCEL — but
  // blur() fires this synchronously before a setPathDraft has flushed, so a ref
  // (not state) carries the cancel intent: false ⇒ discard the edit.
  // Cancelling and committing-nothing both snap back to the LIVE route, which
  // also absorbs any move the pane made while the caret was in the field.
  const commitRef = React.useRef(true);
  const commitPath = () => {
    const cancelled = !commitRef.current;
    commitRef.current = true;
    const next = normalizeAppPath(pathDraft);
    if (cancelled || next === shownOnFocus.current) { setPathDraft(liveRoute); return; }
    setPathDraft(next);
    onSetAppPath(next);
  };
  const onPathKeyDown = (event) => {
    if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
    else if (event.key === 'Escape') { event.preventDefault(); commitRef.current = false; event.currentTarget.blur(); }
    // ↑/↓ inside the address walk the saved links, the same move the ⌃⌄ steppers
    // and ⌥⌘↑/↓ make — so the open dropdown is navigable from the keyboard
    // without a second highlight-then-confirm model to keep in sync.
    else if (event.key === 'ArrowUp') { event.preventDefault(); stepLink(-1); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); stepLink(1); }
  };
  // Picking a saved link: mousedown (not click) with the default prevented, so
  // the input never blurs mid-pick and fires a stale commit of its draft.
  const pickLink = (event, path) => {
    event.preventDefault();
    setLinksOpen(false);
    // The pick REPLACES whatever was typed, so the blur it causes must not
    // commit that half-typed draft — same cancel intent Escape uses.
    commitRef.current = false;
    inputRef.current?.blur();
    if (path !== liveRoute) onSetAppPath?.(path);
  };
  // The whole field is the address, so clicking any of it — the host half, the
  // slack to the right of a short route — puts the caret in the part you can
  // actually type. Only the input and the open link list own their own clicks.
  const focusAddress = (event) => {
    if (event.target.closest?.('.app-bar-path, .app-bar-links')) return;
    event.preventDefault();
    inputRef.current?.focus();
  };
  const dropLink = (event, path) => {
    event.preventDefault();
    event.stopPropagation();
    onRemoveAppPath?.(path);
  };

  // ⌘E flips App ⇆ Code while the panel is open — a fully LEFT-HANDED chord so
  // it works one-handed, and (unlike the old ⌘/) it fires even while the chat
  // terminal owns focus, because it rides the shared hotkey primitive's chord-
  // transparency (dash/src/hotkeys.js). It doesn't collide with the dash's
  // directional chords (⌘←/→ steer focus, ⌘↑/↓ page issues). When focus is
  // INSIDE the app iframe (cross-origin) its keydowns can't reach us — the
  // toggle works when the dash chrome or terminal holds focus.
  useHotkey(hk('appCode'), () => selectView(view === 'app' ? 'code' : 'app'), { enabled: open, terminal: 'handle', repeat: false });

  // ⌥⌘↑/↓ walk the pane's saved links — the keyboard twin of the ⌃⌄ steppers in
  // the address bar. ⌘↑/↓ alone already pages issues, so the app pane's own
  // vertical pair takes ⌥ on top of it; nothing else binds ⌥⌘ + an arrow.
  useHotkey(hk('appLink', 'prev'), () => stepLink(-1), { enabled: open && view === 'app' && available, terminal: 'handle', repeat: false });
  useHotkey(hk('appLink', 'next'), () => stepLink(1), { enabled: open && view === 'app' && available, terminal: 'handle', repeat: false });

  return (
    <DockPanel
      prefix="app"
      mode={mode}
      open={open}
      onClose={onClose}
      onResizeStart={onResizeStart}
      closeLabel="Close workspace panel"
    >
      <div className="app-bar workspace-bar">
        <div className="workspace-switch" role="tablist" aria-label="Workspace view">
          <button type="button" role="tab" data-view="app" aria-selected={view === 'app'} tabIndex={view === 'app' ? 0 : -1}
            title={`App view (${hkCaps('appCode')})`} aria-label="App view" className={view === 'app' ? 'is-selected' : ''} onClick={() => selectView('app')} onKeyDown={onViewKeyDown}><AppIcon /></button>
          <button type="button" role="tab" data-view="code" aria-selected={view === 'code'} tabIndex={view === 'code' ? 0 : -1}
            title={`Code view (${hkCaps('appCode')})`} aria-label="Code view" className={view === 'code' ? 'is-selected' : ''} onClick={() => selectView('code')} onKeyDown={onViewKeyDown}><CodeIcon /></button>
        </div>
        {view === 'code' && chatStatus ? <LocBadge added={chatStatus.added} removed={chatStatus.removed} /> : null}
        {view === 'app' ? (
          <>
            {available ? (
              /* Dead at the ends, like every browser's — the pane keeps the
                 stack now, so it knows when there is nowhere to go. */
              <div className="app-bar-nav">
                <button type="button" className="app-bar-reload" onClick={() => stepFrame(-1)}
                  disabled={!canStepPane(paneHistory, -1)} title="Back" aria-label="Back">
                  <ChevronLeft size={NAV_ICON} />
                </button>
                <button type="button" className="app-bar-reload" onClick={() => stepFrame(1)}
                  disabled={!canStepPane(paneHistory, 1)} title="Forward" aria-label="Forward">
                  <ChevronRight size={NAV_ICON} />
                </button>
              </div>
            ) : null}
            {/* One field, the width of the bar, holding the WHOLE address: the
                authority (fixed — the port belongs to this env's dev server)
                and the route (yours to type). It used to be a bare host label
                with a three-character nub after it, so the only part you could
                click was the `/`; now the address is the thing, and the actions
                sit at the far edge where it ends. */}
            {available ? (
              <div className="app-bar-address" onMouseDown={focusAddress}>
                <span className="app-bar-host">
                  {sameHostAuthority(typeof location !== 'undefined' ? location.host : '', shownPort)}
                </span>
                {pathEditable ? (
                  <span className="app-bar-path-wrap">
                    <input
                      ref={inputRef}
                      className="app-bar-path"
                      value={pathDraft}
                      onChange={(event) => setPathDraft(event.target.value)}
                      onFocus={(event) => { shownOnFocus.current = normalizeAppPath(pathDraft); event.target.select(); setLinksOpen(true); }}
                      onKeyDown={onPathKeyDown}
                      onBlur={() => { setLinksOpen(false); commitPath(); }}
                      spellCheck={false}
                      autoComplete="off"
                      role="combobox"
                      aria-expanded={linksOpen}
                      aria-controls="app-bar-links"
                      title="The pane's address — where it is right now, following the app as it navigates. Type any route to go there and save it as the pane's launch route; ↑/↓ walk the saved ones."
                      aria-label="App-pane address"
                    />
                    {linksOpen && appLinks.length > 1 ? (
                      <div className="app-bar-links" id="app-bar-links" role="listbox" aria-label="Saved app links">
                        {appLinks.map((path) => (
                          <div
                            key={path}
                            role="option"
                            aria-selected={path === selected}
                            className={`app-bar-link${path === selected ? ' is-selected' : ''}`}
                            onMouseDown={(event) => pickLink(event, path)}
                          >
                            <span className="app-bar-link-path">{path}</span>
                            {isBaseAppPath(path) || !onRemoveAppPath ? null : (
                              <button type="button" className="app-bar-link-drop"
                                onMouseDown={(event) => dropLink(event, path)}
                                title={`Remove ${path}`} aria-label={`Remove ${path}`}>
                                <X size={11} />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </span>
                ) : null}
              </div>
            ) : <span className="app-bar-host dim">no dev server</span>}
            {/* Everything you can DO to the address, in one cluster at the far
                edge: walk the saved routes, take the address away with you,
                open it somewhere else, reload it. Refresh sits last because it
                is the one that acts on the pane rather than on the address. */}
            {available ? (
              <div className="app-bar-actions" ref={actionsRef}>
                {appLinks.length > 1 ? (
                  <div className="app-bar-steps">
                    <button type="button" className="app-bar-reload" onClick={() => stepLink(-1)}
                      title={`Previous app link (${formatCombo(hk('appLink', 'prev'))})`} aria-label="Previous app link">
                      <ChevronUp size={NAV_ICON} />
                    </button>
                    <button type="button" className="app-bar-reload" onClick={() => stepLink(1)}
                      title={`Next app link (${formatCombo(hk('appLink', 'next'))})`} aria-label="Next app link">
                      <ChevronDown size={NAV_ICON} />
                    </button>
                  </div>
                ) : null}
                <button type="button"
                  className={`app-bar-reload app-bar-copy${copyState === 'copied' ? ' is-copied' : ''}${copyState === 'failed' ? ' is-failed' : ''}`}
                  onClick={copyAddress}
                  title={copyState === 'copied' ? 'Copied!' : copyState === 'failed' ? copyFailureHint() : `Copy the address (${appAddress})`}
                  aria-label="Copy the address">
                  {copyState === 'copied' ? <Check size={NAV_ICON} /> : <Copy size={NAV_ICON} />}
                </button>
                <a className="app-bar-reload" href={openUrl} target="_blank" rel="noreferrer"
                  title="Open the app in a new tab" aria-label="Open the app in a new tab">
                  <ArrowUpRight size={NAV_ICON} />
                </a>
                <div className="app-bar-split">
                  <button type="button" className={`app-bar-reload app-bar-split-main${reloading ? ' app-bar-reload--busy' : ''}`}
                    onClick={refreshApp} title="Refresh the app view" aria-label="Refresh the app view">
                    <Refresh size={NAV_ICON} />
                  </button>
                  <button type="button" className="app-bar-reload app-bar-split-caret"
                    onClick={() => setMenuOpen((value) => !value)}
                    title="Refresh options" aria-label="Refresh options" aria-haspopup="menu" aria-expanded={menuOpen}>
                    <ChevronDown size={NAV_CARET} />
                  </button>
                  {menuOpen ? (
                    <div className="app-bar-menu" role="menu">
                      <button type="button" role="menuitem" onClick={() => { refreshApp(); setMenuOpen(false); }}>refresh app</button>
                      <button type="button" role="menuitem" onClick={() => { hardRefreshApp(); setMenuOpen(false); }}>hard refresh</button>
                      <button type="button" role="menuitem" disabled={reloading} onClick={() => { onReload(); setMenuOpen(false); }}>refresh server</button>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : canCreate ? null : (
              /* With no reserved port there is no server to restart — /restart
                 answers 409 — so the button only exists where it can act. When
                 the environment can be CREATED, the empty state below carries
                 that action instead of a restart that would fail. */
              <button type="button" className={`app-bar-reload workspace-restart${reloading ? ' app-bar-reload--busy' : ''}`}
                onClick={onReload} disabled={reloading} title="Restart the dev server" aria-label="Restart the dev server">
                <Refresh size={NAV_ICON} />
              </button>
            )}
          </>
        ) : null}
      </div>

      <div className="workspace-view workspace-view--app" hidden={view !== 'app'}>
        {available ? (
          <iframe
            ref={iframeRef}
            /* reloadKey carries BOTH the server-restart bump and this env's
               app-path remount nonce (Shell), so committing a new route replaces
               this iframe and /open re-redirects onto it. frameBust = hard refresh. */
            key={frameKey}
            className="app-frame"
            src={frameSrc}
            title="Running app"
            allow="clipboard-write *; microphone *"
          />
        ) : (
          /* Not a dead end. Making the worktree + reserving the port is one
             server action, and until now the only thing that performed it was
             launching a chat — which someone working in their own editor never
             does. Same shape as the chat pane's empty state on purpose: it reads
             as the one "this environment doesn't exist yet — make it" pattern,
             not a second idea. Once the port exists the pane's /open path starts
             vite by itself. */
          <PaneEmpty
            title="No dev environment yet"
            error={createErr}
            actions={canCreate ? (
              <PaneEmptyButton onClick={createEnv} disabled={creating}>
                {creating ? 'Creating…' : 'Create dev environment'}
              </PaneEmptyButton>
            ) : null}
          >
            {canCreate ? (
              <p>
                Make an isolated git worktree for <code>{env}</code> and start its
                dev server, so this pane can show the app running on that branch.
              </p>
            ) : (
              <p>This issue has no worktree dev server to embed.</p>
            )}
          </PaneEmpty>
        )}
      </div>
      {codeMounted ? (
        <div className="workspace-view workspace-view--code" hidden={view !== 'code'}>
          <CodePaneBoundary onRetry={() => setCodeGen((gen) => gen + 1)}>
            <React.Suspense fallback={<PaneEmpty title="Loading code view…" />}>
              <CodeBrowser env={env} active={view === 'code'} />
            </React.Suspense>
          </CodePaneBoundary>
        </div>
      ) : null}
    </DockPanel>
  );
}
