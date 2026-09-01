// The dash supervisor — the ONE control-plane process per machine.
//
// Owns everything that was never a dev-server concern: the board API, PTY
// chats, the crash journal, the chat mirror, the reaper, and worktree/dev-
// server lifecycle. Every vite (main or worktree) is a plain dev server that
// proxies /api/dash traffic here through its edge relay. Design + decision
// history: docs/dash-supervisor.md.
//
// BIND FIRST, IMPORT LATER. The port is both the singleton lock and the
// identity anchor: we bind 127.0.0.1:PORT before importing anything with
// restore or sweep side effects, so a losing contender in an ensure race exits
// having caused nothing. EADDRINUSE is only EXCLUSION, not identity — the
// loser must then probe GET /api/dash/supervisor and verify protocolVersion +
// repoRoot before deferring (ensure-supervisor.mjs owns that dance).
//
// Readiness is a declared state (starting → ready | failed), served from the
// moment the socket binds. Requests that arrive during 'starting' get 503 +
// Retry-After rather than a connection error, so an edge can wait out a boot
// instead of failing its user.
//
// Env contract: launched with the USER'S environment preserved (agent PTYs
// inherit it — stripping it breaks git/agent auth) minus the control-plane
// keys, which the supervisor re-derives itself from MAIN_REPO's .env.local
// (ensure-supervisor strips them; node-env.mjs loads them).

import http from 'http';
import { execSync } from 'child_process';
import { PROTOCOL_VERSION, SUPERVISOR_PORT } from './supervisor-contract.mjs';

const port = Number(process.env.LAB_SUPERVISOR_PORT || SUPERVISOR_PORT);
// Tests bind ephemeral/foreground supervisors; only the real one is the
// machine singleton on the well-known port.
const isLab = !!process.env.LAB_SUPERVISOR_PORT;

// Computed ONCE, and only AFTER the bind wins — a per-probe execSync would be
// a synchronous git spawn on every relayed dash request (the amplifier class
// this redesign removes), and a pre-bind one would make every racing loser pay
// a spawn before losing. Until it lands, identity reports 'starting…'.
let CODE_VERSION = 'starting…';

function repoRoot() {
  // The supervisor is always launched from MAIN_REPO (ensure-supervisor
  // resolves it); its own cwd IS the canonical root.
  return process.cwd();
}

let state = 'starting'; // starting → ready | failed
let failure = null;
let bootReport = null; // journal + legacy-import summary, for the cutover to print

const identity = () => ({
  service: 'artifact-dash-supervisor',
  state, failure, bootReport,
  protocolVersion: PROTOCOL_VERSION,
  repoRoot: repoRoot(),
  codeVersion: CODE_VERSION,
  pid: process.pid,
  tables: {
    issues: process.env.DASH_ISSUES_TABLE || 'issues',
    profiles: process.env.DASH_PROFILES_TABLE || 'dash_profiles',
    chats: process.env.DASH_CHATS_TABLE || 'dash_chats',
  },
});

// The middleware chain, installed once boot completes. Until then only the
// readiness endpoint answers.
let chain = null;
function runChain(req, res) {
  const stack = chain;
  let i = 0;
  const next = (err) => {
    if (err) { res.statusCode = 500; res.end('Internal error'); return; }
    const mw = stack[i++];
    if (!mw) { res.statusCode = 404; res.end('Not found'); return; }
    try {
      const r = mw(req, res, next);
      if (r && typeof r.catch === 'function') r.catch(() => { if (!res.writableEnded) { res.statusCode = 500; res.end('Internal error'); } });
    } catch { if (!res.writableEnded) { res.statusCode = 500; res.end('Internal error'); } }
  };
  next();
}

const server = http.createServer((req, res) => {
  const [pathname] = (req.url || '/').split('?');
  if (pathname === '/api/dash/supervisor') {
    res.writeHead(state === 'ready' ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(identity()));
    return;
  }
  if (state !== 'ready' || !chain) {
    res.writeHead(503, { 'Retry-After': '1', 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `supervisor ${state}`, failure }));
    return;
  }
  runChain(req, res);
});

// EXIT CODES ARE A MESSAGE TO SYSTEMD, and the unit reads them (see
// RestartPreventExitStatus in scripts/box/artifact-supervisor.service).
//
//   0  — we were asked to go away and did. Under Restart=always systemd brings
//        us back, which is what we want for EVERY unexpected death: a stray
//        SIGTERM from someone else's cleanup makes terminal.js's shutdown hook
//        exit(0), and until this unit restarted on that, the machine sat with a
//        dead control plane and the next dash request re-adopted a supervisor
//        into the EDGE's cgroup. That is the 2026-08-21 22:08:56 journal entry.
//        An operator's own `systemctl stop` is not an unexpected death, so
//        systemd does not restart it — it never restarts what it stopped.
//   3  — deferred to an incumbent. The one exit systemd must NOT retry, because
//        retrying means fighting a supervisor that already owns the port.
//   1  — could not bind at all. Restarting is worth a few tries (a port freeing
//        up, a network coming back) and the unit's start limit stops it from
//        becoming a loop that buries the reason.
const EXIT_DEFERRED = 3;

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // Exclusion worked: something already owns the port. Identity verification
    // is the CONTENDER'S job (ensure-supervisor probes and defers or reports);
    // our job is only to lose cleanly, having imported nothing with effects.
    console.error(`[supervisor] port ${port} already bound — deferring to the incumbent`);
    process.exit(EXIT_DEFERRED);
  }
  console.error('[supervisor] failed to bind:', e.message);
  process.exit(1);
});

server.listen(port, '127.0.0.1', async () => {
  console.log(`[supervisor] bound 127.0.0.1:${port} (starting)`);
  try {
    CODE_VERSION = execSync('git rev-parse HEAD', { encoding: 'utf8', cwd: process.cwd() }).trim().slice(0, 12);
  } catch { CODE_VERSION = 'unknown'; }
  try {
    await boot();
    state = 'ready';
    console.log(`[supervisor] ready — repo ${repoRoot()}`);
  } catch (e) {
    state = 'failed';
    failure = e.message;
    // Stay bound and REPORT rather than exit: an exiting failure would make
    // every ensure retry re-spawn us in a crash loop; a bound 'failed' state is
    // diagnosable from any edge in one request.
    console.error('[supervisor] boot failed:', e);
  }
});

async function boot() {
  // Control-plane config from MAIN_REPO (.env.local: Supabase creds etc.).
  await import('./node-env.mjs');

  // A supervisor on any port but the well-known one is NOT this machine's
  // control plane — it is a test harness, or somebody's hand-started copy. It
  // must therefore own its chat state, and this refuses to boot until it does.
  //
  // Pointed at the MACHINE's stores, an off-port supervisor is not a spectator:
  // boot reconciliation would terminate the real chats and re-adopt them as its
  // own children, and every chat it spawned after that would be invisible to the
  // real supervisor — a live agent nobody tracks, holding its transcript open.
  // That is precisely how a codex thread ended up with a writer no dash could
  // account for, and card-open ran into `already has an active writer`
  // (i-codex-resume-collision). Refusing here removes the whole class; the
  // reclaim on the other side is only the net for what a hard kill can still
  // strand.
  if (isLab) {
    const { registryDir, machineRegistryDir } = await import('./proc-identity.mjs');
    const { storeDir, machineStoreDir } = await import('./main-chats-store.mjs');
    const shared = [];
    if (registryDir() === machineRegistryDir()) shared.push('LAB_CHAT_REGISTRY_DIR');
    if (storeDir() === machineStoreDir()) shared.push('LAB_MAIN_CHATS_DIR');
    if (shared.length) {
      throw new Error(
        `a supervisor off the well-known port must own its chat state, and this one is using the machine's: set ${shared.join(' and ')} to a private directory (or drop LAB_SUPERVISOR_PORT and be the machine's one supervisor)`,
      );
    }
  }

  // Capability, not version-parsing: prove node:sqlite initializes in the
  // cursor-db worker on THIS node before reporting ready. A runtime too old
  // for --experimental-sqlite is one clear line at boot instead of silently
  // missing Cursor chats.
  const { assertCursorDbCapability } = await import('./cursor-db.mjs');
  await assertCursorDbCapability();

  // Heavy imports strictly AFTER bind — none of these may run in a losing
  // contender (terminal.js touches the journal dir at import time in no way,
  // but its module init wires process handlers; the sweeps act on the machine).
  const { WebSocketServer } = await import('ws');
  const { dashApi, gifsServe } = await import('./dash-api.js');
  const { attachChat, handleTerminalHttp, reconcileChats } = await import('./terminal.js');
  const {
    isAllowedWsHandshake, selectTerminalSubprotocol, ensureMachineToken,
    isAllowedApiRequest, isAllowedExposedApiRequest,
  } = await import('./ws-guard.mjs');

  chain = [
    // Gate the whole /api/dash surface with the SAME check every other surface
    // uses — Host/Origin allow-list, then a peer the network authenticated or
    // the machine token. It used to stop at the Host, on the reasoning that a
    // loopback bind is only reachable from the box; that is the very assumption
    // this codebase just finished retiring (issue
    // i-loopback-trust-vs-exposed-token), and it left the one surface that
    // relays PTYs and mints privileged sessions defended by nothing but its
    // edges. Every real caller still passes: a box-local process is a trusted
    // loopback peer, an edge relays the client's own headers so a fronted
    // client is judged on the address its front named, and a tokenized client
    // carries the token through the relay.
    (req, res, next) => {
      if (!req.url?.startsWith('/api/dash')) return next();
      if (!isAllowedApiRequest(req)) { res.statusCode = 403; res.end('Forbidden'); return; }
      if (!isAllowedExposedApiRequest(req)) { res.statusCode = 401; res.end('Unauthorized'); return; }
      next();
    },
    // Terminal sidecar HTTP before dashApi so /api/dash/terminal/* wins.
    (req, res, next) => {
      const [pathname] = (req.url || '/').split('?');
      if (!pathname.startsWith('/api/dash/terminal')) return next();
      const segs = pathname.replace(/^\/api\/dash\/terminal\/?/, '').split('/').filter(Boolean);
      handleTerminalHttp(req, res, segs).catch((e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
    },
    dashApi(),
    gifsServe(),
  ];

  // Terminal WS — same handshake contract the vite edges relay to.
  const termWss = new WebSocketServer({ noServer: true, handleProtocols: selectTerminalSubprotocol });
  // Mint/persist the ONE machine token every edge verifies against. Exposure
  // policy (whether a handshake must present it) lives at each edge; the
  // supervisor itself is loopback-only and requires it only under an operator
  // pin (isAllowedWsHandshake's default).
  ensureMachineToken();
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/api/dash/terminal') { socket.destroy(); return; }
    if (!isAllowedWsHandshake(req)) { socket.destroy(); return; }
    const issueId = url.searchParams.get('issue');
    const sessionId = url.searchParams.get('session');
    const mode = url.searchParams.get('mode') || 'resume';
    const agent = url.searchParams.get('agent') || undefined;
    if (!issueId || (issueId !== 'main' && !sessionId)) { socket.destroy(); return; }
    termWss.handleUpgrade(req, socket, head, (ws) => {
      attachChat(ws, { issueId, sessionId, mode, agent }).catch((e) => {
        console.error('[supervisor] attach failed at upgrade boundary:', e);
        try { ws.close(1011, 'attach failed'); } catch {}
      });
    });
  });

  // Journal reconciliation: resume what the last supervisor's death stranded,
  // park what can't be proven. Awaited — a booting supervisor must not answer
  // 'ready' while chats it should be hosting are still unclaimed, or an early
  // attach could race the restore into a duplicate.
  bootReport = await reconcileChats();

  // Housekeeping — unconditional here (this IS the one elected place), still
  // opt-out for test-isolated supervisors whose table/registry isolation cannot
  // sandbox real machine state.
  if (!process.env.LAB_DASH_NO_HOUSEKEEPING && !isLab) {
    const { startReaperSweep } = await import('./reaper-sweep.mjs');
    startReaperSweep();
    const { startMirrorSweep } = await import('./mirror-sweep.mjs');
    startMirrorSweep();
    // Renders the recordings tab's videos. Child-process, one at a time, a few
    // per pass — see recording-video-sweep.mjs for why it lives on the box.
    const { startVideoSweep } = await import('./recording-video-sweep.mjs');
    startVideoSweep();
    // …and finishes recordings nobody stopped, and reads the words off the
    // audio they streamed — the box holds GROQ_API_KEY; no browser does.
    const { startVoiceSweep } = await import('./recording-voice-sweep.mjs');
    startVoiceSweep();
  }
}
