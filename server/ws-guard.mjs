// WebSocket handshake guard for the terminal endpoint.
//
// The terminal socket hands out a real PTY, so an unauthenticated handshake is
// remote code execution. Two DISTINCT attackers, two DISTINCT defenses:
//
//   1. A BROWSER on a page the victim visits (drive-by, DNS rebinding). Browsers
//      do NOT apply same-origin policy to WS upgrades, but they DO always attach
//      an Origin header that page JS cannot forge. → the Origin allow-list below.
//
//   2. A NON-BROWSER client on the network (curl, a Python `websockets` script)
//      once Dash is bound to a routable address (DASH_HOST=0.0.0.0). Such a
//      client sets any Origin it likes — `Origin: http://localhost` sails past an
//      Origin check. An Origin header only means something FROM a browser, so on
//      the exposed path it authenticates nothing. → a secret token.
//
// The token is what actually secures DASH_HOST=0.0.0.0. This is exactly the gap
// that burned Marimo (CVE-2026-39987: PTY-over-WS with only a mode check, no
// token — exploited within hours, added to CISA KEV) and nginx-ui
// (CVE-2026-34403: CheckOrigin→true). The Origin list hardens the browser vector;
// the token hardens raw network access. We keep both.
//
// A token is REQUIRED whenever one is configured. It is auto-generated (and the
// full URL printed) whenever Dash binds a non-loopback host, so exposing Dash is
// secure by default. On the loopback bind (the default) no token is needed — no
// off-box client can reach the socket — and the pre-token single-URL UX is kept.
// Set DASH_TERMINAL_TOKEN yourself to pin a token even on loopback.

import crypto from 'crypto';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopbackHost(host) {
  return LOCAL_HOSTS.has(host);
}

export function isAllowedWsOrigin(req) {
  const origin = req && req.headers && req.headers.origin;
  if (!origin) return false; // no Origin → not the browser page we serve
  let host;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  if (LOCAL_HOSTS.has(host)) return true;
  const extra = (process.env.DASH_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return extra.includes(origin);
}

// The terminal token in effect, or '' when none is configured (loopback default).
export function terminalToken() {
  return process.env.DASH_TERMINAL_TOKEN || '';
}

// Generate + install a token into process.env when the bind is network-exposed
// and the operator hasn't pinned one. Returns the effective token ('' = none, on
// the loopback default). Call once at startup; the guard reads process.env, so
// this must run before the first handshake.
export function ensureTerminalToken(exposed) {
  if (process.env.DASH_TERMINAL_TOKEN) return process.env.DASH_TERMINAL_TOKEN;
  if (!exposed) return '';
  const t = crypto.randomBytes(24).toString('base64url');
  process.env.DASH_TERMINAL_TOKEN = t;
  return t;
}

// Constant-time string compare that never throws or short-circuits on length.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // Touch timingSafeEqual on equal-length input so the reject path's timing
    // doesn't leak the length; the result is still false.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

// The token rides in the WebSocket subprotocol, NOT the URL. A network-exposed
// Dash is usually fronted by something that access-logs the request line (nginx,
// Caddy, cloudflared/ngrok/Tailscale) — a `?token=` there writes the long-lived
// PTY secret into plaintext logs on every reconnect (OWASP: secrets in query
// strings leak into server/proxy logs + Referer). The browser WS API forbids
// custom headers but DOES allow a subprotocol, so we carry the token as
// `dash.token.<token>` (the pattern Jupyter/Kubernetes use) — it stays out of
// access logs by default. `?token=` is still read as a fallback so any older
// tokenized WS URL keeps working.
const TOKEN_SUBPROTOCOL_PREFIX = 'dash.token.';

export function terminalSubprotocol(token) {
  return TOKEN_SUBPROTOCOL_PREFIX + token;
}

// The subprotocol the server echoes back so a browser handshake that offered the
// token subprotocol completes. `protocols` is the Set `ws` passes to
// handleProtocols; returns the matching offered value, or false to select none.
export function selectTerminalSubprotocol(protocols) {
  for (const p of protocols) if (p.startsWith(TOKEN_SUBPROTOCOL_PREFIX)) return p;
  return false;
}

// The token the client presented: the subprotocol offer first, then ?token=.
function providedToken(req) {
  const offered = req && req.headers && req.headers['sec-websocket-protocol'];
  if (offered) {
    for (const raw of String(offered).split(',')) {
      const p = raw.trim();
      if (p.startsWith(TOKEN_SUBPROTOCOL_PREFIX)) return p.slice(TOKEN_SUBPROTOCOL_PREFIX.length);
    }
  }
  try {
    return new URL(req.url || '/', 'http://localhost').searchParams.get('token') || '';
  } catch {
    return '';
  }
}

// The full handshake gate used by every terminal WS upgrade: Origin allow-list
// AND — when a token is configured — a matching token (subprotocol or ?token=).
// With no token configured the Origin check is the only gate (loopback default).
export function isAllowedWsHandshake(req) {
  if (!isAllowedWsOrigin(req)) return false;
  const token = terminalToken();
  if (!token) return true;
  return safeEqual(providedToken(req), token);
}
