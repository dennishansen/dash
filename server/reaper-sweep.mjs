// Reaper sweep — the supervisor reaping idle chats, stale dev servers and
// retired worktrees on its own, so running this project needs no cron or
// per-machine setup: the supervisor keeps the fleet trimmed. This sweep is
// also the ONLY thing that tears a worktree down; `/merge` and `/reject` land
// the work and walk away, so nothing can vanish under a chat that is still
// using it (i-merge-teardown).
//
// It runs in exactly ONE place by construction — the machine's supervisor —
// so the leader-election lease, the self-guard, and the stand-down handoff
// that let N dev servers arbitrate this among themselves are gone with the
// N dev servers. The supervisor is never a reap target: it lives outside the
// 5200-5299 dev-server range and is not tied to any issue's status.
//
// Deliberately all-async (Supabase reads + ps/lsof via execFile + freePort) and
// infrequent. Ticks never overlap: a sweep that outruns the interval skips the
// next tick instead of stacking a second walk of the same fleet on the same
// event loop — overlapping sweeps are how the old per-server world stormed.
// A reap that throws is swallowed: housekeeping must never take the
// supervisor down.
import { reap, reapAuthority } from './idle-reaper.mjs';

const SWEEP_MS = 5 * 60 * 1000;
// The first sweep exists to clear what a previous or crashed run left behind —
// nothing depends on it being prompt. Boot-time chat reconciliation is awaited
// before the supervisor reports ready, so a short delay here is comfort, not a
// race dodge (the old boot-window dance between restore and reaper died with
// per-server restore).
const START_DELAY_MS = 60 * 1000;

let started = false;
export function startReaperSweep() {
  if (started) return; // once per process
  started = true;
  // A supervisor on a cloned board may not reap (see idle-reaper's
  // reapAuthority). `reap()` would refuse anyway — arming nothing is the same
  // outcome said once at boot, where it's diagnosable.
  const authority = reapAuthority();
  if (!authority.ok) {
    console.log(`reaper sweep disabled: ${authority.reason}`);
    return;
  }
  let inFlight = false;
  const safe = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const reaped = await reap();
      // Only speak when it actually reaped something — an idle pass every five
      // minutes would otherwise fill the log with "reaped 0 + 0 + 0".
      if (reaped && (reaped.chats || reaped.servers || reaped.worktrees)) {
        console.log(`reaped ${reaped.chats} chat(s) + ${reaped.servers} dev server(s) + ${reaped.worktrees} worktree(s)`);
      }
    } catch {}
    finally { inFlight = false; }
  };
  setTimeout(safe, START_DELAY_MS).unref?.();
  setInterval(safe, SWEEP_MS).unref?.();
}
