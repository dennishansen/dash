// The edge↔supervisor contract, importable WITHOUT executing the supervisor
// (supervisor.mjs binds its port at import time — by design).
//
// PROTOCOL_VERSION gates compatibility: an edge refuses a mismatched incumbent
// loudly instead of speaking a framing it doesn't share. Bump on any breaking
// change to the readiness contract, the terminal WS framing, or the /api/dash
// surface. The supervisor's codeVersion is diagnostic only.
export const PROTOCOL_VERSION = 1;

// One well-known loopback port per machine — outside the 5200-5299 dev-server
// reap range, beside 5173. The bind is the singleton lock; identity comes from
// GET /api/dash/supervisor. LAB_SUPERVISOR_PORT points tests at their own
// harness-owned foreground instance.
export const SUPERVISOR_PORT = 5170;

// The dev-server port range: one stable port per active issue's worktree. Three
// files used to re-declare it (ports.mjs allocates in it, idle-reaper sweeps it,
// and scripts/box/tailnet-serve.sh has to front every port in it with TLS), and
// a range that disagrees with itself leaks servers or reaps live ones. Declared
// once, here, beside the other well-known ports.
export const DEV_PORT_MIN = 5200;
export const DEV_PORT_MAX = 5299;
