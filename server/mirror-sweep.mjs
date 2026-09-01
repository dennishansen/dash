// The push half of chat sync — this machine's dash mirroring the chats it holds
// up to the shared corpus, so the rest of the team can read them.
//
// DIRECTION IS THE WHOLE DESIGN. The owner's dash holds an outgoing connection
// and pushes; nothing ever reaches in. No inbound reachability, no port
// forwarding, no peer discovery, and a machine that is asleep simply has nothing
// in flight. Local stays primary — the agent writes to its own disk and keeps
// working offline; this is a copy of that record, and losing it costs nothing
// but freshness.
//
// WHAT THIS MACHINE IS RESPONSIBLE FOR, exactly:
//   • chats the board says were created HERE (the per-chat ownership stamp on
//     the issue row records the host — i-a03f7f). Not "chats whose transcript I
//     happen to have": one machine per chat, so two dashes can never race to
//     mirror the same conversation.
//   • the main chats in this checkout's local list, which are machine-local by
//     definition.
//   • every Cursor conversation whose folder is this checkout or one of its
//     worktrees — Cursor records no issue, so its folder is what places it.
//
// COST DISCIPLINE. The dash shares ONE event loop with every attached terminal,
// so this is all-async and gated: a chat is re-read only when its source has
// actually moved (a file mtime, a conversation's own updated stamp), and a tick
// where nothing changed costs one stat per chat. A push that throws is
// swallowed — mirroring is housekeeping and must never take the dev server down.

import fs from 'fs';
import { MAIN_ENV, workspaceForDir, workspaceIssueMap } from './workspace-env.mjs';
import { parseHandle, findTranscriptAny, readTurnsAny, discoverChatsAny } from './agents.mjs';
import { mainChatsList, mainChatMeta } from './main-chats-store.mjs';
import { upsertChat, pushTurns, cursorsFor } from './chat-mirror.mjs';

const SWEEP_MS = 20 * 1000;
const START_DELAY_MS = 8 * 1000; // let the supervisor finish booting before the first push

// Where each chat's transcript is, memoized. A transcript's path is immutable
// once written, and finding one is a scan of every project directory — so
// looking it up once per process (rather than once per tick) is what keeps the
// steady-state cost at one stat per chat. Same reasoning as codex's rollout-path
// cache in agents.mjs.
const pathCache = new Map(); // sessionId → transcript path

// The last source-change stamp we pushed for a chat. A chat whose source has not
// moved since is skipped entirely — no read, no request.
const seen = new Map(); // sessionId → change stamp (epoch ms)

// When a chat's source last changed, epoch ms, or null if it isn't here.
// A conversation that carried its own stamp from discovery uses that; anything
// file-backed is the transcript's mtime, which is the same fact one layer down.
async function changedAt(candidate) {
  if (candidate.changedAt != null) return candidate.changedAt;
  let p = pathCache.get(candidate.sessionId);
  if (!p) {
    const found = await findTranscriptAny(candidate.sessionId);
    if (!found) return null;
    p = found.transcriptPath;
    pathCache.set(candidate.sessionId, p);
  }
  try { return (await fs.promises.stat(p)).mtimeMs; } catch { pathCache.delete(candidate.sessionId); return null; }
}

// Every chat this machine is responsible for mirroring, as
// [{ sessionId, env, agent, owner, host, title, changedAt? }].
export async function mirrorCandidates() {
  const { machineName, operatorEmail } = await import('./operator.mjs');
  const host = machineName();
  const me = await operatorEmail().catch(() => null);
  const out = [];
  const claimed = new Set();
  const add = (c) => { if (!claimed.has(c.sessionId)) { claimed.add(c.sessionId); out.push(c); } };
  // Workspace folder name → the canonical issue id the BOARD keys by. The folder
  // (the key) is the issue id for an issue-named worktree, the branch for a
  // branch-named one, and a name in neither is a workspace with no card; the
  // value is always the issue id. The reaper resolves its own stand-down off this
  // same map — see workspaceIssueMap.
  let envOf = new Map([[MAIN_ENV, MAIN_ENV]]);

  // 1. Issue chats stamped as created on THIS machine. The stamp is what makes
  //    ownership a fact rather than an inference — a teammate's chat is their
  //    dash's job even when its transcript somehow exists here too.
  try {
    const { listAll, readChatMeta } = await import('./issues-store.mjs');
    const rows = await listAll();
    envOf = workspaceIssueMap(rows);
    for (const row of rows) {
      const meta = readChatMeta(row);
      for (const handle of row.conversations || []) {
        const { sessionId, agent } = parseHandle(handle);
        const m = meta[sessionId] || {};
        if (m.host !== host) continue;
        add({ sessionId, env: row.id, agent, owner: m.owner || null, host, title: m.name || null });
      }
    }
  } catch (e) {
    console.error('[chat-mirror] could not read the board:', e.message);
  }

  // 2. Main chats — this checkout's own list, machine-local by construction, so
  //    every entry is ours with nothing to check.
  const meta = mainChatMeta();
  for (const handle of mainChatsList()) {
    const { sessionId, agent } = parseHandle(handle);
    add({ sessionId, env: MAIN_ENV, agent, owner: me, host, title: meta[sessionId]?.name || null });
  }

  // 3. Cursor conversations, placed by their folder. A conversation outside
  //    this checkout belongs to another project and is skipped. One inside a
  //    workspace the board has no card for (a worktree whose issue was renamed,
  //    rejected, or never filed) is UNFILED work, not unmirrorable work — it
  //    lands in the main feed, the home of everything no card claims. Env is
  //    just a column: if a card for that branch appears later, the next sweep
  //    computes the real env and the merge re-homes the chat onto it.
  for (const c of await discoverChatsAny()) {
    const workspace = workspaceForDir(c.dir);
    if (!workspace) continue;
    const env = envOf.get(workspace) || MAIN_ENV;
    add({ sessionId: c.sessionId, env, agent: c.agent, owner: me, host, title: c.title, changedAt: c.updatedAt });
  }
  return out;
}

// One pass: push whatever has changed. Resolves { chats, pushed } — how many
// chats were considered and how many turns actually moved — so the HTTP trigger
// and the tests can both see what a sweep did.
export async function mirrorSweep() {
  const candidates = await mirrorCandidates();
  if (!candidates.length) return { chats: 0, pushed: 0 };

  // Work out what actually moved BEFORE asking the corpus anything: a tick where
  // nothing changed should cost stats and no round-trip at all.
  const moved = [];
  for (const c of candidates) {
    const stamp = await changedAt(c);
    if (stamp == null) continue; // not on this machine (yet) — nothing to read
    if (seen.get(c.sessionId) === stamp) continue;
    moved.push({ ...c, stamp });
  }
  if (!moved.length) return { chats: candidates.length, pushed: 0 };

  const cursors = await cursorsFor(moved.map(c => c.sessionId));
  let pushed = 0;
  for (const c of moved) {
    // A chat that keeps failing to push must not be re-read every 20s forever —
    // that retry-without-backoff loop (readTurnsAny re-reading Cursor's 1.1GB
    // store per attempt) was half of the 2026-07-30 subprocess storm. Failures
    // back off exponentially per chat, capped at an hour; any success resets.
    const b = backoff.get(c.sessionId);
    if (b && Date.now() < b.nextTryAt) continue;
    try {
      const after = cursors.get(c.sessionId) ?? 0;
      const t = await readTurnsAny(c.sessionId, after);
      if (!t) continue;
      // The chat's row goes up even when it has said nothing new: existing but
      // silent is a real state, and a reader should see the chat rather than
      // wonder whether it failed to sync. `agent` comes from the adapter that
      // ACTUALLY held the chat, not from the handle prefix — one writer per
      // field, so the row cannot end up describing an agent it isn't.
      await upsertChat({ ...c, agent: t.agent });
      const r = await pushTurns(c.sessionId, t.messages, { cursor: t.cursor });
      pushed += r.pushed;
      // Only remember the stamp once the push has landed, so a failed push is
      // retried (with backoff) rather than skipped forever.
      seen.set(c.sessionId, c.stamp);
      backoff.delete(c.sessionId);
    } catch (e) {
      const fails = (b?.fails ?? 0) + 1;
      const delay = Math.min(60 * 60 * 1000, SWEEP_MS * 2 ** fails);
      backoff.set(c.sessionId, { fails, nextTryAt: Date.now() + delay });
      console.error(`[chat-mirror] ${c.sessionId.slice(0, 8)} did not sync (attempt ${fails}, retry in ${Math.round(delay / 1000)}s):`, e.message);
    }
  }
  return { chats: candidates.length, pushed };
}

// Per-chat failure backoff: sessionId → { fails, nextTryAt }.
const backoff = new Map();

let started = false;
export function startMirrorSweep() {
  if (started) return; // once per process
  started = true;
  // One mirror per machine by construction — this runs in the supervisor
  // alone, so the per-clone lease election is gone. The forced pass
  // (POST /api/dash/terminal/mirror → mirrorSweep) bypasses the in-flight
  // guard on purpose: an explicit request should always run.
  let inFlight = false;
  const safe = async () => {
    if (inFlight) return; // ticks never overlap — overlapping sweeps were the other half of the storm
    inFlight = true;
    try { await mirrorSweep(); }
    catch (e) { console.error('[chat-mirror] sweep failed:', e.message); }
    finally { inFlight = false; }
  };
  setTimeout(safe, START_DELAY_MS).unref?.();
  setInterval(safe, SWEEP_MS).unref?.();
}
