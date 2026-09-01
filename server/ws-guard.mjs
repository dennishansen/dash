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
// The token is MACHINE state owned by the supervisor (minted at its boot,
// 0600 beside the crash journal); every vite edge reads the same value, and an
// EXPOSED edge — routable bind, or a tunnel announced via DASH_ALLOWED_HOSTS —
// requires it on the handshake and prints the tokenized URL. The plain
// loopback edge keeps the token-free local UX. Set DASH_TERMINAL_TOKEN to pin
// the value everywhere.
//
// "Nothing off-box can reach a loopback edge" is the one thing this file must
// not assume — a tunnel makes it false, and it is our OWN tunnel. See "did it
// reach us DIRECTLY?" below.

import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { registryDir } from './proc-identity.mjs';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopbackHost(host) {
  return LOCAL_HOSTS.has(host);
}

export function isAllowedWsOrigin(req) {
  const origin = req && req.headers && req.headers.origin;
  if (!origin) return false; // no Origin → not the browser page we serve
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  // Only ever a web origin. A sandboxed frame sends `Origin: null` and a
  // file:// page sends `file://`; neither has a hostname anyone declared, but
  // saying so explicitly keeps the name-based rule below from ever being the
  // only thing standing between a non-web scheme and a PTY.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (LOCAL_HOSTS.has(url.hostname)) return true;
  const extra = (process.env.DASH_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (extra.includes(origin)) return true;
  // …and an origin whose HOSTNAME the operator declared in DASH_ALLOWED_HOSTS,
  // on ANY port. The two settings mean different things and this is where the
  // difference shows: DASH_ALLOWED_ORIGINS is an exact origin — scheme and port
  // pinned, which is what a tunnel deployment wants — while DASH_ALLOWED_HOSTS
  // is a HOST, and the Host check below has always read it that way ("Ports are
  // ignored"). Matching the origin string alone made the two disagree, and this
  // box is where that bites: it serves ONE host across ~100 ports (5173 plus the
  // 5200-5299 preview range), so an exact-origin list can only ever bless one of
  // them. A browser on a preview port was therefore a cross-origin attacker to
  // its own server — measured, on main: /api/doc and /ws answered 403 to a
  // tailnet browser at :5205 while answering 200 at :5173 (issue i-2ca5a4).
  //
  // The SCHEME goes stale the same way and for the same reason: the day the box
  // gained TLS, every enumerated `http://` entry named an origin that no longer
  // existed, and the App pane's `https://<box>:5219` matched none of them
  // (i-tailnet-secure-context). A name outlives both the port and the scheme,
  // which is why it is the thing to declare.
  //
  // It admits no one new: a declared host is already accepted wholesale by the
  // Host check, so this only stops calling OUR OWN pages foreign. A cross-site
  // page still carries its own hostname and is still refused.
  const hosts = (process.env.DASH_ALLOWED_HOSTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return hosts.includes(url.hostname);
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

// ── the machine token ───────────────────────────────────────────────────────
// ONE token per machine, owned by the supervisor: minted at supervisor boot,
// persisted 0600 beside the crash journal, and read by every vite edge — so an
// authenticated socket through ANY edge (5173, a worktree port, a tunnel)
// verifies against the same secret. The old per-process minting broke exactly
// that: each exposed vite invented its own token, and the supervisor's guard
// had never seen the one your edge printed.
function tokenPath() {
  return path.join(registryDir(), 'terminal-token');
}

// The token in effect: the machine token FILE first — the supervisor persists
// an operator pin into it at boot, so the file is the one value every edge and
// the supervisor agree on; a per-process env pin is only the bootstrap answer
// before any supervisor has run. Edges comparing their own env pin instead of
// the file would accept tokens the supervisor rejects.
export function terminalToken() {
  try {
    const t = fs.readFileSync(tokenPath(), 'utf8').trim();
    if (t) return t;
  } catch {}
  return process.env.DASH_TERMINAL_TOKEN || '';
}

// Supervisor-side: make the machine token durable. An operator pin is
// persisted so edges see the same value; an existing file is kept; otherwise a
// fresh token is minted. Atomic + 0600 — the write goes to a same-dir temp and
// renames in, so an edge never reads a torn secret and no other user can read
// it at all.
export function ensureMachineToken() {
  const p = tokenPath();
  const pinned = process.env.DASH_TERMINAL_TOKEN;
  const current = (() => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; } })();
  if (!pinned && current) return current;
  const t = pinned || crypto.randomBytes(24).toString('base64url');
  if (t === current) return t;
  try {
    fs.mkdirSync(registryDir(), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, t, { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch {}
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

// The token a request presented, in ANY of the four carriers the system uses:
// the WS subprotocol, the x-dash-token header, the dash_token cookie (set by
// the client at ?token capture so every same-origin fetch carries it), or
// ?token=. Exposed edges require it on the WHOLE /api/dash surface — the board
// API mints privileged sessions (dev-session), so Host/Origin alone must never
// be the only thing between a tunnel client and the service key.
//
// ONE READER, deliberately. There used to be two — this one for HTTP and a
// private subprotocol reader for the handshake — and the terminal WS carries
// its token in the SUBPROTOCOL (below: to keep it out of proxy access logs).
// So api-gate, which guards upgrades too, could not see the very credential the
// terminal was presenting; it answered 401 to a correctly tokenized handshake
// and was only ever saved by the peer check short-circuiting ahead of it.
// Two readers of one credential is a disagreement waiting for the day the
// short-circuit stops firing — which is the day this was found. A carrier that
// is absent costs nothing to look for, so every gate looks everywhere.
export function presentedToken(req) {
  const offered = req?.headers?.['sec-websocket-protocol'];
  if (offered) {
    for (const raw of String(offered).split(',')) {
      const p = raw.trim();
      if (p.startsWith(TOKEN_SUBPROTOCOL_PREFIX)) return p.slice(TOKEN_SUBPROTOCOL_PREFIX.length);
    }
  }
  const h = req?.headers?.['x-dash-token'];
  if (h) return String(h);
  const cookie = req?.headers?.cookie;
  if (cookie) {
    const m = String(cookie).match(/(?:^|;\s*)dash_token=([^;]+)/);
    // A malformed percent-encoding must fail CLOSED, not throw: this parses
    // UNAUTHENTICATED input inside an async middleware, where a rejection is a
    // process-fatal crash.
    if (m) { try { return decodeURIComponent(m[1]); } catch { return ''; } }
  }
  try {
    return new URL(req.url || '/', 'http://localhost').searchParams.get('token') || '';
  } catch { return ''; }
}

// ── who the request came FROM ───────────────────────────────────────────────
//
// THE DECISION (2026-08-19, issue i-cloud-dev-box): a request that reached this
// process over loopback or over the tailnet is already authenticated by
// something stronger than a shared secret, and does not additionally need the
// machine token.
//
// WHY THE TOKEN EXISTED. It was minted for `dash-tunnel.sh` — a loopback dash
// published through ngrok at a PUBLIC url. There, anyone on the internet could
// reach the socket, so a secret was the only thing between a stranger and an
// API that mints privileged sessions. That is a real threat model and the token
// is the right answer to it.
//
// WHY A TAILNET IS DIFFERENT. Reaching the socket at all requires a WireGuard
// device enrolled in the tailnet. That is device-level authentication performed
// before a single byte of HTTP — strictly stronger than one shared secret that
// travels in URLs, gets pasted into chat logs, and never rotates.
//
// DOES THIS REOPEN DNS REBINDING? No, and it is worth being exact because the
// two defences are often confused. In a rebinding attack the victim's own
// browser is the client, so its packets DO carry a trusted source address — a
// source-IP check defends against nothing there. What defends is the HOST
// header, and that check is untouched: isAllowedApiRequest still demands a Host
// that is loopback or operator-declared, and a rebinding page sends
// `Host: evil.com`. The two layers answer different questions —
//   "can this peer reach us at all?"      → the network (WireGuard, ufw)
//   "is this page allowed to talk to us?" → the Host allow-list
// — and the token was only ever standing in for the first. Removing it where
// the network already answers that question loses nothing.
//
// WHY IT IS DECLARED, NOT ASSUMED. 100.64.0.0/10 is shared CGNAT space; that a
// packet from it must have arrived over tailscale0 is true only because ufw
// admits nothing else inbound. This module cannot see the firewall, so it will
// not assume one: the operator states the posture in DASH_TRUSTED_PEERS
// (`tailnet`, or explicit CIDRs) and gets nothing by default.
const TAILNET_CIDR = '100.64.0.0/10';

function ipToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const b = Number(p);
    if (!Number.isInteger(b) || b < 0 || b > 255 || !/^\d{1,3}$/.test(p)) return null;
    n = (n * 256) + b;
  }
  return n;
}

function inCidr(ip, cidr) {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const a = ipToInt(ip); const b = ipToInt(base);
  if (a === null || b === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

// The peer address, with IPv4-mapped IPv6 (::ffff:10.0.0.1) unwrapped — node
// reports that form on a dual-stack listener and a raw string compare misses it.
export function peerAddress(req) {
  const raw = req?.socket?.remoteAddress || '';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

// ── …and did it reach us DIRECTLY? ─────────────────────────────────────────
//
// THE ADJUDICATION (2026-08-20, issue i-loopback-trust-vs-exposed-token). Two
// contracts looked like they collided: "an EXPOSED edge requires the machine
// token" and "loopback is trusted unconditionally". They do not. What was
// wrong is older and quieter than either — reading a loopback SOURCE ADDRESS
// as proof of a box-local CLIENT.
//
// A front (tunnel, reverse proxy) terminates the client's connection and opens
// its OWN to us, so behind one every client wears the front's address. This box
// runs TWO fronts and both dial loopback, measured on the wire:
//
//   `tailscale serve`  — fronts every port; DASH_BIND_HOST is 127.0.0.1
//                        precisely BECAUSE serve is the front
//                        → x-forwarded-for: 100.123.227.54  (a tailnet peer)
//   `ngrok http 5173`  — scripts/dash-tunnel.sh
//                        → x-forwarded-for: <a stranger's public address>
//
// Reading the socket made those identical. So unconditional loopback trust made
// the token dead on precisely the deployment that exists to need it — measured
// on main, through a front: a tokenless WS handshake was handed a live PTY, and
// the tokenless /api/dash surface (which mints privileged sessions) answered
// 200.
//
// A front does not hide the client; it RELOCATES it. So the peer check reads
// the address the front named, and the rule this file already had — is that
// address one the operator DECLARED? — separates serve from ngrok on its own.
// On this box that finally makes DASH_TRUSTED_PEERS load-bearing: the tailnet
// is admitted BECAUSE it is the tailnet, where before it was admitted because
// tailscale's proxy happens to dial loopback, the identical reason ngrok's
// proxy would have been.
//
// BELIEVING A HEADER IS ITSELF DECLARED, NEVER ASSUMED. The usual objection to
// reading x-forwarded-for is exactly right — anyone can type a header — so the
// question "may this relay speak for someone?" gets its own answer from the
// operator, in DASH_TRUSTED_FRONT, and is empty by default. See it below. Four
// clauses then bound what a declared front can buy anyone:
//
//   • ONLY FROM A DECLARED RELAY ADDRESS. Undeclared, a forwarded request is
//     judged on its socket like anything else. Without this a stranger on the
//     network authenticates as the tailnet by naming it — not hypothetical: it
//     is the assertion in dash/api-gate.test.mjs that caught an early draft.
//   • EXACTLY ONE ADDRESS, or nothing. A LIST is ambiguous in a way no care
//     resolves: `a, b` is both the shape of a genuine proxy chain and the shape
//     of a client seeding a lie the front appended to (or prepended before),
//     and the bytes are identical. Picking a side would be guessing, so a list
//     fails closed in either order and a multi-hop deployment presents the
//     token.
//   • DECLARED PEERS ONLY through a front — the implicit loopback clause does
//     not travel. A front claiming its client was on our own loopback earns
//     nothing, so the one value an attacker would most want to inject is
//     worthless.
//   • VALIDATE, NEVER REPAIR. The address is an IP literal (net.isIP) or it is
//     nothing, and RFC 7239 grammar is parsed rather than pattern-matched.
//     Tidying `for="1.2.3.4\""` or `for=" 1.2.3.4 "` into a clean address is
//     deciding what the client meant, and what it meant was malformed.
//
// No forwarding header at all → the socket is read exactly as before. Trust is
// never GAINED by adding a header; it is only moved to a stricter test. The
// residue is a box-local process forging one to be read as the tailnet — and a
// box-local process is already trusted outright, so it gains nothing.
//
// WHAT THIS DELIBERATELY DOES NOT DO is infer a front from "loopback bind plus
// a declared host". That shape is equally just a box carrying stale tailnet
// declarations, and refusing loopback there would tax every local agent and the
// whole test suite while removing no attacker. Where nothing is relaying,
// loopback stays friction-free, and a box-local process keeps the trust it has
// always had (it can read the token file anyway, so demanding it protects
// nothing).

// The marks a front leaves: RFC 7239 `Forwarded`, `x-real-ip`, or ANY
// `x-forwarded-*`. Matched as a family rather than as a list of the spellings
// seen so far — a header we forgot to enumerate is a front we failed to
// notice, and this is the check that must not have a blind spot.
export function isForwardedRequest(req) {
  const headers = req && req.headers;
  if (!headers) return false;
  for (const name of Object.keys(headers)) {
    const k = name.toLowerCase();
    if (k !== 'forwarded' && k !== 'x-real-ip' && !k.startsWith('x-forwarded-')) continue;
    const v = headers[name];
    if (Array.isArray(v) ? v.length > 0 : String(v ?? '').trim() !== '') return true;
  }
  return false;
}

const header = (req, name) => {
  const v = req?.headers?.[name];
  return Array.isArray(v) ? v.join(',') : (v == null ? '' : String(v));
};

// One address as a front spells it: bare, IPv4-mapped, bracketed IPv6, or with
// a port (RFC 7239 allows `for="[2001:db8::1]:4711"`). Anything left unparsed
// stays unparsed — callers treat a non-address as untrusted, and inventing a
// fallback here is how a guard starts guessing.
// NOT trimmed here: callers trim where whitespace is legitimate (around a
// comma-separated value, around a token), and a quoted-string's content is the
// value verbatim. Trimming at this layer put ` 1.2.3.4 ` back together into a
// credential after the grammar had already rejected it.
function normalizeForwardedAddress(raw) {
  let v = String(raw || '');
  if (!v) return '';
  const bracketed = v.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) v = bracketed[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(v)) v = v.split(':')[0]; // IPv4 may carry :port
  if (v.startsWith('::ffff:')) v = v.slice(7);
  // VALIDATE, never REPAIR — and validate with a real parser. A hand-rolled
  // shape test called `::::` an IPv6 literal; net.isIP does not, and it is the
  // same parser node uses for addresses everywhere else.
  return net.isIP(v) ? v : '';
}

// Split ONE element into its `name=value` parameters at top-level semicolons,
// keeping every character verbatim — quotes included. A boundary-finder that
// also interprets is where a guard starts repairing its input.
function forwardedParams(element) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < element.length; i++) {
    const c = element[i];
    if (quoted) {
      cur += c;
      if (c === '\\' && i + 1 < element.length) { cur += element[++i]; continue; }
      if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') { quoted = true; cur += c; continue; }
    if (c === ';') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (quoted) return null; // unclosed quote — malformed
  out.push(cur);
  return out;
}

// RFC 7239: a parameter value is EITHER a token OR a quoted-string, never a
// mixture. `100."123".227.54` is neither, and stripping its quotes to make it
// one is repairing malformed grammar into a credential. A quoted string's
// content is returned VERBATIM — not trimmed — so `" 1.2.3.4 "` stays a string
// with spaces in it and fails validation, which is what it deserves.
function forwardedParamValue(raw) {
  const v = raw.trim();
  if (!v) return '';
  if (!v.startsWith('"')) return v.includes('"') ? '' : v; // token: no quotes at all
  if (v.length < 2 || !v.endsWith('"')) return '';
  let out = '';
  for (let i = 1; i < v.length - 1; i++) {
    const c = v[i];
    if (c === '\\') { if (i + 1 > v.length - 2) return ''; out += v[++i]; continue; }
    if (c === '"') return ''; // an unescaped quote inside the string: malformed
    out += c;
  }
  return out;
}

// The `for=` of ONE element, or nothing.
function forwardedForParam(element) {
  const params = forwardedParams(element);
  if (!params) return '';
  const found = [];
  for (const p of params) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    if (p.slice(0, eq).trim().toLowerCase() === 'for') found.push(forwardedParamValue(p.slice(eq + 1)));
  }
  // Same rule as a list of elements, one level down: a repeated `for` is two
  // claims about one client, and choosing between them would be guessing.
  return found.length === 1 ? found[0] : '';
}

// Split a Forwarded header into its elements at TOP-LEVEL commas only: a
// quoted extension value may legally contain one, and splitting inside it turned
// a valid single-hop header into a false denial.
function forwardedElements(value) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quoted) {
      cur += c;
      if (c === '\\' && i + 1 < value.length) { cur += value[++i]; continue; }
      if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') { quoted = true; cur += c; continue; }
    if (c === ',') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (quoted) return []; // unclosed quote — malformed, so it names nobody
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

// The address the front named for its client — and EXACTLY one, or nothing.
//
// With a single front, the value it wrote IS the client and there is no
// ambiguity. A LIST is a different animal: `a, b` is the shape of a proxy
// CHAIN, where which hop is the client depends on which hops are ours, and we
// have no list of ours to check against. It is also the shape a client
// produces by seeding a value that the front then appends to (or, for a front
// that prepends rather than appends, one that leaves the lie last). Reading
// "the last value" would be right for the first reading and catastrophically
// wrong for the second, and the bytes are identical — so we do not choose. More
// than one address fails closed, and a multi-hop deployment uses the token.
export function forwardedPeerAddress(req) {
  const xff = header(req, 'x-forwarded-for').trim();
  if (xff) {
    const parts = xff.split(',').map((x) => x.trim()).filter(Boolean);
    return parts.length === 1 ? normalizeForwardedAddress(parts[0]) : '';
  }
  const fwd = header(req, 'forwarded').trim();
  if (fwd) {
    const elements = forwardedElements(fwd);
    return elements.length === 1 ? normalizeForwardedAddress(forwardedForParam(elements[0])) : '';
  }
  const real = header(req, 'x-real-ip').trim();
  if (real) {
    const parts = real.split(',').map((x) => x.trim()).filter(Boolean);
    return parts.length === 1 ? normalizeForwardedAddress(parts[0]) : '';
  }
  return '';
}

function matchesDeclared(declared, ip) {
  for (const raw of declared) {
    const cidr = raw === 'tailnet' ? TAILNET_CIDR : raw;
    if (cidr.includes('/') && inCidr(ip, cidr)) return true;
    if (cidr === ip) return true;
  }
  return false;
}

const isLoopbackIp = (ip) => ip === '127.0.0.1' || ip === '::1' || inCidr(ip, '127.0.0.0/8');

// The peers the operator declared, or NONE of them. `none` is a withdrawal, so
// it outranks anything spelled beside it. Exported because it is read twice —
// here and by the edge's startup banner — and the first version of this change
// shipped a bug precisely because those two read the setting differently: the
// banner filtered `none` out and printed a token-free URL for the remainder
// that the guard then refused for everyone. One setting, one reader.
// Returns the list, or NULL for `none` — the two are different answers and
// collapsing them is what made the first version of this read badly: with
// nothing declared, loopback is still trusted; with `none`, nothing is.
export function declaredTrustedPeers(raw = process.env.DASH_TRUSTED_PEERS) {
  const peers = String(raw || '').split(',').map((x) => x.trim()).filter(Boolean);
  return peers.includes('none') ? null : peers;
}

// ── may a forwarding header be believed at all? ─────────────────────────────
//
// DASH_TRUSTED_FRONT, and nothing implicit. It names the ADDRESSES a relay
// speaks to us from: `loopback` (127.0.0.0/8 and ::1) for a front on this box,
// an exact address, or an IPv4 CIDR for a proxy in a container. IPv6 is
// supported as an exact address but NOT as a CIDR — inCidr is IPv4-only, so an
// IPv6 range simply never matches, which is the safe direction but is a
// limitation, not a feature. Empty by default: undeclared, a forwarded request
// is judged on its socket like anything else, so a fronted client presents the
// token.
//
// WHY THIS IS ITS OWN KNOB, and not a mode of DASH_TRUSTED_PEERS. They answer
// different questions and only one of them is about the header:
//
//   DASH_TRUSTED_PEERS  "which CLIENTS has the network already authenticated?"
//   DASH_TRUSTED_FRONT  "which relays may TELL me who the client is?"
//
// Reading the first as permission for the second is the substitution this whole
// issue is about, one level up: it assumes the relay SETS the header (tailscale
// serve) or APPENDS to it (ngrok, documented) rather than passing the client's
// own through — nginx's `proxy_set_header X-Forwarded-For $http_x_forwarded_for`
// is the classic way to get that wrong, and it hands a remote client the
// ability to name itself. That property belongs to a component the operator
// chose; this module cannot see it, so — exactly as with the tailnet — it will
// not assume it. Declared, or not believed.
//
// AN ADDRESS IS NOT A PROCESS. Declaring `loopback` blesses EVERY relay that
// reaches us from loopback, not the one you had in mind — so a laundering front
// cannot safely share a listener with an honest one, and there is no per-front
// spelling for that today. If you ever run two fronts with different header
// contracts on the same box, the honest answer is DASH_TRUSTED_PEERS=none
// (which withdraws network trust for the whole listener, so everyone presents
// the token) until this knob learns to tell them apart.
export function trustedFrontRanges(raw = process.env.DASH_TRUSTED_FRONT) {
  return String(raw || '').split(',').map((x) => x.trim()).filter(Boolean);
}

export function isTrustedFront(req) {
  const socket = peerAddress(req);
  if (!socket) return false;
  for (const entry of trustedFrontRanges()) {
    if (entry === 'loopback') { if (isLoopbackIp(socket)) return true; continue; }
    if (entry.includes('/') ? inCidr(socket, entry) : entry === socket) return true;
  }
  return false;
}

// Is this request's CLIENT — the socket's peer, or the address a DECLARED front
// observed on its behalf — one the network has already authenticated?
export function isTrustedPeer(req) {
  const declared = declaredTrustedPeers();
  // `none`: the operator withdrew network trust here — nobody is authenticated
  // by the network, loopback included. Everyone presents the token.
  if (!declared) return false;
  const socket = peerAddress(req);
  if (!socket) return false;
  if (isForwardedRequest(req)) {
    // Something is speaking for someone else. Believe it only if the operator
    // said this relay may — and then judge the CLIENT it named, never the
    // socket. A relay that was not declared spends its own trust rather than
    // lending it: it gets the token requirement, not a bypass for whoever it
    // is fronting.
    if (!isTrustedFront(req)) return false;
    const client = forwardedPeerAddress(req);
    // DECLARED ONLY: loopback's implicit trust is a statement about processes
    // on this box, and nothing that arrived through a front is one.
    return !!client && matchesDeclared(declared, client);
  }
  if (isLoopbackIp(socket)) return true;
  return matchesDeclared(declared, socket);
}

// The exposed-ingress HTTP gate: everything isAllowedApiRequest checks, plus a
// valid machine token. Fail CLOSED when no token exists yet.
export function isAllowedExposedApiRequest(req) {
  if (!isAllowedApiRequest(req)) return false;
  // A trusted peer needs no token; the token still works, so every tokenized
  // URL and script already in flight keeps working.
  if (isTrustedPeer(req)) return true;
  const token = terminalToken();
  if (!token) return false;
  return safeEqual(presentedToken(req), token);
}

// The full handshake gate used by every terminal WS upgrade: Origin allow-list
// AND — where a token is REQUIRED — a matching machine token, in whichever
// carrier the client used (presentedToken looks in all four). Requirement is the CALLER'S exposure decision, not global env: an
// exposed edge (routable bind, or a tunnel announced via DASH_ALLOWED_HOSTS)
// requires it; a plain loopback edge keeps the token-free local UX; the
// supervisor requires it only under an operator pin (its loopback bind is
// otherwise unreachable off-box). An empty machine token with requireToken set
// fails CLOSED — better an exposed edge that refuses than one that lets a raw
// client walk into a PTY.
export function isAllowedWsHandshake(req, { requireToken = !!process.env.DASH_TERMINAL_TOKEN } = {}) {
  if (!isAllowedWsOrigin(req)) return false;
  // A FORWARDED request is exposure, whatever the caller concluded about its
  // listener — something off-box relayed it here. The caller reasons from a
  // bind address and an env var, both of which say "loopback, unreachable"
  // for the supervisor's own port and for any tunnel that rewrites Host to a
  // loopback name; the request itself says otherwise, and it is the one that
  // knows. So it overrides requireToken=false rather than merely surviving it.
  if (!requireToken && !isForwardedRequest(req)) return true;
  if (isTrustedPeer(req)) return true; // same reasoning as the HTTP gate above
  const token = terminalToken();
  if (!token) return false;
  return safeEqual(presentedToken(req), token);
}

// THE URL AN EXPOSED EDGE PRINTS — and why nothing here decides whether it
// needs the token.
//
// Three times this module tried to predict it, and three times the prediction
// was wrong in a way a real deployment produced: from DASH_TRUSTED_PEERS alone
// (a loopback edge is only reachable through a relay, which peer trust does not
// admit); from the bind (`--host 0.0.0.0` says nothing about whether the
// printed ORIGIN comes to us directly or through a proxy); from the existence
// of a declared relay (declaring 10.0.0.0/8 does not make front.example route
// through 10.0.0.0/8 — it may still arrive via a loopback proxy). The pattern
// is not a series of missing cases. It is that the settings describe WHO is
// trusted, never WHICH PATH a name takes to reach us, and no combination of
// them can be made to answer a question they do not contain. `os.hostname()`
// is not an exception either — it is a name, and a name can be fronted.
//
// So the banner stops predicting. It prints the URL that works on EVERY route —
// the tokenized one — and states the condition under which the token can be
// dropped, which is a rule the reader can check against their own deployment
// and this module cannot. A URL that always works and a claim that is always
// true, in place of a guess that was wrong three ways.
//
// If a future deployment wants the token-free URL printed, the thing to add is
// an explicit statement of the ROUTE — not another inference from these.

// Is THIS listener exposure? Routable bind, or a tunnel fronting the loopback
// (dash-tunnel.sh announces it through DASH_ALLOWED_HOSTS) — the case testing
// only 0.0.0.0 misses.
export function edgeIsExposed(address) {
  const host = address && typeof address === 'object' ? address.address : '127.0.0.1';
  if (host === '0.0.0.0' || host === '::') return true;
  if (!isLoopbackHost(host)) return true;
  return ((process.env.DASH_ALLOWED_HOSTS || '').trim().length > 0);
}
