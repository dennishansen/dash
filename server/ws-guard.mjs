// WebSocket handshake guard for the terminal endpoint.
//
// The terminal socket hands out a real PTY, so an unauthenticated cross-origin
// handshake is remote code execution by drive-by: browsers do NOT apply the
// same-origin policy to WebSocket upgrades, so any page a user visits can open
// ws://localhost/api/dash/terminal unless we check. (Same bug class as Storybook
// CVE-2026-27148 and the 2026 DNS-rebinding WS RCEs.)
//
// Defense: an Origin allow-list. Browsers ALWAYS send an Origin header on a WS
// opened from page JS, and page JS cannot forge it — so this defeats both the
// drive-by case and DNS rebinding (a rebound page's Origin stays the attacker's
// domain, not localhost). Non-browser clients send no Origin and are rejected:
// the only intended client is the page Dash itself serves.
//
// By default only loopback origins are allowed (matching the localhost bind).
// Set DASH_ALLOWED_ORIGINS (comma-separated, e.g. "https://dash.example.com") to
// permit a real deployment origin when you intentionally expose Dash.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

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
