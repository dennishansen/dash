// Tests for the terminal WebSocket handshake guard. Run: `npm test`.
//
// The guard is the security boundary in front of a real PTY, so its two layers —
// the Origin allow-list (vs. browsers) and the token (vs. direct network
// clients) — are worth pinning down precisely.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedWsOrigin,
  isAllowedWsHandshake,
  ensureTerminalToken,
  isLoopbackHost,
  terminalToken,
  terminalSubprotocols,
  selectTerminalSubprotocol,
} from '../server/ws-guard.mjs';

// `sub` is a Sec-WebSocket-Protocol header value (the token's transport).
const req = (origin, url = '/api/dash/terminal', sub) => ({
  headers: { ...(origin ? { origin } : {}), ...(sub ? { 'sec-websocket-protocol': sub } : {}) },
  url,
});

function withEnv(env, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  // Clear keys explicitly set to undefined so each case starts clean.
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  try { return fn(); } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test('isLoopbackHost recognizes loopback names', () => {
  for (const h of ['localhost', '127.0.0.1', '::1', '[::1]']) assert.equal(isLoopbackHost(h), true);
  for (const h of ['0.0.0.0', '192.168.1.5', 'dash.example.com']) assert.equal(isLoopbackHost(h), false);
});

test('Origin allow-list: loopback yes, foreign no, no-Origin no', () => {
  withEnv({ DASH_ALLOWED_ORIGINS: undefined }, () => {
    assert.equal(isAllowedWsOrigin(req('http://localhost:5173')), true);
    assert.equal(isAllowedWsOrigin(req('http://127.0.0.1:5173')), true);
    assert.equal(isAllowedWsOrigin(req('https://evil.example.com')), false);
    assert.equal(isAllowedWsOrigin(req(null)), false); // curl sends no Origin
  });
});

test('DASH_ALLOWED_ORIGINS extends the allow-list exactly', () => {
  withEnv({ DASH_ALLOWED_ORIGINS: 'https://dash.example.com' }, () => {
    assert.equal(isAllowedWsOrigin(req('https://dash.example.com')), true);
    assert.equal(isAllowedWsOrigin(req('https://dash.example.com.evil.com')), false);
  });
});

test('ensureTerminalToken: none on loopback, minted when exposed', () => {
  withEnv({ DASH_TERMINAL_TOKEN: undefined }, () => {
    assert.equal(ensureTerminalToken(false), '');
    assert.equal(terminalToken(), '');
    const t = ensureTerminalToken(true);
    assert.ok(t.length >= 20, 'a real secret is generated');
    assert.equal(terminalToken(), t, 'installed into process.env');
  });
});

test('ensureTerminalToken respects an operator-pinned token', () => {
  withEnv({ DASH_TERMINAL_TOKEN: 'pinned-secret' }, () => {
    assert.equal(ensureTerminalToken(false), 'pinned-secret'); // required even on loopback
    assert.equal(ensureTerminalToken(true), 'pinned-secret');
  });
});

test('handshake with no token: Origin check is the only gate', () => {
  withEnv({ DASH_TERMINAL_TOKEN: undefined, DASH_ALLOWED_ORIGINS: undefined }, () => {
    assert.equal(isAllowedWsHandshake(req('http://localhost:5173')), true);
    assert.equal(isAllowedWsHandshake(req('https://evil.example.com')), false);
  });
});

test('handshake with a token: forged Origin no longer suffices', () => {
  withEnv({ DASH_TERMINAL_TOKEN: 'sekret', DASH_ALLOWED_ORIGINS: undefined }, () => {
    // A non-browser attacker forging Origin: http://localhost but with no/wrong token.
    assert.equal(isAllowedWsHandshake(req('http://localhost', '/api/dash/terminal')), false);
    assert.equal(isAllowedWsHandshake(req('http://localhost', '/api/dash/terminal?token=wrong')), false);
    // The legit browser: allowed Origin AND the right token.
    assert.equal(isAllowedWsHandshake(req('http://localhost', '/api/dash/terminal?token=sekret')), true);
    // Right token but disallowed Origin is still rejected (both layers hold).
    assert.equal(isAllowedWsHandshake(req('https://evil.example.com', '/api/dash/terminal?token=sekret')), false);
  });
});

test('token compare is length-safe and exact', () => {
  withEnv({ DASH_TERMINAL_TOKEN: 'abcdef' }, () => {
    assert.equal(isAllowedWsHandshake(req('http://localhost', '/x?token=abcde')), false);  // shorter
    assert.equal(isAllowedWsHandshake(req('http://localhost', '/x?token=abcdefg')), false); // longer
    assert.equal(isAllowedWsHandshake(req('http://localhost', '/x?token=abcdef')), true);
  });
});

test('token accepted via the WS subprotocol (kept out of the URL/logs)', () => {
  withEnv({ DASH_TERMINAL_TOKEN: 'sekret' }, () => {
    const sub = terminalSubprotocols('sekret').join(', '); // 'dash.terminal.v1, dash.token.sekret'
    // Right token in the subprotocol, no ?token= in the URL.
    assert.equal(isAllowedWsHandshake(req('http://localhost', '/api/dash/terminal', sub)), true);
    // Wrong subprotocol token rejected; extra offered protocols are ignored.
    assert.equal(isAllowedWsHandshake(req('http://localhost', '/api/dash/terminal', 'dash.token.wrong')), false);
    assert.equal(isAllowedWsHandshake(req('http://localhost', '/api/dash/terminal', `chat, ${sub}`)), true);
    // Subprotocol is preferred, but a valid ?token= still works as a fallback.
    assert.equal(isAllowedWsHandshake(req('http://localhost', '/api/dash/terminal?token=sekret')), true);
    // Disallowed Origin still rejected even with the right subprotocol.
    assert.equal(isAllowedWsHandshake(req('https://evil.example.com', '/api/dash/terminal', sub)), false);
  });
});

test('selectTerminalSubprotocol echoes only the token-free base, never the token', () => {
  // Normal client: offers base + token → server selects the base.
  assert.equal(selectTerminalSubprotocol(new Set(['dash.terminal.v1', 'dash.token.abc'])), 'dash.terminal.v1');
  // Base offered alongside other protocols → base wins.
  assert.equal(selectTerminalSubprotocol(new Set(['chat', 'dash.terminal.v1'])), 'dash.terminal.v1');
  // Only a token subprotocol (no base) → select NONE. NEVER echo the token.
  assert.equal(selectTerminalSubprotocol(new Set(['dash.token.xyz'])), false);
  assert.equal(selectTerminalSubprotocol(new Set(['chat'])), false);
  assert.equal(selectTerminalSubprotocol(new Set()), false);
});

test('the accepted subprotocol never carries the token (no response-header leak)', () => {
  // Whatever the server selects from a real client offer must not contain the
  // secret — else it reappears in the 101 response's Sec-WebSocket-Protocol.
  const offered = terminalSubprotocols('sekret'); // ['dash.terminal.v1', 'dash.token.sekret']
  const accepted = selectTerminalSubprotocol(new Set(offered));
  assert.equal(accepted, 'dash.terminal.v1');
  assert.ok(!String(accepted).includes('sekret'), 'accepted subprotocol leaked the token');
});
