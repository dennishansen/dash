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

// ── HTTP API guard (DNS-rebinding defense) ──────────────────────────────────
// The terminal WS is gated above, but the /api/dash HTTP endpoints run git and
// serve/mutate board + session state, and on the loopback default they take no
// token — so same-origin policy is the ONLY thing between a malicious web page
// and the API. DNS rebinding defeats exactly that: the victim visits evil.com,
// it re-resolves to 127.0.0.1, and the page is now "same-origin" with the API.
// The defense is the Host header: a browser ALWAYS sends it (page JS can't
// forge it) and in a rebinding attack it carries the attacker's domain, not
// 127.0.0.1. So accept only loopback Host values plus any operator-configured
// host. This is the same check Jupyter enforces on every route; Hermes Agent
// shipped a CVE for gating only the WS upgrade and leaving the HTTP path open.

// Host names the API accepts: loopback, plus the hostnames of
// DASH_ALLOWED_ORIGINS and any explicit DASH_ALLOWED_HOSTS. Ports are ignored
// (the Host header may carry one).
function allowedApiHosts() {
  const hosts = new Set(LOCAL_HOSTS);
  for (const o of (process.env.DASH_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    try { hosts.add(new URL(o).hostname); } catch {}
  }
  for (const h of (process.env.DASH_ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    hosts.add(h);
  }
  return hosts;
}

// Gate every /api/dash HTTP request. Reject unless the Host header is an allowed
// name AND — when an Origin is present — that Origin is on the WS allow-list too
// (a cross-site fetch carries the attacker's Origin; a same-origin GET or a
// non-browser client sends none, which is fine). Returns true = allow.
export function isAllowedApiRequest(req) {
  const rawHost = req && req.headers && req.headers.host;
  if (!rawHost) return false; // HTTP/1.1 always sends Host; absent = reject
  let host;
  try {
    host = new URL(`http://${rawHost}`).hostname;
  } catch {
    return false;
  }
  if (!allowedApiHosts().has(host)) return false;
  const origin = req.headers.origin;
  if (origin && !isAllowedWsOrigin(req)) return false;
  return true;
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
//
// Two subprotocols are offered: a token-free BASE plus the token-bearing one.
// The server echoes back ONLY the base — never the token subprotocol — so the
// secret doesn't reappear in the handshake's 101 RESPONSE headers (visible in
// DevTools' Network tab, captured by any response-header logging). This is the
// exact reason Jupyter (JEP-119) and Kubernetes (#47740) offer a base protocol
// alongside the token one and select the base. The token is read only off the
// client's REQUEST offer (providedToken), never reflected back.
const TOKEN_SUBPROTOCOL_PREFIX = 'dash.token.';
const TERMINAL_SUBPROTOCOL_BASE = 'dash.terminal.v1';

// The subprotocols the client offers: the token-free base, plus the token one
// when a token is configured. (base64url tokens are already valid RFC 7230
// subprotocol tokens — no `,` `/` `=` or whitespace to mis-split.)
export function terminalSubprotocols(token) {
  return token ? [TERMINAL_SUBPROTOCOL_BASE, TOKEN_SUBPROTOCOL_PREFIX + token]
               : [TERMINAL_SUBPROTOCOL_BASE];
}

// What the server echoes back so the browser handshake completes. `protocols` is
// the Set `ws` passes to handleProtocols. Return the token-free base if offered;
// otherwise select NONE (false) — NEVER echo the `dash.token.*` value, or the
// token lands in the response headers. Selecting none still completes the 101.
export function selectTerminalSubprotocol(protocols) {
  for (const p of protocols) if (p === TERMINAL_SUBPROTOCOL_BASE) return p;
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
