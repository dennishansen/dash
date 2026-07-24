// Reaper sweep — the dash server reaping idle chats + stale dev servers on its
// own, so running this project needs no cron or per-machine setup: start the
// dash and it keeps the fleet trimmed.
//
// Runs in ONE server per machine — the caller gates it to the MAIN checkout (not
// worktree dashes), which also means the sweeper lives on the main port, outside
// the 5200-5299 dev-server range, so it can never reap its own server.
//
// Deliberately all-async (Supabase reads + ps/lsof via execFile + freePort) and
// infrequent. The dash once had a background watcher removed for blocking the
// event loop on sync git — this must not repeat that, so every step here is
// non-blocking and a reap that throws is swallowed: housekeeping must never take
// the dev server down.
import { reap, reapAuthority } from './idle-reaper.mjs';

const SWEEP_MS = 5 * 60 * 1000;
const START_DELAY_MS = 15 * 1000; // let the server finish booting before the first reap

let started = false;
export function startReaperSweep() {
  if (started) return; // once per process
  started = true;
  // A server on a cloned board may not reap (see idle-reaper's reapAuthority).
  // reap() would refuse anyway — arming nothing is the same outcome said once at
  // boot, where it's diagnosable, instead of silently every five minutes.
  const authority = reapAuthority();
  if (!authority.ok) {
    console.log(`reaper sweep disabled: ${authority.reason}`);
    return;
  }
  const safe = async () => { try { await reap(); } catch {} };
  // Reap shortly after boot — clears whatever a previous (or crashed) run left
  // behind — then on a steady interval.
  setTimeout(safe, START_DELAY_MS).unref?.();
  setInterval(safe, SWEEP_MS).unref?.();
}
