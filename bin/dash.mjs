#!/usr/bin/env node
// dash — serve the built Dash app + its backend from a single Node http server.
//
// This is how end users run Dash after `npm install && npm run build`:
//
//   dash              # serves dist/ on PORT (default 5173)
//   PORT=8080 dash    # pick a port
//
// It does three things on one http.Server:
//   1. Static-serves the built SPA out of dist/ (index.html fallback for the
//      HashRouter client routes).
//   2. Mounts the dash API middleware (dashApi) at /api/dash — the same
//      middleware the dev server uses.
//   3. Upgrades /api/dash/terminal WebSocket connections to a real PTY, IF the
//      optional native dep node-pty is installed (terminal.js). Without it, the
//      board still works; only the browser terminal is off.
//
// Dependency-light on purpose: Node's own http + the `ws` server, plus the
// existing server modules. No Express, no Vite at runtime.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

// Load DASH_SUPABASE_* from .env / .env.local into process.env before the store
// reads them. Node-only side-effect import.
import '../server/node-env.mjs';
import { dashApi } from '../server/dash-api.js';
import { assertConfigured } from '../server/dash-config.mjs';
import { isAllowedWsHandshake, ensureTerminalToken, isLoopbackHost, selectTerminalSubprotocol, isAllowedApiRequest } from '../server/ws-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT) || 5173;
// Bind loopback by default so the terminal PTY isn't exposed to the network.
// Opt into exposure with DASH_HOST=0.0.0.0 (and set DASH_ALLOWED_ORIGINS).
const HOST = process.env.DASH_HOST || '127.0.0.1';
// When Dash is bound to a routable host, the Origin check no longer stops a
// non-browser network client — so require a secret token on the terminal
// handshake. Auto-generated here (and printed below) unless the operator pinned
// DASH_TERMINAL_TOKEN. Loopback stays token-free.
const TERMINAL_TOKEN = ensureTerminalToken(!isLoopbackHost(HOST));

// Fail loudly if the user hasn't brought a Supabase project.
try {
  assertConfigured();
} catch (e) {
  console.error('\n' + e.message + '\n');
  process.exit(1);
}

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error(
    `\nNo build found at ${DIST}.\nRun \`npm run build\` first, then \`dash\`.\n`,
  );
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

const api = dashApi();

// Static file serve out of dist/, with SPA fallback to index.html. Path is
// contained to DIST (no traversal).
function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  let filePath = path.join(DIST, rel);
  if (!filePath.startsWith(DIST + path.sep) && filePath !== DIST) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA fallback: unknown non-asset path → index.html (client router owns it).
      filePath = path.join(DIST, 'index.html');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  // Backend middlewares first (each calls next() when it doesn't handle the req).
  if (url.startsWith('/api/dash')) {
    // Gate the HTTP API the same way the terminal WS is gated: the endpoints run
    // git and serve/mutate state with no token on the loopback default, so a
    // Host/Origin check is all that stands between a DNS-rebinding page and the
    // API (see ws-guard). The WS upgrade path is gated separately below.
    if (!isAllowedApiRequest(req)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    return api(req, res, () => serveStatic(req, res));
  }
  return serveStatic(req, res);
});

// Terminal WebSocket upgrade — optional (needs node-pty). If it isn't installed,
// terminal connections are simply refused and the rest of the app is unaffected.
let attachChat = null;
try {
  const term = await import('../server/terminal.js');
  attachChat = term.attachChat;
} catch (e) {
  console.log('[dash] terminal disabled (node-pty not installed):', e.message);
}

if (attachChat) {
  // handleProtocols echoes the token subprotocol back so the browser handshake
  // completes when a token is presented that way (see ws-guard).
  const termWss = new WebSocketServer({ noServer: true, handleProtocols: selectTerminalSubprotocol });
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url || '/', 'http://localhost');
    if (u.pathname !== '/api/dash/terminal') { socket.destroy(); return; }
    // Gate the handshake — this socket grants a PTY (see ws-guard): Origin
    // allow-list, plus a secret token when Dash is network-exposed.
    if (!isAllowedWsHandshake(req)) { socket.destroy(); return; }
    const issueId = u.searchParams.get('issue');
    const sessionId = u.searchParams.get('session');
    const mode = u.searchParams.get('mode') || 'resume';
    if (!issueId || (issueId !== 'main' && !sessionId)) { socket.destroy(); return; }
    termWss.handleUpgrade(req, socket, head, (ws) => {
      attachChat(ws, { issueId, sessionId, mode });
    });
  });
}

server.listen(PORT, HOST, () => {
  const shown = HOST === '127.0.0.1' || HOST === 'localhost' ? 'localhost' : HOST;
  const base = `http://${shown}:${PORT}`;
  // With a token, the ONLY working entry point is the tokenized URL — the client
  // reads the token from its own address bar (see src/terminal-token.js). Print
  // that URL so the operator opens the one that actually connects the terminal.
  console.log(`\n  Dash running → ${TERMINAL_TOKEN ? `${base}/?token=${TERMINAL_TOKEN}` : base}\n`);
  if (!isLoopbackHost(HOST)) {
    console.log(
      '  ⚠ Bound to a routable address: the terminal is reachable from your\n' +
      '    network. Only do this on a trusted network, set DASH_ALLOWED_ORIGINS\n' +
      '    to your deployment origin, and open the tokenized URL above (the token\n' +
      '    is what keeps the terminal from being an open shell to the network).\n',
    );
  }
});
