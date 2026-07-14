import React from 'react';
import { DockPanel } from './dock.jsx';
import { appUrlForEnv, appPortForEnv } from './app-env.js';
import { Refresh, ChevronDown, ArrowUpRight } from './icons.jsx';

const CodeBrowser = React.lazy(() => import('./CodeBrowser.jsx').then((module) => ({ default: module.CodeBrowser })));

// The rightmost dock is one workspace inspector with two stable modes. App owns
// the running iframe and its lifecycle actions; Code owns repository navigation
// and review. Both remain mounted after first use, so changing the segment never
// resets the iframe or the selected file.
export function WorkspacePanel({ env, port, reloadKey = 0, reloading = false, mode, open, onClose, onReload, onResizeStart }) {
  const shownPort = appPortForEnv(env, port);
  const available = !!shownPort;
  const [view, setView] = React.useState('app');
  const [codeMounted, setCodeMounted] = React.useState(false);
  const [frameNonce, setFrameNonce] = React.useState(0);
  const [frameBust, setFrameBust] = React.useState(0);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const actionsRef = React.useRef(null);

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
  const refreshApp = () => setFrameNonce((nonce) => nonce + 1);
  const hardRefreshApp = () => setFrameBust(Date.now());
  const frameUrl = appUrlForEnv(env);

  // ⌘/ toggles App ⇆ Code while the panel is open — an ergonomic flip that
  // doesn't collide with the dash's directional chords (⌘←/→ steer focus, ⌘↑/↓
  // page issues). Capture phase so it wins before anything else; ignored while a
  // text field owns focus so it never eats a literal slash you're typing. Note:
  // when focus is INSIDE the app iframe (cross-origin) its keydowns can't reach
  // us — the toggle works when the dash chrome holds focus.
  React.useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key !== '/' && e.code !== 'Slash') return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      selectView(view === 'app' ? 'code' : 'app');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, view]);

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
            title="App view (⌘/)" className={view === 'app' ? 'is-selected' : ''} onClick={() => selectView('app')} onKeyDown={onViewKeyDown}>App</button>
          <button type="button" role="tab" data-view="code" aria-selected={view === 'code'} tabIndex={view === 'code' ? 0 : -1}
            title="Code view (⌘/)" className={view === 'code' ? 'is-selected' : ''} onClick={() => selectView('code')} onKeyDown={onViewKeyDown}>Code</button>
        </div>
        {view === 'app' ? (
          <>
            {available ? <span className="app-bar-host">localhost:{shownPort}</span> : <span className="app-bar-host dim">no dev server</span>}
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
            key={`${env}:${reloadKey}:${frameNonce}:${frameBust}`}
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
