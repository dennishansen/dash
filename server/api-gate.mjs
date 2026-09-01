// The ingress gate for every API surface a vite edge serves — the APP's half of
// what dash/server/edge-relay.mjs already does for /api/dash.
//
// WHAT WAS OPEN. The dash has been gated since the day it was first tunnelled.
// The app-dev surfaces never were, because "dev server" used to mean "loopback
// only". They are not less privileged than the dash:
//
//   /api/doc, /api/agent    drive a live document and spawn headless Apps
//   /ws                     the same control plane as a socket (drive, inhabit)
//   /api/debug              writes a file on the box
//   /api/debug/sessions     reads and writes the Supabase session corpus
//
// On a box that binds a routable address (DASH_BIND_HOST=0.0.0.0) all of those
// were reachable by anything that could reach the port, with no credential of
// any kind. Two of them had `isAllowedApiRequest` in front, which reads like
// authentication and is not: it is a DNS-REBINDING defence. It answers "is this
// PAGE allowed to talk to us?", never "WHO is this?" — and the front door's own
// hostname must be in DASH_ALLOWED_HOSTS for the dash to work at all, so the
// moment an origin is declared that check passes for any client on the network
// that sends the right Host. The other three had nothing at all.
//
// THE GATE is the one the machine already uses, not a second scheme: the Host
// allow-list AND a peer the network has already authenticated (loopback, or an
// operator-declared DASH_TRUSTED_PEERS) or the machine token. See ws-guard.mjs
// for why a trusted peer needs no token.
//
// WHY UNCONDITIONALLY, where edge-relay branches on `exposed`. On a listener
// bound to loopback the two are the SAME check — every peer such a listener can
// ever accept is loopback, and loopback is trusted outright — so the branch buys
// nothing here and costs a piece of per-listener state that a rebind can outrun.
// Requiring the stronger check always means the gate cannot be wrong about which
// address it ended up on.
//
// FAIL CLOSED. The rule is "every path under /api", not a list of the ones known
// to be privileged today; such a list is only correct on the day it is written.
// The next endpoint added to dev/app-server.mjs is gated by default, and any
// exemption has to be argued for here, in the file that owns the policy.
//
// NOT THE APP'S DOOR, and deliberately not wired to it. src/access/gate.mjs
// answers "whose page is this" from DASH_ACCESS_DOOR — importable here,
// under the same name, if this file ever needs the same answer. It does not
// today, and must not take it as a licence: a dev server lowers the app door
// for the developer, and lowering THIS gate on the same signal would open
// /api/doc and /ws to everything that can reach the port. Product access and
// machine control are different questions; only the first has a door.
import { STATUS_CODES } from 'http';
import { isAllowedApiRequest, isAllowedExposedApiRequest } from './ws-guard.mjs';

// Everything under /api, plus /ws — the app's multiplayer socket, the one
// privileged surface that does not live under /api. Vite's own HMR socket is
// deliberately absent: it carries no privilege, and gating it would break the
// reload loop for no gain.
const GUARDED_MOUNTS = ['/api', '/ws'];

function isGuardedPath(pathname) {
  return GUARDED_MOUNTS.some((m) => pathname === m || pathname.startsWith(m + '/'));
}

// Why this request is refused, or null if it is allowed.
//
// The two refusals are genuinely different questions and deserve different
// codes. 403 is "this Host or Origin may never talk to us" — a rebinding page,
// which no credential can fix. 401 is "you may, once you say who you are" — a
// stranger on the network who needs the machine token. Collapsing them into one
// code costs the next agent an hour of debugging a 403 by adding a token.
function apiRefusal(req) {
  if (!isAllowedApiRequest(req)) {
    return { status: 403, detail: 'Forbidden — Host/Origin is not on the allow-list' };
  }
  if (!isAllowedExposedApiRequest(req)) {
    return { status: 401, detail: 'Unauthorized — untrusted peer, no valid machine token' };
  }
  return null;
}

// Does this upgrade target reach a guarded surface? Read BOTH ways a downstream
// reads it — the plain split dev/app-server.mjs uses for /ws, and the URL parse
// edge-relay.mjs uses for /api/dash/terminal — and guard if EITHER says yes.
// Over-guarding an upgrade nothing serves costs nothing; under-guarding one is
// how the HTTP side of this gate was walked past the first time (below).
function isGuardedUpgrade(rawUrl) {
  const url = String(rawUrl || '/');
  if (isGuardedPath(url.split('?')[0])) return true;
  try {
    return isGuardedPath(new URL(url, 'http://placeholder').pathname);
  } catch {
    return false;
  }
}

// The vite plugin. Composed FIRST by every host config (vite.config.js,
// vite.host.config.js) — a gate that runs after the handler it guards is not a
// gate — and composed there rather than inside dev/app-server.mjs on purpose:
// app-server is BRANCH-owned, so a worktree checked out at an older commit would
// serve its own ungated copy. The host configs always load from the main
// checkout, so every dev server the supervisor spawns is gated regardless of
// what its branch predates. Registering it twice is harmless by construction:
// the second middleware sees a request the first already passed, and the second
// upgrade listener sees a socket the first already destroyed.
export function apiGate() {
  return {
    name: 'api-gate',
    configureServer(server) {
      // MOUNTED, not pattern-matched. The gate asks connect "does this request
      // reach /api?" using the very matcher that decides whether it reaches
      // /api/debug — so the two can never disagree.
      //
      // The first version of this gate did its own `req.url.split('?')[0]` and
      // was walked past in one line: `GET http://dash-main/api/debug HTTP/1.1`
      // is a legal HTTP/1.1 request target (absolute-form, which an origin
      // server MUST accept). Node hands that whole URI to `req.url`; connect
      // resolves it and ran the handler, while the gate saw a string starting
      // with "http" and waved it through. Measured, from off-box: the POST
      // wrote the file. Reimplementing a router's path resolution is a bug
      // waiting to be found by whoever looks hardest — so don't.
      for (const mount of GUARDED_MOUNTS) {
        server.middlewares.use(mount, (req, res, next) => {
          const refusal = apiRefusal(req);
          if (!refusal) return next();
          res.statusCode = refusal.status;
          res.setHeader('Content-Type', 'text/plain');
          res.end(refusal.detail);
        });
      }
      // A refused upgrade is answered on the raw socket — there is no res yet,
      // and no connect either, so this side does read the target itself.
      // Listeners fire in registration order, so this runs before the
      // multiplayer plugin's; that handler bails on an already-destroyed socket.
      server.httpServer?.on('upgrade', (req, socket) => {
        if (socket.destroyed) return;
        if (!isGuardedUpgrade(req.url)) return;
        const refusal = apiRefusal(req);
        if (!refusal) return;
        socket.write(
          `HTTP/1.1 ${refusal.status} ${STATUS_CODES[refusal.status]}\r\n` +
          'Connection: close\r\n\r\n',
        );
        socket.destroy();
      });
    },
  };
}
