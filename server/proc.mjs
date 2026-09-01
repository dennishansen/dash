// Async child-process runner for the dash server. The whole dash — PTY↔browser
// keystroke relay, board API, git/worktree actions — shares ONE Node event
// loop, so a spawnSync/execSync anywhere in a request or action handler
// freezes every attached terminal for the child's lifetime. Every handler-path
// subprocess goes through run() instead: the child does its work off-loop and
// the handler just awaits the result. spawnSync remains legitimate ONLY for
// true one-shots resolved once per process (module init / cached lookups).
import { spawn } from 'child_process';

// Run `cmd args` to completion without blocking the event loop.
// Resolves { status, stdout, stderr, error } — never rejects (a spawn failure
// resolves with status null + error, mirroring spawnSync's shape).
// `binary: true` yields stdout as a Buffer instead of a utf8 string;
// `env` overlays variables onto the parent environment (e.g. GIT_INDEX_FILE, to
// stage a tree without disturbing the real index).
//
// One command, one process. A REPEATED question — the same program asked over
// and over on a request path — should not come here at all: fork+exec is the
// expensive part (0.8-2.0s on a loaded machine, whatever the program does), so
// the answer is a process kept open and spoken to, not a faster way to start
// one. git-objects.mjs is that shape for the object store.
export function run(cmd, args, { binary = false, env = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
    } catch (error) {
      resolve({ status: null, stdout: binary ? Buffer.alloc(0) : '', stderr: '', error });
      return;
    }
    const out = [];
    const err = [];
    let settled = false;
    const settle = (status, error) => {
      if (settled) return;
      settled = true;
      resolve({
        status,
        stdout: binary ? Buffer.concat(out) : Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        error,
      });
    };
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => settle(null, e));
    child.on('close', (code) => settle(code));
  });
}
