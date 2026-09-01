// "Another port on the machine I am already talking to."
//
// The dash is not one service on one port: the edge is 5173 and every active
// issue's dev server is somewhere in 5200-5299. Two places have to hand a
// BROWSER a URL for one of those sibling ports — the App pane's /open redirect
// and the App bar's host label — and both used to write `localhost:<port>`.
//
// `localhost` is only ever right when the browser IS the machine. The moment
// the dash runs on a box and the browser is somewhere else, `localhost:5219`
// means the viewer's own laptop: the App pane loads nothing, or worse, loads
// whatever unrelated thing that laptop happens to be running. The port is the
// only part we know; the HOST has to come from whoever is asking.
//
// WHY THIS IS NOT AN OPEN REDIRECT. Composing a Location out of a client-
// supplied Host header normally is one. It is safe here — and only here —
// because ws-guard has already refused the request unless its Host is loopback
// or a name the operator declared in DASH_ALLOWED_HOSTS/ORIGINS
// (isAllowedApiRequest, enforced at BOTH the edge and the supervisor). By the
// time anything below runs, the host is one the operator vouched for. Never
// call these on a path that isn't behind that gate.

// The hostname inside a Host header or a `location.host` — with or without a
// port, which is discarded because we are always naming a DIFFERENT port.
// Falls back to localhost when there is no host to speak of (a non-browser
// caller), which is the same machine the old literal assumed.
function hostnameOf(host) {
  try {
    const parsed = new URL(`http://${String(host || '').trim()}`).hostname;
    if (parsed) return parsed;
  } catch { /* unparseable Host → localhost, the pre-box behaviour */ }
  return 'localhost';
}

// ── the browser-facing scheme ───────────────────────────────────────────────
//
// A sibling-port URL has to carry the scheme the BROWSER is on, and the server
// cannot observe it. Behind `tailscale serve` the request arrives over loopback
// as plain http however the browser asked, so the socket says `http:` and a 302
// composed from it would bounce a page off its secure origin onto an insecure
// one. That is not cosmetic: an insecure origin has no `navigator.clipboard`
// and no `getUserMedia` at all, which is exactly how the App pane's canvas lost
// cmd+` and the mic (issue i-tailnet-secure-context).
//
// Guessing the scheme from the port would be a heuristic. We don't need one —
// the operator has already STATED the answer. DASH_ALLOWED_ORIGINS is scheme +
// host + port, written by scripts/box/tailnet-up.sh from what tailscale itself
// reports, and edge-relay already treats it as the authority on how a browser
// reaches this machine. Read the declaration; don't re-derive it.
function declaredScheme(hostname) {
  // Guarded: this module is in the CLIENT bundle too (the App bar's label), and
  // a browser has no `process`.
  const raw = (typeof process !== 'undefined' && process.env && process.env.DASH_ALLOWED_ORIGINS) || '';
  for (const entry of String(raw).split(',')) {
    const declared = entry.trim();
    if (!declared) continue;
    try {
      const u = new URL(declared);
      if (u.hostname === hostname && u.protocol === 'https:') return 'https:';
    } catch { /* an unparseable entry declares nothing */ }
  }
  return null;
}

// The origin a client on `host` should use to reach `port` on this machine.
export function sameHostOrigin(host, port, protocol = 'http:') {
  const proto = protocol === 'https:' || protocol === 'https' ? 'https:' : 'http:';
  return `${proto}//${hostnameOf(host)}:${port}`;
}

// The same answer for a node request. Two sources of scheme, in the order they
// are trustworthy: a reverse proxy that terminated TLS and said so in
// x-forwarded-proto is talking about THIS request; the operator's declaration
// covers the fronts that add no such header (`tailscale serve` among them).
// Without either, a dev server speaks http.
export function sameHostOriginFor(req, port) {
  const host = req?.headers?.host;
  const fwd = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = fwd === 'https' ? 'https:' : (declaredScheme(hostnameOf(host)) || 'http:');
  return sameHostOrigin(host, port, proto);
}

// Just the authority (`host:port`) — what a UI shows when it labels the pane it
// is displaying. Same derivation, so the label can never disagree with the link.
export function sameHostAuthority(host, port) {
  return new URL(sameHostOrigin(host, port)).host;
}
