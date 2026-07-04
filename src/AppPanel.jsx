import React from 'react';
import { DockPanel } from './dock.jsx';
import { appUrlForEnv, appPortForEnv } from './app-env.js';
import { Refresh } from './icons.jsx';

// The in-dash app panel: the running app embedded in an <iframe>, docked as the
// rightmost column (right of the chat). It carries its OWN navbar — the ✕ (from
// DockPanel) floats top-left, the env's `localhost:<port>` reads beside it, and
// TWO refresh buttons: a heavy ↻ beside the host that restarts the worktree's
// dev server (kill + relaunch), and a light ↻ at the far right that just remounts
// the iframe (for when HMR misses but the server is fine). The iframe src follows
// the active env through the shared app-URL helper: `/` on the board (the canvas)
// or the issue's lazy-start `/open` redirect on a detail route. The iframe is keyed
// on env + the parent reload nonce + a LOCAL frame nonce, so switching issues, a
// server restart, OR a plain view-refresh all remount it. The server-restart ↻
// first POSTs `/restart` (Shell's onReload) for an issue env, with `reloading`
// spinning that button while it works; the remount then lands on the fresh server.
// The view-refresh ↻ stays entirely local — it bumps the frame nonce, no fetch.
// Docks/overlays/resizes through the shared DockPanel shell.
//
// Availability is gated on the SAME signal as the topbar opener (`appPortForEnv`):
// an issue with no reserved port has no app to show, so the opener hides AND the
// panel shows an empty state instead of pointing the iframe at a 404 `/open`.
export function AppPanel({ env, port, reloadKey = 0, reloading = false, mode, open, onClose, onReload, onResizeStart }) {
  const shownPort = appPortForEnv(env, port);
  const available = !!shownPort;
  const [frameNonce, setFrameNonce] = React.useState(0);
  return (
    <DockPanel
      prefix="app"
      mode={mode}
      open={open}
      onClose={onClose}
      onResizeStart={onResizeStart}
      closeLabel="Close app panel"
    >
      {/* Navbar: ✕ floats top-left (DockPanel); the host label reads to its right,
          the server-restart ↻ sits right beside it, and the view-refresh ↻ floats
          at the far right. Left padding clears the ✕. */}
      <div className="app-bar">
        {available ? <span className="app-bar-host">localhost:{shownPort}</span> : <span className="app-bar-host dim">no dev server</span>}
        <button type="button" className={`app-bar-reload${reloading ? ' app-bar-reload--busy' : ''}`}
          onClick={onReload} disabled={reloading}
          title="Restart the dev server" aria-label="Restart the dev server">
          <Refresh size={13} />
        </button>
        {available && (
          <button type="button" className="app-bar-reload app-bar-reload--frame"
            onClick={() => setFrameNonce((n) => n + 1)}
            title="Reload the app view (iframe only)" aria-label="Reload the app view">
            <Refresh size={13} />
          </button>
        )}
      </div>
      {available ? (
        <iframe
          key={`${env}:${reloadKey}:${frameNonce}`}
          className="app-frame"
          src={appUrlForEnv(env)}
          title="Running app"
        />
      ) : (
        <div className="app-empty">
          <p className="app-empty-title">No dev environment yet</p>
          <p className="app-empty-sub">This issue has no worktree dev server to embed.</p>
        </div>
      )}
    </DockPanel>
  );
}
