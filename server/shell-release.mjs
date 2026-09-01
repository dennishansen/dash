// The DEPLOYED dash shell — a released static build of the dash UI, served by
// the edge under /dash/.
//
// Why the dash stopped being hot code. The dash Dennis uses all day was served
// by `vite dev` out of the machine's main checkout, so main's every merge was
// also a deploy: a source change under dash/ hot-reloaded (or full-reloaded)
// the UI he was mid-sentence in, and a dependency change made the optimizer
// 504 the page it had already handed him. Nothing about the dash asks for
// that. It is a product, used by a person, on a machine that also happens to
// build it — so it gets normal web semantics: a BUILT bundle, swapped only by
// an explicit deploy, picked up only on refresh.
//
// The CONTENTS stay live. Chats are PTYs in the supervisor and App-pane
// previews are worktree dev servers; both keep running the box's current main.
// Only the shell — the HTML/JS/CSS a browser downloads — is a release.
//
// The store is machine state, beside the other machine-local dash state in
// ~/.claude: one directory per release, a `current` symlink naming the served
// one. Publishing is a rename onto that symlink, which is atomic — a request
// either sees the whole old release or the whole new one. Older releases are
// RETAINED, not deleted, because a tab opened before the swap will still ask
// for its own hashed chunks afterwards (the dash lazy-loads the code browser);
// serving those from the release they belong to is what makes a mid-session
// deploy invisible instead of a broken lazy import.
//
// See docs/cloud-dev-box.md § Deploying the dash shell.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { isDashDocumentPath, DASH_BASENAME } from '../src/routes.mjs';

// How many releases stay on disk. The current one plus enough history that a
// tab left open across a couple of deploys still resolves its chunks.
const RETAIN = 4;

// The build's own output directory, and therefore the one path segment under
// /dash/ that a release may answer for besides its document and manifest. Vite's
// default; if vite.dash.config.js ever sets build.assetsDir, this follows it.
const ASSETS = 'assets';

// WHERE RELEASES LIVE. Machine state, so it sits with the chat registry and the
// supervisor log rather than in the checkout — a deploy must not leave the
// working tree dirty. LAB_DASH_RELEASES_DIR is the run-owned override every
// test run already gets (scripts/lib/test-run-env.mjs): a harness-spawned edge
// therefore starts with NO release and serves the branch's dev shell, which is
// the only thing a test on a branch can honestly be testing.
export function releasesDir() {
  return process.env.LAB_DASH_RELEASES_DIR || path.join(os.homedir(), '.claude', 'dash-releases');
}
export function currentLink() { return path.join(releasesDir(), 'current'); }

// The releases on disk, newest first. Ids are timestamp-prefixed, so name order
// IS chronological order.
export function releaseIds() {
  let entries;
  try { entries = fs.readdirSync(releasesDir(), { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'current')
    .map((e) => e.name)
    .sort()
    .reverse();
}

export function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'release.json'), 'utf8')); }
  catch { return null; }
}

// The release the edge is serving right now, resolved per request: a deploy is
// picked up by the running edge without a restart, and a rollback the same way.
// One readlink is cheaper than the stat the static serve does anyway.
export function currentRelease() {
  let id;
  try { id = path.basename(fs.readlinkSync(currentLink())); } catch { return null; }
  const dir = path.join(releasesDir(), id);
  if (!fs.existsSync(path.join(dir, 'index.html'))) return null;
  return { id, dir, manifest: readManifest(dir) };
}

// Which shell does this vite serve? A machine with a deployment serves it —
// that is what deploying means — and a machine without one (every laptop,
// every test run) serves the dev shell with no configuration at all. DASH_SHELL
// is the operator's override in both directions: `dev` to work on the dash UI
// live on a box that has a deployment, `release` to state that this edge must
// serve one and say so loudly rather than silently falling back to source.
export function shellMode(release = currentRelease()) {
  const stated = (process.env.DASH_SHELL || '').trim().toLowerCase();
  if (stated === 'dev' || stated === 'release') return stated;
  return release ? 'release' : 'dev';
}

// Publish a staged build directory as the current release. Two renames: the
// staged tree becomes the release (so a half-written build is never named one),
// then a fresh symlink is renamed ONTO `current`, which is atomic — there is no
// instant where `current` is missing or points at a partial tree.
export function publishRelease(stagedDir, manifest) {
  assertBootable(stagedDir);
  const dir = path.join(releasesDir(), manifest.id);
  fs.mkdirSync(releasesDir(), { recursive: true });
  fs.writeFileSync(path.join(stagedDir, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(stagedDir, dir);
  pointCurrentAt(manifest.id);
  return dir;
}

// THE ONE THING A BUILT SHELL CAN GET WRONG that no amount of serving can fix.
// The dash routes on real paths, so this same index.html is served at
// /dash/issues/<id> as well as at /dash/ — and a RELATIVE reference in it
// resolves against the ROUTE, not the app. `./assets/x.js` becomes
// /dash/issues/assets/x.js, the module 404s, and the shell never boots: a blank
// page on every deep link, while the board itself looks fine (one segment
// happens to resolve). It shipped exactly once, from a build rooted at dash/
// whose entry had been made relative to please that rooting, and every
// fixture-based test passed because the fixtures were absolute. So the store
// refuses to publish it, where the mistake is still cheap.
export function assertBootable(dir) {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const relative = [...html.matchAll(/\b(?:src|href)\s*=\s*"(?!https?:|data:|\/|#|mailto:)([^"]*)"/g)]
    .map((m) => m[1]).filter(Boolean);
  if (relative.length) {
    throw new Error(
      `this shell would not boot on a deep link: index.html references ${relative.join(', ')} `
      + 'relative to the document, and the dash serves that document at /dash/issues/<id> too. '
      + 'Every reference must be root-absolute.');
  }
}

export function pointCurrentAt(id) {
  const link = currentLink();
  const tmp = `${link}.swap-${process.pid}`;
  try { fs.unlinkSync(tmp); } catch {}
  fs.symlinkSync(id, tmp);
  fs.renameSync(tmp, link);   // atomic over the existing symlink
}

// Drop everything older than the retained window. Never the current release,
// whatever its age — a rollback pins an old id and must not be swept.
export function pruneReleases(keep = RETAIN) {
  const current = currentRelease()?.id || null;
  const doomed = releaseIds().slice(keep).filter((id) => id !== current);
  for (const id of doomed) fs.rmSync(path.join(releasesDir(), id), { recursive: true, force: true });
  return doomed;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

// Resolve a /dash/<rest> request to a file inside `dir`, or null. Traversal is
// refused by construction: the resolved path must still be under the release.
function fileIn(dir, rest) {
  let decoded;
  try { decoded = decodeURIComponent(rest); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const full = path.resolve(dir, `.${decoded.startsWith('/') ? '' : '/'}${decoded}`);
  if (full !== dir && !full.startsWith(dir + path.sep)) return null;
  try { return fs.statSync(full).isFile() ? full : null; } catch { return null; }
}

function sendFile(res, file, cache) {
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': cache,
  });
  res.end(body);
}

// The plugin: serve /dash/* from the deployed release instead of transforming
// the checkout's source. Registered on the operator EDGE only; worktree hosts
// deliberately omit it and transform their own dash source for App previews.
export function dashShell() {
  const use = (server) => {
    const mode = shellMode();
    const release = currentRelease();
    if (mode === 'release' && release) {
      const m = release.manifest || {};
      console.log(`  dash shell: release ${release.id} (${m.commit || 'unknown'}${m.dirty ? '-dirty' : ''}) — deploy with \`npm run dash:deploy\``);
    } else if (mode === 'release') {
      console.log('  dash shell: RELEASE mode, but no release is deployed — /dash/ will say so. Run `npm run dash:deploy`.');
    } else {
      console.log(`  dash shell: dev (vite transforms dash/src)${release ? `, overriding deployed release ${release.id}` : ''}`);
    }

    server.middlewares.use((req, res, next) => {
      // Resolved per request — one readlink — so a deploy or a rollback lands
      // on the very next load with nothing restarted.
      const current = currentRelease();
      if (shellMode(current) !== 'release') return next();
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      const [pathname] = (req.url || '/').split('?');
      if (pathname !== DASH_BASENAME && !pathname.startsWith(`${DASH_BASENAME}/`)) return next();
      // The gif corpus is the SUPERVISOR's surface, relayed by the edge; it is
      // machine content, not part of any bundle.
      if (pathname.startsWith(`${DASH_BASENAME}/gifs/`)) return next();

      if (!current) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('No dash release is deployed on this machine.\n\nDeploy one:  npm run dash:deploy\nOr serve the dev shell:  DASH_SHELL=dev\n');
        return;
      }

      // A document path gets the shell's index.html, never cached — the whole
      // point of a refresh is that it picks up the new deploy.
      const rest = pathname === DASH_BASENAME ? '/' : pathname.slice(DASH_BASENAME.length);
      if (rest === '/' || rest === '/index.html' || isDashDocumentPath(pathname)) {
        sendFile(res, path.join(current.dir, 'index.html'), 'no-store');
        return;
      }

      // WHAT A RELEASE OWNS, and nothing else. `/dash/` is not exclusively the
      // shell's URL space and assuming it was is what turned the App pane
      // black: the CANVAS imports the shared sign-in door as a browser module
      // (`src/access/access.js` → `../../dash/server/supabase-otp.mjs`), which
      // vite serves at /dash/server/supabase-otp.mjs. A blanket 404 for
      // everything the bundle lacked took the canvas down with it — and a
      // failed dynamic import never retries, so it stayed down.
      //
      // So the rule is a NAMESPACE, not a prefix: the document, the manifest,
      // and the build's own hashed `assets/` tree are the release's; every
      // other path under /dash/ belongs to whoever served it before this plugin
      // existed (the supervisor's gifs, vite's modules) and is handed straight
      // back to them.
      if (!rest.startsWith(`/${ASSETS}/`) && rest !== '/release.json') return next();

      // Hashed assets are immutable. A tab that loaded BEFORE this deploy still
      // asks for its own chunk names, so a miss falls back through the retained
      // releases — the deploy stays invisible to an open tab instead of
      // breaking its next lazy import.
      let file = fileIn(current.dir, rest);
      if (!file) {
        for (const id of releaseIds()) {
          if (id === current.id) continue;
          file = fileIn(path.join(releasesDir(), id), rest);
          if (file) break;
        }
      }
      // Inside the namespace we DO own, a miss is a miss. Falling through here
      // would hand a missing chunk to vite's SPA fallback, which answers with
      // the canvas's HTML — a module import of an HTML page, which fails in a
      // way that names nothing.
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`Not in the deployed dash shell: ${pathname}\n`);
        return;
      }
      // Only assets/ is content-hashed, so only assets/ may claim immutability.
      // Anything else the build emits at the release root (release.json today,
      // a favicon or a manifest tomorrow) keeps its NAME across deploys — a
      // year-long cache on one of those is a file that can never be replaced.
      sendFile(res, file, rest.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store');
    });
  };
  return { name: 'dash-shell', configureServer: use, configurePreviewServer: use };
}
