// The WORKTREE fleet — the reaper's third fleet, alongside chats and dev servers.
//
// Teardown is not an event that happens at merge time; it is a STATE a workspace
// enters. The moment its issue leaves in-progress the workspace is RETIRED, and
// it sits there, fully alive, until the reaper collects it — on exactly the idle
// evidence the chat fleet already uses. A chat that is still working keeps its
// directory, its preview and its port for as long as it keeps working. `/merge`
// and `/reject` therefore land the work and walk away; nothing they do can pull
// the ground out from under a chat that is mid-receipt.
//
// Collection has two depths, and git — never a guess — decides which:
//
//   collect  the port reservation goes (and with it, via freePort, whatever
//            still listens on it). Always safe: the dash respawns a dev server
//            on demand the next time anyone opens that issue's app tab.
//   remove   the directory and the branch go too. Only when the tree is CLEAN
//            and the branch is either merged into the trunk or preserved under
//            its `rejected/<branch>` gravestone tag. Anything else — a dirty
//            tree, an unmerged branch, a detached head — keeps the directory
//            forever, and says why. A worktree is the only copy of uncommitted
//            work; the reaper is never the thing that loses it.
//
// The removal itself runs plain `git worktree remove` / `git branch -d`, never
// `--force`, so git stays the final authority and the pre-checks below are an
// optimisation and an explanation, not the safety.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { MAIN_REPO, MAIN_ENV, workspaceIssueMap, workspaceForDir, parseWorktreeList } from './workspace-env.mjs';
import { freePort } from './ports.mjs';

const pExec = promisify(execFile);

function gitIn(dir, args) {
  return new Promise((resolve) => {
    const p = spawn('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => resolve({ ok: false, out: '', err: e.message }));
    p.on('close', (code) => resolve({ ok: code === 0, out, err: err.trim() }));
  });
}
const git = (args) => gitIn(MAIN_REPO, args);
const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);

// The trunk every "is this merged?" question is asked against. Resolved from git
// rather than assumed, the same order ensureWorktree branches from.
async function trunkRef() {
  for (const ref of ['main', 'master']) {
    if ((await git(['rev-parse', '--verify', '--quiet', ref])).ok) return ref;
  }
  return null;
}

// --- the fleet ---------------------------------------------------------------
// Every worktree workspace this checkout owns: the folder NAME (the key every
// other surface holds it by — see workspaceForDir), its directory, and the
// branch it has checked out (null when detached). Filtered to the worktrees
// directory, so the throwaway detached worktrees other scripts make under /tmp
// are out of scope.
//
// Async on purpose. This runs on the reaper's five-minute sweep inside the dash
// server's single event loop — the same loop that relays terminal keystrokes —
// and a spawnSync over dozens of worktrees is exactly the freeze the dash
// already paid for once (dash/no-sync-ps.test.mjs).
export async function listWorkspaces() {
  const { out } = await git(['worktree', 'list', '--porcelain']);
  return parseWorktreeList(out)
    .map(({ dir, branch }) => ({ workspace: dir ? workspaceForDir(dir) : null, dir, branch: branch || null }))
    .filter(({ workspace, dir }) => dir && workspace && workspace !== MAIN_ENV);
}

// --- the pure verdict --------------------------------------------------------
// One row per worktree with everything the decision rested on. Pure so the rule
// is readable and testable without git or Supabase (dash/merge-teardown.test.mjs).
//
//   retired  its issue is no longer in-progress — or it has no board row at all
//   quiet    no chat inside it is still working (`busy`, from the CHAT fleet's
//            own verdicts, is the single shared definition of "still working")
//   self     the workspace this very process is running in — never collected,
//            because deleting our own cwd is suicide. A reaper whose own issue
//            retires stands down instead (reaper-sweep), so a healthy successor
//            collects it like any other.
//
// `safety` carries the git facts, probed only for the rows worth probing (see
// probeSafety). A row with no entry is honestly reported as unprobed: collected,
// never removed.
export function worktreeVerdicts({
  worktrees, rows = [], busy = new Map(), safety = new Map(), selfWorkspace = null, authOk = true,
}) {
  const issueBy = workspaceIssueMap(rows);
  const statusById = new Map(rows.map((r) => [r.id, r.status]));
  return worktrees.map(({ workspace, dir, branch }) => {
    // EVERY issue that claims this workspace, not just the first. A branch is
    // often linked to a long-lived umbrella issue as well as the attempt on it
    // (`/reject` warns about exactly this), and `workspaceIssueMap` answers
    // first-match — which is the right answer for "whose card is this" and the
    // wrong one for "may I delete this directory". Retirement is unanimous: one
    // in-progress claimant keeps the whole workspace.
    const claimants = rows.filter((r) => r.id === workspace || (r.branches || []).includes(workspace));
    const issue = issueBy.get(workspace) ?? null;
    const status = issue ? (statusById.get(issue) ?? 'unknown') : null;
    const live = claimants.filter((r) => r.status === 'in-progress');
    const retired = live.length === 0;
    const holders = busy.get(workspace) || [];
    const self = workspace === selfWorkspace;

    const keepReasons = [];
    if (!authOk) keepReasons.push('board may not reap');
    if (self) keepReasons.push('our own workspace');
    for (const r of live) keepReasons.push(r.id === issue ? 'issue in-progress' : `${r.id} in-progress`);
    keepReasons.push(...holders);
    const collect = keepReasons.length === 0;

    // Removal needs a POSITIVE answer on both halves. `clean` is deliberately
    // tri-state: `null` means probeSafety never asked, because the branch half
    // had already ruled removal out — so it must block, not read as clean.
    const facts = safety.get(workspace) || null;
    const removeBlockers = [];
    if (!facts) removeBlockers.push('not probed');
    else {
      if (!branch) removeBlockers.push('detached head — no branch to answer for it');
      else if (!facts.merged && !facts.gravestoned) removeBlockers.push(`branch "${branch}" is not merged and has no rejected/ tag`);
      if (facts.clean === false) removeBlockers.push('uncommitted changes');
      else if (facts.clean !== true && !removeBlockers.length) removeBlockers.push('working tree not probed');
    }
    return {
      workspace, dir, branch, issue, status, retired, self,
      claimants: claimants.map((r) => r.id),
      quiet: holders.length === 0,
      merged: facts?.merged ?? false,
      gravestoned: facts?.gravestoned ?? false,
      tip: facts?.tip ?? null,
      collect,
      keepReasons,
      remove: collect && removeBlockers.length === 0,
      removeBlockers,
    };
  });
}

// --- the git facts -----------------------------------------------------------
// Probed ONLY for the workspaces a caller already decided are worth probing, and
// then in two tiers, cheapest first:
//
//   branch    THREE whole-repo reads, however many candidates there are: which
//             branches are merged into the trunk, every branch tip, every
//             `rejected/` gravestone.
//   clean     one `git status` PER worktree — it refreshes that worktree's index
//             on disk, and a box can hold dozens. So it runs only where the
//             branch tier already said removal is possible. Everywhere else
//             `clean` stays null: not asked, and never mistaken for a yes.
//
// It is safe to touch a candidate's index at all only because a candidate is by
// construction retired AND quiet — nobody is working in there.
export async function probeSafety(candidates) {
  const safety = new Map();
  if (!candidates.length) return safety;
  const trunk = await trunkRef();
  const [mergedOut, headsOut, gravesOut] = await Promise.all([
    trunk ? git(['branch', '--merged', trunk, '--format=%(refname:short)']) : { out: '' },
    git(['for-each-ref', 'refs/heads', '--format=%(refname:short) %(objectname)']),
    git(['for-each-ref', 'refs/tags/rejected', '--format=%(refname:short) %(objectname) %(*objectname)']),
  ]);
  const merged = new Set(lines(mergedOut.out));
  const tips = new Map(lines(headsOut.out).map((l) => l.split(/\s+/)).map(([ref, sha]) => [ref, sha]));
  const graves = new Map(lines(gravesOut.out).map((l) => l.split(/\s+/)).map(([ref, sha, deref]) => [ref, deref || sha]));

  await Promise.all(candidates.map(async ({ workspace, dir, branch }) => {
    // A gravestone counts only while it still points AT the branch tip: commits
    // made after `/reject` tagged it are not preserved by that tag, and a branch
    // carrying unpreserved work is not the reaper's to delete. Both sides must
    // EXIST — two missing refs comparing equal as `undefined` would read a
    // vanished branch as gravestoned and license deleting its worktree.
    const grave = branch ? graves.get(`rejected/${branch}`) : null;
    const tip = branch ? tips.get(branch) : null;
    const facts = {
      merged: !!branch && merged.has(branch),
      gravestoned: !!grave && !!tip && grave === tip,
      // The tip we JUDGED. Carried so the deletion can be a compare-and-swap
      // against it rather than an unconditional -D — see collectWorkspace.
      tip: tip ?? null,
      clean: null,
    };
    if (facts.merged || facts.gravestoned) {
      const st = await gitIn(dir, ['status', '--porcelain']);
      facts.clean = st.ok && st.out.trim() === '';
    }
    safety.set(workspace, facts);
  }));
  return safety;
}

// --- is anyone standing here? ------------------------------------------------
// Every directory that is some live process's cwd, read straight from the
// kernel. One lsof over the whole machine (~0.7s), and it runs only when a
// removal is actually on the table.
//
// This is the LAST-MOMENT re-check that makes the planning contract safe. The
// plan says a workspace is free once the chat holding it is reaped — but a chat's
// processes are not guaranteed to die with it: endChat goes through node-pty's
// kill(), which signals the PTY child alone and not its process group, so a
// descendant that called setsid outlives the chat, and if it is not agent-named
// no later sweep can even see it. Planning cannot know that; only the moment
// before `git worktree remove` can. So the plan stays optimistic and prompt, and
// the deletion re-asks the kernel.
//
// It costs nothing in the ordinary case: if the reaped chat really did take its
// processes with it, the check passes in the very same sweep. Only a genuine
// survivor blocks a removal, and it blocks exactly the one directory it is
// standing in.
//
// NULL means UNKNOWN, and the caller must treat it as "blocked", never as
// "nobody is there". This is the LAST gate before a directory is deleted, so it
// is the one place in this file where an unreadable answer is the dangerous one:
// swallowing a failed lsof into an empty Set reads as an all-clear and removes
// the worktree out from under whatever was standing in it. Failing closed costs
// one deferred collection; failing open costs somebody's working directory.
//
// Turning the raw read into that answer is a PURE function so every failure
// shape is testable without breaking lsof on the machine.
//
// ANY error is UNKNOWN — deliberately, and this is the second thing that had to
// be unlearned here. `cwdByPid` in idle-reaper.mjs documents that lsof "exits
// non-zero when any listed pid has already gone; it still prints the rest", and
// that is true — of a SEARCH: `lsof -p <pidlist>` reports a missing search item
// with exit 1 while faithfully printing everything it did find. This call names
// no search items at all. It is an ENUMERATION, so lsof has nothing to fail to
// find, and a successful walk exits 0 — measured on this machine, 5 runs while
// processes churned, exit 0 every time (the search form, asked for a dead pid,
// exits 1 as documented). Upstream says a generic non-search execution error is
// exit 1.
//
// So for THIS invocation a non-zero exit means lsof enumerated some processes
// and then failed, and the rows it printed are a PARTIAL table — which is the
// dangerous shape, because the process still standing in the workspace may be
// one of the ones it never reached. Rows prove the read started, not that it
// finished. Carrying the search-form's tolerance over to an enumeration was
// exactly the kind of borrowed rationale that reads plausible and is not true.
export function cwdsFromLsof(stdout, error = null) {
  if (error) return null;
  const out = new Set();
  for (const line of String(stdout || '').split('\n')) if (line[0] === 'n') out.add(line.slice(1));
  // A complete read can never be empty: the process doing the reading is itself
  // standing somewhere. Zero rows therefore means the read did not work, whatever
  // the exit code said — a provable floor, not a guess at a plausible minimum.
  return out.size ? out : null;
}

export async function liveCwds() {
  try {
    const { stdout } = await pExec('lsof', ['-d', 'cwd', '-Fn'], { maxBuffer: 64 * 1024 * 1024 });
    return cwdsFromLsof(stdout, null);
  } catch (e) {
    return cwdsFromLsof(e?.stdout, e);
  }
}

// Is `dir` — or anything beneath it — some live process's cwd? Callers hand this
// a Set they have already checked is non-null; UNKNOWN is the caller's decision
// to make, not a value to conflate with "free".
export function occupiedBy(dir, cwds) {
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  for (const c of cwds) if (c === dir || c.startsWith(prefix)) return c;
  return null;
}

// --- the act -----------------------------------------------------------------
// Collect one workspace. Order matters: release the port FIRST (freePort tears
// down whatever still listens, so no dev server is left holding a cwd that is
// about to vanish), then the directory, then the branch. Idempotent and
// non-fatal throughout — anything git refuses is reported, never forced.
//
// Both branch deletions re-check their own precondition AT DELETE TIME, because
// probeSafety's verdict is a snapshot and a commit can land between the two:
//   merged      `git branch -d`, which re-verifies merged-ness itself and
//               refuses a branch that has moved.
//   gravestoned `git update-ref -d refs/heads/<b> <tip>` — an atomic
//               compare-and-delete against the exact sha the gravestone was
//               judged equal to. `-D` would have deleted a commit made after the
//               probe, which the tag does NOT preserve: permanent work loss
//               through a window of milliseconds. There is no version of this
//               worth being fast about.
export async function collectWorkspace(row, cwds = undefined) {
  const out = { workspace: row.workspace, port: null, removed: false, branchDeleted: false, errors: [] };
  if (row.issue) {
    const r = await freePort(row.issue);
    // A port that refused to release means something we could not stop is still
    // listening — and its cwd is this directory. Removing the ground under a
    // process we failed to kill is the exact failure this whole change exists to
    // prevent, so the removal is abandoned for this pass and retried next sweep.
    if (r.error) { out.errors.push(r.error); return out; }
    out.port = r.freed;
  }
  if (!row.remove) return out;
  // The same rule as the port, asked of the kernel rather than of the plan: if
  // ANY live process is standing in this directory, it is not ours to delete.
  // `undefined` means the caller has no snapshot and we read our own, so a direct
  // call is exactly as safe as one through collectWorkspaces; `null` means the
  // read FAILED, and an unknown answer blocks the removal like an occupied one.
  const live = cwds === undefined ? await liveCwds() : cwds;
  if (live == null) {
    out.errors.push('could not read live cwds — refusing to remove without knowing who is standing here');
    return out;
  }
  const occupant = occupiedBy(row.dir, live);
  if (occupant) {
    out.errors.push(`still occupied — a live process's cwd is ${occupant}`);
    return out;
  }
  const rm = await git(['worktree', 'remove', row.dir]);
  if (!rm.ok) { out.errors.push(`worktree remove: ${rm.err}`); return out; }
  out.removed = true;
  if (row.branch) {
    const br = row.merged
      ? await git(['branch', '-d', row.branch])
      : row.tip
        ? await git(['update-ref', '-d', `refs/heads/${row.branch}`, row.tip])
        : { ok: false, err: 'no verified tip to delete against' };
    if (br.ok) out.branchDeleted = true;
    else out.errors.push(`branch ${row.branch}: ${br.err || 'moved since it was judged — left in place'}`);
  }
  return out;
}
