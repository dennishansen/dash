import React from 'react';
import { DockPanel } from './dock.jsx';
import { useHotkey } from './hotkeys.js';
import { hk, hkCaps } from './hotkey-registry.js';
import { MAIN_ENV, appUrlForEnv, appPortForEnv, normalizeAppPath } from './app-env.mjs';
import { Refresh, ChevronDown, ChevronLeft, ChevronRight, ArrowUpRight } from './icons.jsx';
import { useChatStatus } from './api.js';
import { useEnvSession } from './chat-session-store.js';

const CodeBrowser = React.lazy(() => import('./CodeBrowser.jsx').then((module) => ({ default: module.CodeBrowser })));

// App = the running preview (a monitor); Code = the repo view (a </> glyph).
const AppIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" />
  </svg>
);
const CodeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
export function WorkspacePanel({ env, port, appPath = '/', reloadKey = 0, reloading = false, mode, open, onClose, onReload, onSetAppPath, onResizeStart }) {
  const shownPort = appPortForEnv(env, port);
  const available = !!shownPort;
  // The App-pane route is editable only for issue envs — MAIN is the canvas at
  // this origin (no worktree row to store a path on).
  const pathEditable = env !== MAIN_ENV && !!onSetAppPath;
  const [view, setView] = React.useState('app');
  const chatSession = useEnvSession(env);
  const chatStatus = useChatStatus(chatSession);
  const [codeMounted, setCodeMounted] = React.useState(false);
  const [frameBust, setFrameBust] = React.useState(0);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const actionsRef = React.useRef(null);
  const iframeRef = React.useRef(null);
  // The address bar's editable path segment. Seeded from the stored path and
  // re-synced whenever it changes (including right after a commit remounts the
  // iframe onto the new route).
  const [pathDraft, setPathDraft] = React.useState(appPath);
  React.useEffect(() => { setPathDraft(appPath); }, [appPath]);

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
  // Back/forward step the guest's OWN history — same cooperating-guest channel as
  // refresh, because the cross-origin frame's history is unreachable from here.
  // We can't read its history length across origins, so both stay enabled and are
  // a no-op at either end (exactly how a browser's chrome behaves there).
  const backApp = () => iframeRef.current?.contentWindow?.postMessage({ type: 'artifact:back' }, '*');
  const forwardApp = () => iframeRef.current?.contentWindow?.postMessage({ type: 'artifact:forward' }, '*');
  const hardRefreshApp = () => setFrameBust(Date.now());
  const frameUrl = appUrlForEnv(env);

  // Commit an edited App-pane route on blur: normalize, and only write when it
  // actually changed. onSetAppPath persists it and remounts the iframe onto the
  // new path. Escape must CANCEL — but blur() fires this synchronously before a
  // setPathDraft has flushed, so a ref (not state) carries the cancel intent:
  // false ⇒ discard the edit and snap back to the stored path.
  const commitRef = React.useRef(true);
  const commitPath = () => {
    if (!commitRef.current) { commitRef.current = true; setPathDraft(normalizeAppPath(appPath)); return; }
    const next = normalizeAppPath(pathDraft);
    setPathDraft(next);
    if (next !== normalizeAppPath(appPath)) onSetAppPath(next);
  };
  const onPathKeyDown = (event) => {
    if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
    else if (event.key === 'Escape') { event.preventDefault(); commitRef.current = false; event.currentTarget.blur(); }
  };

  // ⌘E flips App ⇆ Code while the panel is open — a fully LEFT-HANDED chord so
  // it works one-handed, and (unlike the old ⌘/) it fires even while the chat
  // terminal owns focus, because it rides the shared hotkey primitive's chord-
  // transparency (dash/src/hotkeys.js). It doesn't collide with the dash's
  // directional chords (⌘←/→ steer focus, ⌘↑/↓ page issues). When focus is
  // INSIDE the app iframe (cross-origin) its keydowns can't reach us — the
  // toggle works when the dash chrome or terminal holds focus.
  useHotkey(hk('appCode'), () => selectView(view === 'app' ? 'code' : 'app'), { enabled: open, terminal: 'handle', repeat: false });

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
              <div className="app-bar-nav">
                <button type="button" className="app-bar-reload" onClick={backApp}
                  title="Back" aria-label="Back">
                  <ChevronLeft size={14} />
                </button>
                <button type="button" className="app-bar-reload" onClick={forwardApp}
                  title="Forward" aria-label="Forward">
                  <ChevronRight size={14} />
                </button>
              </div>
            ) : null}
            {available ? (
              <span className="app-bar-host">
                localhost:{shownPort}
                {pathEditable ? (
                  <input
                    className="app-bar-path"
                    value={pathDraft}
                    size={Math.max(3, pathDraft.length + 1)}
                    onChange={(event) => setPathDraft(event.target.value)}
                    onFocus={(event) => event.target.select()}
                    onKeyDown={onPathKeyDown}
                    onBlur={commitPath}
                    spellCheck={false}
                    autoComplete="off"
                    title="App-pane launch route — where the pane opens (e.g. / for the canvas, /dash/ for the dash). Editing reloads the pane here now; an external change applies on the next open or refresh. It shows the stored route, not the pane's live in-frame location."
                    aria-label="App-pane launch route"
                  />
                ) : null}
              </span>
            ) : <span className="app-bar-host dim">no dev server</span>}
            {available ? (
              <div className="app-bar-actions" ref={actionsRef}>
                <div className="app-bar-split">
                  <button type="button" className={`app-bar-reload app-bar-split-main${reloading ? ' app-bar-reload--busy' : ''}`}
                    onClick={refreshApp} title="Refresh the app view" aria-label="Refresh the app view">
                    <Refresh size={13} />
                  </button>
                  <button type="button" className="app-bar-reload app-bar-split-caret"
                    onClick={() => setMenuOpen((value) => !value)}
                    title="Refresh options" aria-label="Refresh options" aria-haspopup="menu" aria-expanded={menuOpen}>
                    <ChevronDown size={11} />
                  </button>
                  {menuOpen ? (
                    <div className="app-bar-menu" role="menu">
                      <button type="button" role="menuitem" onClick={() => { refreshApp(); setMenuOpen(false); }}>refresh app</button>
                      <button type="button" role="menuitem" onClick={() => { hardRefreshApp(); setMenuOpen(false); }}>hard refresh</button>
                      <button type="button" role="menuitem" disabled={reloading} onClick={() => { onReload(); setMenuOpen(false); }}>refresh server</button>
                    </div>
                  ) : null}
                </div>
                <a className="app-bar-reload" href={appUrlForEnv(env)} target="_blank" rel="noreferrer"
                  title="Open the app in a new tab" aria-label="Open the app in a new tab">
                  <ArrowUpRight size={13} />
                </a>
              </div>
            ) : (
              <button type="button" className={`app-bar-reload workspace-restart${reloading ? ' app-bar-reload--busy' : ''}`}
                onClick={onReload} disabled={reloading} title="Restart the dev server" aria-label="Restart the dev server">
                <Refresh size={13} />
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
            key={`${env}:${reloadKey}:${frameBust}`}
            className="app-frame"
            src={frameBust ? `${frameUrl}?cb=${frameBust}` : frameUrl}
            title="Running app"
            allow="clipboard-write *; microphone *"
          />
        ) : (
          <div className="app-empty">
            <p className="app-empty-title">No dev environment yet</p>
            <p className="app-empty-sub">This issue has no worktree dev server to embed.</p>
          </div>
        )}
      </div>
      {codeMounted ? (
        <div className="workspace-view workspace-view--code" hidden={view !== 'code'}>
          <React.Suspense fallback={<div className="code-empty"><p>Loading code view…</p></div>}>
            <CodeBrowser env={env} active={view === 'code'} />
          </React.Suspense>
        </div>
      ) : null}
    </DockPanel>
  );
}
