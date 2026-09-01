// A worktree is DERIVED STATE. git holds the branch, the board holds the link,
// and between them a checkout of an issue's work can be built — or REBUILT —
// at any time. The directory on disk is a materialisation of those two facts,
// never the facts themselves.
//
// That is why this module exists as one place rather than as a step inside
// "open a chat": the same act serves three doors that used to be one-way.
//
//   create      an issue is opened for the first time → make its worktree
//   restore     a chat's workspace was collected → make it again, at the exact
//               path the chat recorded. THE PATH IS THE CONTRACT: a chat's home
//               is read from the first cwd-bearing line of its transcript and
//               never changes, so a workspace rebuilt anywhere else leaves the
//               dash calling that chat gone forever — and every absolute path in
//               the conversation would still point at the missing directory.
//   recover     the branch was never merged → the `rejected/<branch>` gravestone
//               that `/reject` left is the base, so the abandoned work comes back
//               with it instead of being silently replaced by main
//
// The reaper (worktree-reaper.mjs) is the other half of the loop: it collects a
// retired workspace once its chats go quiet, and this rebuilds one on demand.
// Neither is a special case of merge or of open — a workspace simply comes and
// goes, and both directions are ordinary.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './proc.mjs';
import { MAIN_ENV, MAIN_REPO, worktreeDir, workspaceForDir } from './workspace-env.mjs';
import { uniqueBranchName } from './branch-name.mjs';

// Run git from the MAIN repo. ASYNC: even "deliberate one-click" actions like
// worktree create run on the same event loop that relays terminal keystrokes —
// a synchronous `git worktree add` measured ~5s of loop block, freezing every
// attached terminal for its duration. Awaiting keeps typing responsive while
// git churns.
export async function git(args) {
  const r = await run('git', ['-C', MAIN_REPO, ...args]);
  return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr.trim() };
}

const isDir = (dir) => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } };

export function hasWorktree(issueId) {
  return isDir(worktreeDir(issueId));
}

export async function branchExists(name) {
  return (await git(['show-ref', '--verify', '--quiet', `refs/heads/${name}`])).ok;
}

// The gravestone `/reject` leaves: `rejected/<branch>`, tagging the tip of work
// that was abandoned rather than landed. It is the RECORD of that work — the
// branch itself is usually deleted afterwards — so it is what a rebuilt
// workspace must be based on, or resurrection would quietly hand back main and
// call it the same worktree.
async function gravestoneFor(branch) {
  const tag = `rejected/${branch}`;
  return (await git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`])).ok ? tag : null;
}

// The trunk to branch from, resolved rather than assumed: local first, then the
// origin refs, and HEAD as the last resort in a repo with neither.
async function trunkRef() {
  for (const ref of ['main', 'master', 'origin/main', 'origin/master']) {
    if ((await git(['rev-parse', '--verify', '--quiet', ref])).ok) return ref;
  }
  return 'HEAD';
}

// Is this branch already checked out by some OTHER worktree? git refuses to
// check one branch out twice, and the obstacle is worth naming rather than
// working around — see the refusal in ensureWorktree.
async function branchCheckedOut(branch) {
  const { out } = await git(['worktree', 'list', '--porcelain']);
  return out.split('\n').some((l) => l === `branch refs/heads/${branch}`);
}

// uniqueBranchName against the repo's real refs. Reads every local branch once
// rather than probing per candidate, so the collision check is one git call.
async function uniqueBranchNameInRepo(issueId, title) {
  const r = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
  const taken = new Set(r.ok ? r.out.split('\n').filter(Boolean) : []);
  return uniqueBranchName(issueId, title, (n) => taken.has(n));
}

// Which branch belongs at a workspace, in the ONE order that keeps identity
// unambiguous. There is a single resolution because there is a single question,
// and two copies of it drift the moment one of them learns something:
//
//   1. the folder's own name, WHEN IT IDENTIFIES SOMETHING — a worktree may be
//      named for its branch rather than its issue (every hand-made one is), so a
//      NON-canonical folder that the row records SELECTS among the branches the
//      link already declares. It selects; it never overrides. The canonical
//      `<issueId>` folder is excluded because it identifies nothing: it is the
//      path every attempt reuses, so its name matching a recorded branch is a
//      coincidence of naming, not evidence about this workspace.
//   2. `identify` + several recorded branches and nothing selected → REFUSE.
//   3. the first branch RECORDED on the row — the link is authoritative, and
//      most-recent-first means this is "the branch this issue is on now".
//   4. a legacy branch named exactly the issue id — the convention every branch
//      made before readable names followed, so adopting it is a fact, not a guess.
//   5. the folder's own name when the row records nothing at all — the only
//      surviving record of what this workspace was, and it only speaks once
//      everything authoritative has been asked. Never for the canonical
//      `<issueId>` folder: inferring a branch from an issue id is precisely what
//      readable names invalidate (rule 4 already covers the legacy case).
//   6. otherwise a fresh readable name derived from the title.
//
// `identify` is the difference between the two acts this serves. CREATING an
// issue's worktree has an answer whatever the row says — the branch it is on now
// (rule 3) — and its directory is DERIVED from the issue id, so the folder is
// not evidence at all there: a row left holding `[readable-current, <issueId>]`
// after the readable-names migration would otherwise check the OLD branch out
// and promote it back to the front of the row. RESTORING a particular chat's
// workspace has to name the attempt THAT CHAT ran in, and a canonical
// `<issueId>` directory is reused across attempts, so with several recorded
// branches and nothing selecting between them there is no deterministic answer.
// The rule then is stop, not pick: choosing "the branch this issue is on now"
// would hand the chat a world where its own work is gone.
async function branchForWorkspace(issueId, dir, row, { identify = false } = {}) {
  const folder = path.basename(dir);
  const recorded = (Array.isArray(row?.branches) ? row.branches : []).filter(Boolean);
  if (identify && folder !== issueId && recorded.includes(folder)) {
    return { branch: folder, source: 'folder' };
  }
  if (identify && recorded.length > 1) {
    return {
      reason: 'ambiguous-branch',
      error: `"${folder}" does not say which of ${issueId}'s branches this workspace held (${recorded.join(', ')}) — rebuilding it would have to guess, and guessing wrong replaces the work the chat came back for`,
    };
  }
  if (recorded.length) return { branch: recorded[0], source: 'row' };
  if (await branchExists(issueId)) return { branch: issueId, source: 'legacy' };
  if (folder !== issueId && (await git(['check-ref-format', '--branch', folder])).ok) {
    return { branch: folder, source: 'folder' };
  }
  // The title's slug, and nothing more, unless that name is already taken — the
  // id only joins to break a real clash. Checked against git here because this is
  // the moment the branch is about to be created.
  return { branch: await uniqueBranchNameInRepo(issueId, row?.title), source: 'new' };
}

// Materialise an issue's worktree, reusing whatever already exists:
//   - dir present                  → reuse (no-op on git)
//   - branch present, no worktree   → `git worktree add <dir> <branch>`
//   - neither                       → `git worktree add <dir> -b <branch> <base>`
//     where <base> is the branch's `rejected/` gravestone if it has one, else
//     the trunk. Rebuilding a rejected issue's workspace hands back the work it
//     was rejected WITH; every other case starts from where the world is now.
//
// `dir` overrides the id-derived path, for restoring a workspace at the exact
// path a chat recorded. Everything else is the same act, which is the point:
// there is no separate "resurrect" code path to drift from "create".
//
// A brand-new branch off the trunk gets an empty wip commit so its tip DIVERGES
// from main — without it a fresh branch reads as "already merged" and `/merge`'s
// `git branch -d` would delete work in progress. That guard is for LIVE work
// only: on a retired card (done/rejected) a wip commit would instead make the
// rebuilt branch permanently unmergeable, and the reaper keeps an unmerged
// branch's directory forever — so resurrection would leak a worktree every time.
// A card that is finished gets a branch that can be collected again.
//
// This operation OWNS the facts it causes. Creating the worktree is what knows
// the branch exists and what marks the issue as being worked on, so it records
// both on the row itself — never by asking a caller (or an agent) to remember a
// board command afterwards. A fact recorded by discipline is right only on the
// runs where someone remembers; recorded here it is right always. The recording
// runs on the REUSE path too, which is what backfills an issue whose worktree
// pre-dates the link.
export async function ensureWorktree(issueId, { dir: explicitDir = null } = {}) {
  const dir = explicitDir || worktreeDir(issueId);
  if (!dir) return { ok: false, error: `invalid issue id "${issueId}"` };
  // An explicit `dir` IS the restore: the caller is naming a workspace some chat
  // ran in, not asking for the issue's own. That is exactly when which branch
  // this directory held has to be identified rather than assumed.
  const identify = !!explicitDir;

  // REUSE FIRST, and answer from git. A workspace that already exists has a
  // definitive checked-out branch, so there is nothing to identify and nothing
  // that could be ambiguous — asking anyway is how the idempotent path (two
  // clicks, a race, a chat that was never really gone) started answering 409 on
  // a directory that was sitting right there.
  if (isDir(dir)) {
    const branch = await recordWorktreeFacts(issueId, dir);
    return { ok: true, dir, created: false, branch };
  }

  const { get } = await import('./issues-store.mjs');
  let row = null;
  let unreadable = null;
  try { row = await get(issueId); } catch (e) { unreadable = e; }
  // Creation stays deliberately fail-open — a Supabase blip must not block making
  // a worktree, and its answer (a fresh branch off the trunk) costs nothing.
  // Identification cannot: with the row unread, recorded branches look ABSENT,
  // and "absent" is what sends this down the folder/fresh path — inventing a
  // branch for a workspace whose real one the board could have named. Same
  // fail-closed rule workspaceClaimants follows, for the same reason.
  if (identify && unreadable) {
    return {
      ok: false, reason: 'board-unreadable',
      error: `cannot read ${issueId} to see which branch this workspace held: ${unreadable.message}`,
    };
  }
  const resolved = await branchForWorkspace(issueId, dir, row, { identify });
  if (resolved.reason) return { ok: false, reason: resolved.reason, error: resolved.error };
  const { branch, source } = resolved;

  await fs.promises.mkdir(path.dirname(dir), { recursive: true });

  const trunk = await trunkRef();
  let res;
  let base = null;
  if (source !== 'new' && await branchExists(branch)) {
    // git refuses to check one branch out twice, and the alternative — a COPY
    // of its tip under a fresh name — is what breaks the collect/rebuild loop:
    // that copy is neither merged into the trunk nor covered by any gravestone,
    // so the reaper keeps its directory forever. A workspace that cannot be
    // collected again must not be created, so this names the obstacle instead.
    if (await branchCheckedOut(branch)) {
      return {
        ok: false, reason: 'branch-checked-out',
        error: `branch "${branch}" is already checked out in another worktree — close that one before rebuilding ${dir}`,
      };
    }
    res = await git(['worktree', 'add', dir, branch]);
  } else {
    base = (await gravestoneFor(branch)) || trunk;
    res = await git(['worktree', 'add', dir, '-b', branch, base]);
  }

  if (!res.ok) {
    // Don't leave a half-made worktree: prune any registration git may have
    // recorded before failing, and remove a stray dir.
    await git(['worktree', 'prune']);
    try { if (isDir(dir)) await fs.promises.rm(dir, { recursive: true, force: true }); } catch {}
    return { ok: false, error: res.err || 'git worktree add failed' };
  }

  // The wip commit only ever answers one question: is this branch
  // distinguishable from the trunk? A branch based on a gravestone or on
  // another branch's tip already is, and a retired card must stay collectable
  // (above), so neither takes one.
  const retired = row?.status === 'done' || row?.status === 'rejected';
  if (base === trunk && !retired) {
    const c = await run('git', ['-C', dir, 'commit', '--allow-empty', '-m', `wip: open issue ${issueId}`]);
    if (c.status !== 0) {
      return { ok: false, error: `worktree created but initial commit failed: ${c.stderr.trim()}` };
    }
  }

  await recordWorktreeFacts(issueId, dir);
  return { ok: true, dir, created: true, branch, base };
}

// Write back what creating the worktree established: WHICH branch this issue is
// on, and that it is now being worked on. Returns the branch it OBSERVED (null
// when detached), which is what the reuse path reports — a directory that exists
// has a definitive checked-out branch, and a computed one could disagree with it. Reads the branch from git rather than
// from what we intended to create, so the row records what is actually checked
// out. Best-effort on the board write — a Supabase blip must not fail a worktree
// that exists on disk — but never silent: a failure is logged, because an
// unrecorded branch is now a real loss of the link, not just untidiness.
async function recordWorktreeFacts(issueId, dir) {
  const head = await run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = head.status === 0 ? head.stdout.trim() : null;
  if (!branch || branch === 'HEAD') return null; // detached — nothing stable to link
  try {
    const { setIssueBranch, get, setStatus } = await import('./issues-store.mjs');
    await setIssueBranch(issueId, branch);
    // Opening a worktree IS starting work — lift the card out of the backlog.
    // Only ever from `next`: a done or rejected issue must not be reopened by
    // someone glancing at its code, and maybe/future are deliberate parking
    // states a person chose.
    const row = await get(issueId).catch(() => null);
    if (row?.status === 'next') await setStatus(issueId, 'in-progress');
  } catch (e) {
    console.error(`[dash-terminal] could not record branch "${branch}" on ${issueId}:`, e.message);
  }
  return branch;
}

// Can this machine give a chat its working directory back?
//
// A cwd under THIS checkout's worktrees dir is derived state we know how to
// rebuild, so a chat whose workspace was collected is dormant, not dead.
// Anything else — the repo root itself (never rebuilt: chats do not resume into
// the live main checkout), a path from another clone, another machine's
// directory layout — is not ours to make, and saying so is the honest half of
// the answer.
//
// Returns the WORKSPACE ROOT to rebuild, which is not always the recorded cwd:
// a chat may have been started in a subdirectory, and the thing git materialises
// is the worktree.
export function restorableWorkspace(cwd) {
  const workspace = workspaceForDir(cwd);
  if (!workspace || workspace === MAIN_ENV) return null;
  const dir = worktreeDir(workspace);
  return dir ? { workspace, dir } : null;
}

// Make a chat's recorded working directory real again inside its workspace.
//
// The workspace root is what git materialises; a chat may have run in a
// SUBDIRECTORY of it, and the branch we rebuilt onto need not still contain
// that path. An empty untracked directory is invisible to git — the tree stays
// clean, so the reaper can still collect the workspace — which makes creating
// it the honest way to hand a chat its ground back, rather than answering "done"
// while it stays dormant.
//
// Containment is checked PHYSICALLY, not lexically. `workspaceForDir` compares
// resolved path strings, and a string can be inside the worktree while the
// filesystem is not: a symlink checked out by the branch is followed by mkdir,
// so `<worktree>/link/newdir` with `link` pointing anywhere would create that
// directory anywhere. So every EXISTING component on the way down is resolved
// with realpath and required to stay inside the worktree's own realpath; the
// first one that leaves is a refusal, never a repair.
export async function restoreCwdInside(dir, cwd) {
  const rel = path.relative(dir, path.resolve(cwd));
  if (rel && (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))) {
    return { ok: false, error: `${cwd} is not inside ${dir}` };
  }
  let root;
  try { root = await fs.promises.realpath(dir); }
  catch (e) { return { ok: false, error: `cannot resolve ${dir}: ${e.message}` }; }
  const inside = (p) => p === root || p.startsWith(root + path.sep);

  let at = root;
  for (const seg of rel.split(path.sep).filter(Boolean)) {
    const next = path.join(at, seg);
    let real = null;
    try { real = await fs.promises.realpath(next); }
    catch {
      // realpath failed for one of two very different reasons: the component
      // simply is not there (fine — mkdir creates a real directory), or it IS
      // there and cannot be resolved, which for a checked-out tree means a
      // DANGLING symlink. mkdir would still follow that one, and a link we
      // cannot resolve is containment we cannot prove, so it is a refusal.
      let entry = null;
      try { entry = await fs.promises.lstat(next); } catch {}
      if (!entry) { at = next; continue; }
      return { ok: false, error: `${next} cannot be resolved (a dangling symlink?) — refusing to create anything through it` };
    }
    if (!inside(real)) {
      return { ok: false, error: `${next} leaves the worktree (it resolves to ${real}) — refusing to create anything outside ${dir}` };
    }
    at = real;
  }
  try { await fs.promises.mkdir(at, { recursive: true }); }
  catch (e) { return { ok: false, error: `could not restore ${cwd}: ${e.message}` }; }
  return { ok: true, dir: at };
}
