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

// The full handshake gate used by every terminal WS upgrade: Origin allow-list
// AND — when a token is configured — a matching ?token= query param. With no
// token configured the Origin check is the only gate (loopback default).
export function isAllowedWsHandshake(req) {
  if (!isAllowedWsOrigin(req)) return false;
  const token = terminalToken();
  if (!token) return true;
  let provided = '';
  try {
    provided = new URL(req.url || '/', 'http://localhost').searchParams.get('token') || '';
  } catch {
    provided = '';
  }
  return safeEqual(provided, token);
}
