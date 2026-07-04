// Standalone Vite config for Dash.
//
// Dash is the MAIN app here: the repo-root index.html is the single entry, served
// at `/`. (In the original artifact repo, dash was a `/dash/` sidecar lifted out
// of a 1200-line root config; this is the focused, dash-only version.)
//
// Three responsibilities, all lifted from the original root config's dash plugin:
//   1. React fast-refresh (@vitejs/plugin-react).
//   2. Inject the browser's Supabase config at build time (`define`) so the
//      isomorphic store/auth/realtime modules resolve the project + anon key
//      the SAME way in the browser as node does from process.env. The SERVICE
//      key is deliberately NOT injected — it must never reach the browser.
//   3. Wire the dev-server backend: the dash API middleware (dashApi + gifsServe)
//      and the terminal WebSocket upgrade on /api/dash/terminal.
//
// For a production run (after `vite build`), the same backend is mounted by
// bin/dash.mjs on a plain Node http server serving dist/. See that file.

import { WebSocketServer } from 'ws';
import react from '@vitejs/plugin-react';
// Load DASH_SUPABASE_* from .env / .env.local into process.env BEFORE anything
// reads it (the dev middleware store writes with the service role). The browser
// bundle never imports this file.
import './server/node-env.mjs';
import { dashApi, gifsServe } from './server/dash-api.js';
// terminal.js requires the native optionalDependency node-pty. It is imported
// LAZILY inside configureServer so `vite build` (which never runs
// configureServer) never tries to resolve node-pty — the build must succeed
// even when the browser-terminal feature's native dep isn't installed.

// Browser Supabase config, injected as compile-time constants. Empty string when
// unset — the app then shows its "not configured" message rather than silently
// talking to some other project. NEVER inject DASH_SUPABASE_SERVICE_KEY here.
const defineSupabase = {
  __DASH_SUPABASE_URL__: JSON.stringify(process.env.DASH_SUPABASE_URL || ''),
  __DASH_SUPABASE_ANON_KEY__: JSON.stringify(process.env.DASH_SUPABASE_ANON_KEY || ''),
};

export default {
  define: defineSupabase,
  plugins: [
    react({ include: /\.(jsx|tsx)$/ }),
    {
      name: 'dash-api',
      async configureServer(server) {
        // Terminal sidecar (browser terminal via node-pty). Optional: if node-pty
        // isn't installed, skip the terminal wiring but keep the board working.
        let attachChat = null;
        let handleTerminalHttp = null;
        try {
          const term = await import('./server/terminal.js');
          attachChat = term.attachChat;
          handleTerminalHttp = term.handleTerminalHttp;
        } catch (e) {
          console.log('[dash] terminal disabled (node-pty not installed):', e.message);
        }

        // Terminal sidecar HTTP: chat/worktree lifecycle. Registered BEFORE
        // dashApi() so /api/dash/terminal/* wins over the generic /api/dash matcher.
        if (handleTerminalHttp) {
          server.middlewares.use('/api/dash/terminal', (req, res, next) => {
            const [pathname] = (req.url || '/').split('?');
            const segs = pathname.split('/').filter(Boolean);
            handleTerminalHttp(req, res, segs).catch((e) => {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: e.message }));
            });
          });
        }

        // The dash API (board CRUD proxy to Supabase, corpus, hypotheses, tests)
        // and the GIF static-serve. Registered before the SPA fallback so
        // /api/dash and /dash/gifs win.
        server.middlewares.use(dashApi());
        server.middlewares.use(gifsServe());

        // Terminal sidecar WS: one socket per chat, carrying a real PTY. Upgrade
        // only /api/dash/terminal so it doesn't clobber Vite's HMR socket.
        if (attachChat && server.httpServer) {
          const termWss = new WebSocketServer({ noServer: true });
          server.httpServer.on('upgrade', (req, socket, head) => {
            const url = new URL(req.url || '/', 'http://localhost');
            if (url.pathname !== '/api/dash/terminal') return;
            const issueId = url.searchParams.get('issue');
            const sessionId = url.searchParams.get('session');
            const mode = url.searchParams.get('mode') || 'resume';
            if (!issueId || (issueId !== 'main' && !sessionId)) { socket.destroy(); return; }
            termWss.handleUpgrade(req, socket, head, (ws) => {
              attachChat(ws, { issueId, sessionId, mode });
            });
          });
        }
      },
    },
  ],
};
