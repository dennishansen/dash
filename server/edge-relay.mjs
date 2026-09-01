// The EDGE half of the supervisor split: every vite instance guards dash
// traffic at its own ingress, lazily ensures the machine's supervisor exists,
// and relays to it on loopback. This is a hand-rolled relay, not vite's proxy,
// on purpose: the guard and the ensure must be AWAITED inside the one handler
// that forwards (vite's proxy would race its own upgrade listener against a
// sibling), the Host header must arrive at the supervisor untouched
// (changeOrigin semantics would blind its defense-in-depth guard), and the WS
// leg is a raw socket splice with no Origin rewriting. See
// docs/dash-supervisor.md.

import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { MAIN_REPO } from './workspace-env.mjs';
import { sameHostOrigin } from '../src/same-host-origin.mjs';
import { SUPERVISOR_PORT, PROTOCOL_VERSION } from './supervisor-contract.mjs';
import {
  isAllowedApiRequest, isAllowedExposedApiRequest, isAllowedWsHandshake,
  edgeIsExposed, terminalToken, declaredTrustedPeers, trustedFrontRanges,
} from './ws-guard.mjs';

const HOST = '127.0.0.1';
const port = () => Number(process.env.LAB_SUPERVISOR_PORT || SUPERVISOR_PORT);

// Control-plane keys never travel from a requesting vite into the MACHINE
// supervisor: a stray table override or minted token must not become machine
// state. Everything else — the USER'S environment — is preserved, because
// agent PTYs inherit the supervisor's env and stripping it breaks git/agent
// auth (SSH_AUTH_SOCK, exported API keys). The supervisor re-derives its own
// control-plane config from MAIN_REPO's .env.local.
//
// In LAB mode (LAB_SUPERVISOR_PORT set) the harness's isolation env IS the
// config — pass it through whole. Stripping there would point a test
// supervisor at real machine state, the exact opposite of the contract.
export function __supervisorEnvForTest() { return supervisorEnv(); }
function supervisorEnv() {
  const env = { ...process.env };
  if (process.env.LAB_SUPERVISOR_PORT) return env;
  for (const k of Object.keys(env)) {
    // Every DASH_* knob is control-plane configuration (identity, exposure,
    // token) — the supervisor re-derives them from MAIN_REPO's .env.local, so
    // no requesting edge can pick machine-wide state (DASH_DEV_EMAIL chooses
    // WHO the local dev session is; an edge-supplied value would let whichever
    // worktree wins the first request choose the machine's identity).
    if (k.startsWith('SUPABASE_') || k.startsWith('DASH_')
      // Agent-harness session plumbing: when the ensuring edge runs INSIDE a
      // Claude/Codex session (an agent ran the cutover, an agent's script hit
      // the API), these mark every PTY the supervisor spawns as a CHILD
      // session — which turns TRANSCRIPT SAVING OFF, silently severing
      // resumability and the mirror. The supervisor is nobody's child.
      || k.startsWith('CLAUDE') || k.startsWith('CODEX')) {
      delete env[k];
    }
  }
  return env;
}

// WHERE A LAZILY-SPAWNED SUPERVISOR'S OUTPUT GOES.
//
// It used to go to /dev/null. The supervisor is the machine's ONE control plane
// — it prints why a boot failed, why it deferred, why an upgrade attach threw —
// and every word of that was being discarded, so "the dash is broken" had no
// first place to look. A file, next to the other machine-local dash state in
// ~/.claude, is that place.
//
// Bounded, not rotated: one rollover at 8MB keeps a long-lived box (weeks of
// uptime) from filling a disk without pulling in a rotation dependency. And it
// is BEST-EFFORT by construction — an unwritable home must never be the reason
// the machine has no control plane, so every failure here falls back to the old
// 'ignore' and the supervisor still starts.
//
// Under systemd the unit starts the supervisor directly and journald captures
// the same stream; this path stays for the lazy ensure, which is what runs on a
// laptop and whenever the unit is not the thing that started it.
const LOG_MAX_BYTES = 8 * 1024 * 1024;
export function supervisorLogPath() {
  return process.env.DASH_SUPERVISOR_LOG || path.join(os.homedir(), '.claude', 'dash-supervisor.log');
}
export function __openSupervisorLogForTest() { return openSupervisorLog(); }
function openSupervisorLog() {
  try {
    const p = supervisorLogPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    try { if (fs.statSync(p).size > LOG_MAX_BYTES) fs.renameSync(p, `${p}.1`); } catch {}
    const fd = fs.openSync(p, 'a');
    fs.writeSync(fd, `\n=== supervisor spawned by edge ${process.pid} at ${new Date().toISOString()} ===\n`);
    return fd;
  } catch { return null; }
}

// WHO OWNS THE SUPERVISOR'S LIFECYCLE — asked, not assumed.
//
// The edge REQUIRES a supervisor; it has never owned one. On a laptop nothing
// else does either, so the edge spawns it and that is the whole model. On a box
// systemd owns it, and the difference is not a preference — it is a cgroup. A
// process this edge spawns is filed under artifact-dash.service however
// detached it is, so from that moment `systemctl restart artifact-dash` means
// "kill the machine's control plane and every live chat". The box did exactly
// that on 2026-08-19, twice more on 2026-08-20, and again at 22:08:56 on
// 2026-08-21 — that one is in the journal: the unit dead, its replacement born
// the same second inside the edge's cgroup.
//
// KillMode=process and After=artifact-supervisor made it rarer without making
// it impossible, because they treat the symptom of a wrong owner. So the owner
// is DECLARED, and asked before anything is started:
//
//   unit loaded     → systemctl start it. The supervisor lands in its OWN
//                     cgroup because systemd put it there — by construction,
//                     not by anybody remembering to be careful.
//   unit not-found  → nobody owns it. Spawn it, exactly as a laptop always has.
//   anything else   → masked, bad-setting, error: systemd knows this unit and
//                     will not run it. That is a decision or a defect, and a
//                     child spawned here would quietly override either one.
//
// A systemctl that REFUSES is reported, never worked around. Falling back to a
// spawn is not a safety net, it is the bug — the whole point is that on a box
// there is exactly one way a supervisor comes into existence.
const SUPERVISOR_UNIT = 'artifact-supervisor.service';
// Both overridable so a test can drive the systemd path against a throwaway
// unit and a stand-in systemctl, the way scripts/box/lib/units.sh lets the
// cutover tests drive the real install path against a user-owned directory. A
// LAB supervisor is nobody's machine unit, so there the default is none.
function supervisorUnit() {
  const declared = process.env.DASH_SUPERVISOR_UNIT;
  if (declared !== undefined) return declared.trim();
  return process.env.LAB_SUPERVISOR_PORT ? '' : SUPERVISOR_UNIT;
}

function systemctl(args) {
  return new Promise((resolve) => {
    execFile(process.env.DASH_SYSTEMCTL || 'systemctl', args, { timeout: 30000 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        out: String(stdout || '').trim(),
        err: String(stderr || '').trim() || (err ? err.message : ''),
      });
    });
  });
}

// { kind: 'systemd' | 'self' | 'refuses', unit, state } — LoadState is
// systemd's own word for it, so this is a lookup, never a guess.
async function supervisorOwner() {
  const unit = supervisorUnit();
  if (!unit) return { kind: 'self' };
  const { ok, out } = await systemctl(['show', '-p', 'LoadState', '--value', unit]);
  // No systemctl on this machine at all (a mac, a container): nobody but us.
  if (!ok) return { kind: 'self' };
  if (out === 'loaded') return { kind: 'systemd', unit, state: out };
  if (out === 'not-found') return { kind: 'self' };
  return { kind: 'refuses', unit, state: out || 'unknown' };
}

// Bring the machine's supervisor into existence, through its owner.
async function startMachineSupervisor() {
  const owner = await supervisorOwner();
  if (owner.kind === 'self') { spawnSupervisorChild(); return; }
  const never = 'this edge will not spawn its own — a supervisor fathered by the edge lives in the EDGE\'s cgroup and dies with it, taking every chat on the machine';
  if (owner.kind === 'refuses') {
    throw new Error(`systemd knows ${owner.unit} and will not run it (LoadState=${owner.state}); ${never}. Unmask or repair the unit: systemctl status ${owner.unit}`);
  }
  const { ok, err } = await systemctl(['start', owner.unit]);
  if (!ok) throw new Error(`systemd owns the supervisor on this machine and refused to start ${owner.unit}: ${err || 'no output'}; ${never}. Run: sudo systemctl start ${owner.unit}`);
}

// One readiness probe: { state, protocolVersion, repoRoot, ... } or null when
// nothing answers.
function probe() {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port: port(), path: '/api/dash/supervisor', timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Ensure the machine's supervisor is running and READY, asking its OWNER to
// start one if nothing answers (supervisorOwner above). Identity is verified,
// not assumed: a probe that answers with the wrong protocolVersion or a
// different repoRoot is a loud conflict, never silently used. Concurrent
// callers (several requests, several vites) collapse onto one in-flight ensure;
// races across processes are settled by the supervisor's own bind (losers exit).
let inflight = null;
export function ensureSupervisor() {
  if (!inflight) {
    inflight = ensureNow().finally(() => {
      // Re-ensure on the NEXT request only after this attempt settles — a
      // ready supervisor makes the next ensure a single cheap probe.
      inflight = null;
    });
  }
  return inflight;
}

// The laptop path, and ONLY the laptop path: a detached child of this vite.
// Unreachable on any machine whose systemd has the unit — see supervisorOwner
// above for why that distinction is a cgroup rather than a taste.
function spawnSupervisorChild() {
  const entry = path.join(MAIN_REPO, 'dash', 'server', 'supervisor.mjs');
  const log = openSupervisorLog();
  const child = spawn(process.execPath, [entry], {
    cwd: MAIN_REPO, env: supervisorEnv(), detached: true,
    stdio: log == null ? 'ignore' : ['ignore', log, log],
  });
  // Our copy of the fd has done its job the moment the child inherits it.
  if (log != null) { try { fs.closeSync(log); } catch {} }
  child.unref();
}

async function ensureNow() {
  let started = false;
  // 30s covers start + bind; a supervisor REPORTING 'starting' is making
  // progress (a real boot resumes real chats — each an agent CLI spawn — and
  // can far outlive a lab boot), so the deadline slides while it reports
  // starting, under a hard cap. The first REAL cutover aborted here at 30s
  // while the supervisor booted on correctly behind it.
  let deadline = Date.now() + 30000;
  const hardCap = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const id = await probe();
    if (id?.state === 'starting' && Date.now() + 30000 < hardCap) deadline = Date.now() + 30000;
    if (id) {
      if (id.service !== 'artifact-dash-supervisor' || !id.repoRoot) {
        throw new Error(`something else answers on :${port()} (${JSON.stringify({ service: id.service })}) — not a dash supervisor; free the port or set LAB_SUPERVISOR_PORT`);
      }
      if (id.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`supervisor on :${port()} speaks protocol ${id.protocolVersion}, this edge speaks ${PROTOCOL_VERSION} — restart the supervisor from current main`);
      }
      if (path.resolve(id.repoRoot) !== path.resolve(MAIN_REPO)) {
        throw new Error(`supervisor on :${port()} serves ${id.repoRoot}, this checkout is ${MAIN_REPO} — one artifact clone per machine (docs/dash-supervisor.md)`);
      }
      if (id.state === 'ready') return id;
      if (id.state === 'failed') throw new Error(`supervisor boot failed: ${id.failure}`);
      // 'starting' — wait it out.
    } else if (!started) {
      started = true;
      await startMachineSupervisor();
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const unit = supervisorUnit();
  throw new Error(`supervisor on :${port()} did not become ready within 30s`
    + (unit ? ` — ${unit} was asked to start it; \`journalctl -u ${unit} -n 50\`` : ''));
}

// HTTP relay: stream the request to the supervisor verbatim (method, path,
// headers — Host included) and the response back. The edge has already
// guarded; the supervisor guards again for direct callers.
//
// EVERY lifecycle edge is contained, because an uncaught throw here exits the
// whole vite: a browser aborting an in-flight dash request (an iframe reload
// does this constantly) destroys `res`, and a later writeHead on it throws
// synchronously inside the upstream callback — the crash that silently killed
// the shared test server mid-suite. Abort tears the upstream down; upstream
// death answers 502 only while an answer is still possible.
function relayHttp(req, res) {
  const up = http.request({
    host: HOST, port: port(), method: req.method, path: req.url,
    headers: req.headers,
  }, (upRes) => {
    if (res.destroyed || res.headersSent) { upRes.destroy(); return; }
    try {
      upRes.on('error', () => { try { res.destroy(); } catch {} });
      upRes.on('aborted', () => { try { res.destroy(); } catch {} });
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    } catch { try { upRes.destroy(); } catch {} }
  });
  const abort = () => { try { up.destroy(); } catch {} };
  res.on('close', abort);
  req.on('error', abort);
  up.on('error', (e) => {
    try {
      if (res.destroyed) return;
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      if (!res.writableEnded) res.end(JSON.stringify({ error: `supervisor unreachable: ${e.message}` }));
    } catch {}
  });
  req.pipe(up);
}

// WS relay: splice the accepted upgrade onto a fresh loopback socket carrying
// the ORIGINAL request line + headers (Origin untouched — rewriting it is the
// CSRF-enabling move vite's own proxy documentation warns about).
function relayUpgrade(req, socket, head) {
  const up = net.connect(port(), HOST, () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    raw += '\r\n';
    up.write(raw);
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
    // Only now may client bytes flow: the caller paused the socket before the
    // awaited ensure, and resuming before BOTH pipes exist would drop any
    // frames the client sent right after its handshake.
    socket.resume();
  });
  const kill = () => { try { up.destroy(); } catch {} try { socket.destroy(); } catch {} };
  up.on('error', kill);
  socket.on('error', kill);
}

// The vite plugin: one middleware for /api/dash + /dash/gifs, one upgrade
// handler for the terminal WS — guard first, ensure second, relay third, all
// awaited in-handler. Exposure is decided per LISTENER (routable bind, or a
// tunnel announced via DASH_ALLOWED_HOSTS): an exposed edge requires the
// machine token on every terminal handshake FROM A CLIENT THE NETWORK HAS NOT
// ALREADY AUTHENTICATED — a peer in DASH_TRUSTED_PEERS, arriving directly or
// named by a relay in DASH_TRUSTED_FRONT, needs none (see ws-guard). It prints
// the tokenized URL regardless, because that one works on every route and the
// edge cannot know which route a printed NAME takes; the supervisor minted the
// token, so the same URL works through any edge on the machine.
export function dashEdge({ store = null } = {}) {
  return {
    name: 'dash-edge',
    configureServer(server) {
      let exposed = false;
      server.httpServer?.once('listening', () => {
        exposed = edgeIsExposed(server.httpServer.address());
        if (!exposed) return;
        // Eager ensure on an exposed edge: remote use is the declared intent,
        // and the printed URL needs the supervisor's token to exist.
        ensureSupervisor().then(() => {
          const addr = server.httpServer.address();
          const p = addr && typeof addr === 'object' ? addr.port : '';
          // THE FRONT, as a browser would actually type it. This used to guess
          // `https://<first allowed host>` with no port — right for the ngrok
          // tunnel it was written for, wrong for every other front, and the
          // printed URL is the one a human copies. DASH_ALLOWED_ORIGINS is the
          // operator's own statement of scheme + host + port, so prefer it and
          // only compose a fallback when it is absent.
          const origins = (process.env.DASH_ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
          const hosts = (process.env.DASH_ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
          const front = origins[0]
            || (hosts[0] ? `http://${hosts[0]}:${p}` : sameHostOrigin(os.hostname(), p));
          // ONE URL, AND IT ALWAYS WORKS. The banner used to predict whether
          // the token was needed and was wrong three ways — see ws-guard's note
          // above edgeIsExposed. The settings say who is trusted, never which
          // path a NAME takes to reach us, so the tokenized URL is printed
          // unconditionally and the condition for dropping it is stated as a
          // rule the operator can check against their own deployment.
          const peers = declaredTrustedPeers();
          const fronts = trustedFrontRanges();
          const tok = terminalToken();
          if (!tok) {
            console.log('\n  ⚠ dash edge is network-reachable but no machine token exists — terminal handshakes will be REFUSED (fail closed).\n');
            return;
          }
          const dropIt = peers && peers.length
            ? `    The ?token= is unnecessary for a peer in DASH_TRUSTED_PEERS (${peers.join(',')})\n`
              + `    that reaches this edge directly${fronts.length ? `, or through a relay at ${fronts.join(',')}\n    (DASH_TRUSTED_FRONT)` : ''} — this URL works either way, so drop it if you\n`
              + `    would rather not paste a secret.\n`
            : '    (set DASH_TRUSTED_PEERS to trust a private network instead, or\n'
              + '     DASH_ALLOWED_ORIGINS to pin the origin this URL is built from.)\n';
          console.log(
            `\n  ⚠ dash edge is network-reachable. This URL carries the machine token,\n` +
            `  so it works on every route in:\n` +
            `    Open: ${front}/dash/?token=${tok}\n` + dropIt);
        }).catch(() => {});
      });
      server.middlewares.use(async (req, res, next) => {
        const [pathname] = (req.url || '/').split('?');
        if (!pathname.startsWith('/api/dash') && !pathname.startsWith('/dash/gifs/')) return next();
        // Exposed ingress requires the machine token on HTTP too, of anyone the
        // network has not already authenticated — the board API mints
        // privileged sessions, and Host/Origin authenticate nothing from a raw
        // tunnel client.
        const ok = exposed ? isAllowedExposedApiRequest(req) : isAllowedApiRequest(req);
        if (!ok) { res.statusCode = exposed ? 401 : 403; res.end(exposed ? 'Token required' : 'Forbidden'); return; }
        // This is deliberately EDGE-local: it reports the exact project,
        // tables, and run id captured by appDev() for the browser defines.
        // Relaying it would only prove the supervisor twice and could conceal
        // a bundle pointed at another namespace.
        if (pathname === '/api/dash/edge-store') {
          if (req.method !== 'GET') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'GET only' }));
          } else if (!store) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'edge store identity is unavailable' }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(store));
          }
          return;
        }
        try { await ensureSupervisor(); } catch (e) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
        relayHttp(req, res);
      });
      server.httpServer?.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url || '/', 'http://localhost');
        if (url.pathname !== '/api/dash/terminal') return;
        if (process.env.DASH_EDGE_DEBUG) console.error('[edge] upgrade seen', req.url);
        if (!isAllowedWsHandshake(req)) { if (process.env.DASH_EDGE_DEBUG) console.error('[edge] pre-guard reject'); socket.destroy(); return; }
        // Buffer nothing extra ourselves: pause until ensure settles, then
        // splice with whatever head bytes arrived.
        socket.pause();
        ensureSupervisor().then(() => {
          // Re-check with the token requirement the ENSURE may have just made
          // satisfiable (the supervisor mints the machine token at boot).
          if (!isAllowedWsHandshake(req, { requireToken: exposed })) { if (process.env.DASH_EDGE_DEBUG) console.error('[edge] token reject, exposed=', exposed); socket.destroy(); return; }
          relayUpgrade(req, socket, head); // resumes the socket once both pipes exist
        }).catch((e) => { if (process.env.DASH_EDGE_DEBUG) console.error('[edge] ensure failed:', e.message); socket.destroy(); });
      });
    },
  };
}
