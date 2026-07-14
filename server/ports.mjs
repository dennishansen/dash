// Dev-server port lifecycle — node-only (bind-probes and process kills), split
// from the isomorphic issues-store so the browser bundle never touches node:net.
//
// Each active issue's worktree gets a stable dev-server port in [5200,5299]
// (never 5173, the main repo's server). The PERSISTED `port` column is the
// reservation registry, but the OS owns the truth about what is actually
// listening — and the two can disagree (a `done` that never killed the vite
// server leaves a zombie listener on a registry-free port). So both lifecycle
// ends consult the OS:
//   allocate — the lowest port neither reserved by any issue row NOR in
//              LISTEN on a loopback interface (a bind probe, not a guess)
//   free     — kill whatever still listens on the port, wait for the OS to
//              release it, and only then clear the row; if the port can't be
//              released the row keeps it and the caller gets an error, so the
//              registry never claims a port that isn't really free
// Allocation stays stable (an issue keeps its port; re-allocating never
// probes or kills) and idempotent.
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { get, update, reservedPorts } from './issues-store.mjs';

const pExecFile = promisify(execFile);

const PORT_MIN = 5200;
const PORT_MAX = 5299;

// Can we bind the port on one loopback host right now? Host matters: vite dev
// servers land on ::1 on macOS, and a 127.0.0.1 probe does not collide with a
// ::1 listener (or vice versa) — so freedom means bindable on BOTH stacks.
function bindableOn(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

async function osFree(port) {
  return (await bindableOn(port, '127.0.0.1')) && (await bindableOn(port, '::1'));
}

// PIDs currently LISTENing on the port (any interface). lsof exits 1 on no
// match — that's "none", not an error.
async function listenerPids(port) {
  try {
    const { stdout } = await pExecFile('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']);
    return stdout.split('\n').map(s => s.trim()).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

// Kill the port's listeners and wait for the OS to release it. SIGTERM first,
// escalate to SIGKILL if it's still held, poll up to ~2s total. Returns
// { released, killed } — released false means something unkillable holds it.
async function releasePort(port) {
  let killed = 0;
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const pids = await listenerPids(port);
    if (pids.length === 0 && await osFree(port)) return { released: true, killed };
    for (const pid of pids) {
      try { process.kill(pid, signal); killed++; } catch {}
    }
    for (let i = 0; i < 10; i++) {
      if (await osFree(port)) return { released: true, killed };
      await new Promise(r => setTimeout(r, 100));
    }
  }
  return { released: await osFree(port), killed };
}

// Reserve a port for an issue, idempotently. If the row already holds a port,
// return it unchanged — no probe, no kill (its own dev server may be the
// listener). Otherwise pick the lowest port that is free in the registry AND
// free on the OS, and persist it (the persist IS the reservation).
// Returns { ok, port } or { error }.
export async function allocatePort(id) {
  const row = await get(id);
  if (!row) return { error: `no issue "${id}"` };
  if (row.port != null) return { ok: true, port: Number(row.port), reused: true };
  const reserved = await reservedPorts();
  const taken = new Set(reserved.values());
  let port = null;
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (!taken.has(p) && await osFree(p)) { port = p; break; }
  }
  if (port == null) return { error: `no free dev-server port in ${PORT_MIN}-${PORT_MAX}` };
  await update(id, { port });
  return { ok: true, port, reused: false };
}

// Release an issue's reserved port: tear down whatever still listens on it
// (the issue's dev server, or a zombie), wait for the OS to let it go, then
// clear the row. The row is only cleared once the port is genuinely free —
// a port that can't be released stays reserved and the caller gets an error.
// Idempotent — freeing an already-portless row is a no-op.
// Returns { ok, freed, killed } or { error }.
export async function freePort(id) {
  const row = await get(id);
  if (!row) return { error: `no issue "${id}"` };
  const had = row.port != null ? Number(row.port) : null;
  if (had == null) return { ok: true, freed: null, killed: 0 };
  const { released, killed } = await releasePort(had);
  if (!released) return { error: `port ${had} is still held after killing its listeners — leaving it reserved for "${id}"` };
  await update(id, { port: null });
  return { ok: true, freed: had, killed };
}
