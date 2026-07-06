// Terminal WS token (client side).
//
// A network-exposed Dash requires a secret on the terminal handshake (see
// server/ws-guard.mjs). The operator opens the URL Dash prints, which carries
// `?token=…`. We capture that once on load, keep it in sessionStorage — so it
// survives the app's in-hash navigations and reloads of THIS tab — and strip it
// from the visible URL so it isn't shoulder-surfed or pasted into a shared link.
//
// Loopback Dash prints no token, so there's nothing to capture and this is a
// no-op: the terminal connects with the Origin check alone, exactly as before.

const KEY = 'dash_terminal_token';

// Runs at module load (before any terminal WS is opened, since Terminal.jsx
// imports this). Best-effort: if storage/history is unavailable the token simply
// stays in the URL and still works — the WS read below falls back to the URL.
(function captureFromUrl() {
  try {
    const params = new URLSearchParams(location.search);
    const t = params.get('token');
    if (!t) return;
    try { sessionStorage.setItem(KEY, t); } catch { /* private mode — leave it in the URL */ return; }
    params.delete('token');
    const qs = params.toString();
    history.replaceState(history.state, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
  } catch { /* no URL/history API — nothing to do */ }
})();

export function getTerminalToken() {
  try {
    const stored = sessionStorage.getItem(KEY);
    if (stored) return stored;
  } catch { /* fall through to the URL */ }
  try {
    return new URLSearchParams(location.search).get('token') || '';
  } catch {
    return '';
  }
}
