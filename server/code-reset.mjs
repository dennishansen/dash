// The one thing the Code pane can DO to a repository, kept out of the read-only
// model next door on purpose: return a worktree to the base its file tree is
// measured against.
//
// The pane's heading counts the delta against main — committed branch work,
// uncommitted edits, and untracked adds alike — so "reset" has to mean all of
// it, or the number and the button disagree. It does mean all of it.
//
// Nothing is destroyed. Before a byte moves, the entire state is written to a
// real commit — HEAD as its parent, the whole working tree (untracked files
// included, ignored files excluded) as its tree — plus the index as a tree of
// its own, all pinned under `refs/dash-reset/<env>/<stamp>` so git can never
// collect it. Undo is then three plumbing moves with no guesswork: check that
// commit out, put HEAD back where it was, read the index back. Every file is
// where it was, everything untracked is untracked again, and everything staged
// is staged again. The ref survives the pane, the session, and the machine
// restart, so a hard reset onto it from a terminal is always the escape hatch.
//
// Scope is one worktree. The primary checkout (`main`) is refused outright: it
// is the one tree that carries work nobody in this pane knows about.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { run } from './proc.mjs';
import { MAIN_ENV } from './workspace-env.mjs';
import { CodeBrowserError, environmentRoot, rescan, repositorySnapshot } from './code-browser.mjs';

const SHA = /^[0-9a-f]{7,64}$/;

async function git(root, args, options = {}) {
  const result = await run('git', ['-C', root, ...args], options);
  if (result.status !== 0) {
    // See code-browser's copy: a spawn failure is not a git failure, and saying
    // so matters most here, where the next line might have been a hard reset.
    if (result.error) {
      throw new CodeBrowserError(`could not run git (${result.error.code || result.error.message})`, 500);
    }
    throw new CodeBrowserError(result.stderr.trim() || `git ${args[0]} failed`, 500);
  }
  return result.stdout.trim();
}

function worktreeRoot(env) {
  if (env === MAIN_ENV) {
    throw new CodeBrowserError('Reset is only available for an issue worktree, not the main checkout.', 400);
  }
  return environmentRoot(env);
}

// A commit holding everything that is currently here — tracked modifications,
// staged or not, plus untracked files — built through a throwaway index so the
// worktree's real index is never touched. `git add -A` honours .gitignore, so
// node_modules and .env stay out of it (and stay on disk: the clean below is
// deliberately not `-x`).
async function parkEverything(root, stamp, label) {
  const index = path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dash-reset-')), 'index');
  const withIndex = { env: { GIT_INDEX_FILE: index } };
  try {
    // The REAL index, as a tree of its own. The backup commit flattens staged and
    // unstaged edits into one state; this is what tells them apart again, so a
    // file that was half-staged comes back half-staged. It cannot fail here — a
    // repository whose index won't write a tree is refused before we get this
    // far (see resetRepository).
    const indexTree = await git(root, ['write-tree']);

    await git(root, ['read-tree', 'HEAD'], withIndex);
    await git(root, ['add', '-A'], withIndex);
    const tree = await git(root, ['write-tree'], withIndex);
    const backup = await git(root, ['commit-tree', tree, '-p', 'HEAD', '-m', `dash reset: ${label} ${stamp}`]);
    const ref = `refs/dash-reset/${label}/${stamp}`;
    await git(root, ['update-ref', ref, backup]);
    return { backup, ref, indexTree };
  } finally {
    await fs.promises.rm(path.dirname(index), { recursive: true, force: true });
  }
}

// Returns `{ discarded, ref, parked }`, where `parked` is the opaque handful of
// shas that undo needs back. The caller hands it over verbatim rather than
// reading inside it, so what undo requires stays the server's business.
export async function resetRepository(root, label = 'worktree') {
  // A scan that started AFTER this call, not whichever one the poll happens to
  // have in flight: this decides both what to reset to and whether there is
  // anything to do at all. On a loaded machine that costs a full scan before
  // anything is discarded, and it is worth it — a joined in-flight scan is not a
  // number to hard-reset a branch against.
  const before = await rescan(root);
  if (!before.changedCount) return { ok: true, discarded: 0, ref: null, parked: null };

  // A conflicted index holds three stages per path plus the merge state that
  // explains them, and none of that survives a commit-tree round trip. Since
  // this whole operation is sold on being undoable, a state we cannot restore
  // faithfully is refused rather than reset and half-restored later.
  if (await git(root, ['ls-files', '--unmerged'])) {
    throw new CodeBrowserError(
      'This worktree is in the middle of a merge with unresolved conflicts. Resolve it or abort the merge first — a reset from here could not be undone faithfully.',
      409,
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const { backup, ref, indexTree } = await parkEverything(root, stamp, label);
  // Committed work first, then the untracked files a reset leaves behind. `-fd`
  // and not `-fdx`: ignored build output and local env files are not part of the
  // delta the pane counted, so they are not part of what it discards.
  await git(root, ['reset', '--hard', before.baseSha]);
  await git(root, ['clean', '-fd']);
  // Install the post-reset scan so the pane's refresh joins THAT rather than one
  // that started before the discard and would repaint the tree we just threw away.
  rescan(root);
  return {
    ok: true,
    discarded: before.changedCount,
    ref, // the human-readable recovery handle, for showing
    parked: { head: before.head, base: before.baseSha, backup, indexTree, ref },
  };
}

// The inverse, from the shas the reset handed back. `--hard <backup>` puts every
// file back (including the ones that were untracked, which the parked commit
// tracked in order to keep them); `--mixed <head>` then rewinds HEAD and the
// index without touching those files, so anything not in HEAD's tree reads as
// untracked again; `read-tree <indexTree>` restores the staged/unstaged split.
//
// It refuses unless the worktree is still exactly where the reset left it —
// same HEAD, nothing new on disk. Undo overwrites, so an undo onto work that
// arrived AFTER the reset (a chat that carried on, a commit, a new file) would
// be a second destruction dressed up as a rescue. Refusing is not a dead end:
// the parked ref is still there, and the message says so.
export async function undoRepository(root, parked, label = 'worktree') {
  const { head, backup, base, indexTree, ref } = parked || {};
  if (![head, backup, base, indexTree].every((sha) => SHA.test(String(sha || '')))) {
    throw new CodeBrowserError('Undo needs the commits the reset returned.', 400);
  }
  // Worktrees of one clone share an object database AND a ref namespace, so B's
  // repository can resolve A's backup commit perfectly well. The ref is what
  // says whose it is: a token only unlocks the worktree whose reset minted it.
  if (typeof ref !== 'string' || !ref.startsWith(`refs/dash-reset/${label}/`)
    || await git(root, ['rev-parse', '--verify', `${ref}^{commit}`]) !== backup) {
    throw new CodeBrowserError('That reset belongs to a different worktree.', 400);
  }
  // Every object this is about to move to is proved to exist BEFORE the first
  // move. Otherwise a well-formed sha naming nothing fails halfway and strands
  // the worktree on the backup commit — an undo that made things worse.
  for (const [object, kind] of [[backup, 'commit'], [head, 'commit'], [indexTree, 'tree']]) {
    const found = await run('git', ['-C', root, 'cat-file', '-e', `${object}^{${kind}}`]);
    if (found.status !== 0) throw new CodeBrowserError(`${object} is not in this repository any more.`, 410);
  }
  // Checked immediately before the write, and still not a lock: a process that
  // writes into this worktree in the millisecond after would be overwritten.
  // Git offers nothing better short of holding index.lock across the pair, and
  // the guard's job is to stop a human resuming work and then clicking Undo an
  // hour later, which it does.
  const [at, dirty] = await Promise.all([
    git(root, ['rev-parse', 'HEAD']),
    git(root, ['status', '--porcelain']),
  ]);
  if (at !== base || dirty) {
    throw new CodeBrowserError(
      `This worktree has moved on since the reset, so undo would overwrite it. The reset is still parked at ${backup}.`,
      409,
    );
  }
  await git(root, ['reset', '--hard', backup]);
  await git(root, ['reset', '--mixed', head]);
  // Working tree restored; now put the staged/unstaged split back. `read-tree`
  // rewrites the index alone, so nothing on disk moves.
  await git(root, ['read-tree', indexTree]);
  rescan(root);
  return { ok: true, head };
}

// The env-facing pair. Resolution is the only thing they add — same split as
// environmentSnapshot/repositorySnapshot next door, so the destructive primitive
// can be driven against a throwaway repository in a test.
export const resetWorkspace = (env) => resetRepository(worktreeRoot(env), env);
export const undoReset = (env, parked) => undoRepository(worktreeRoot(env), parked || {}, env);
