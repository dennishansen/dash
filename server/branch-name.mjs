// What an issue's git branch is CALLED — and the deliberate split between a
// branch name and issue identity.
//
// Branches used to be named after the issue id (`i-a03f7f`), which reads as
// nothing to a teammate who pulls one into their own checkout. A branch is now
// named after the issue's TITLE, and — this is the point — nothing more:
//
//   "Dash for teams"     → dash-for-teams
//   "Chat attach crash"  → chat-attach-crash
//
// When the title is short, the branch IS the title. No suffix, no decoration.
//
// The id is NOT part of the name. It used to be appended always, as a nod to
// "you can tell which card this came from" — but the identity link is the issue
// ROW (branches[0]), recorded when the worktree is created, and nothing anywhere
// parses a branch name to recover an issue. An always-on suffix was therefore
// paying a permanent readability cost for a job it wasn't doing. It now appears
// ONLY to break a real collision (see uniqueBranchName), which is the only thing
// it was ever actually needed for.
//
// One source of truth for issue identity remains the worktree FOLDER
// (.claude/worktrees/<issue-id>), which keeps the id. That is what an agent
// matches its own cwd against to know which issue it is working on, and what
// every hook and skill already resolves through.

// Git ref-name rules are a list of forbidden things; this produces a name from a
// deliberately tiny alphabet ([a-z0-9-]) instead, so none of them can occur — no
// spaces, no `~^:?*[\`, no `..`, no `.lock`, no leading or trailing dot or slash.
//
// The cap is short on purpose. Titles today run long (median 40 chars, a tenth
// over 86), and a branch is something you type and read in `git checkout`, so a
// long title is truncated at a word boundary rather than reproduced. A title
// already at or under the cap comes through whole, which is the case worth
// optimising for.
const MAX_SLUG = 32;

// Names git (or we) must never hand out as an issue branch, whatever the title
// slugifies to. `main`/`master` would collide with the trunk; the rest are refs
// git treats specially.
const RESERVED = new Set(['main', 'master', 'head', 'origin']);

export function slugify(title) {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= MAX_SLUG) return slug;
  // Trim to the cap, then back to the last word boundary so the name ends on a
  // whole word rather than mid-syllable. If there is no boundary to fall back to
  // (one very long word), the hard cut stands.
  const cut = slug.slice(0, MAX_SLUG);
  const lastDash = cut.lastIndexOf('-');
  const trimmed = (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/, '');
  // A truncation can leave a single stranded character as the last token
  // ("…-receipt-for-i"). One character is never a word, so drop it. Deliberately
  // NOT a stopword list — trimming a trailing "and" or "the" would mean guessing
  // at English, and a name ending in a real word is fine even if it dangles.
  return trimmed.replace(/-[a-z0-9]$/, '');
}

// The id's short form — `i-a03f7f` → `a03f7f`. Only used as a collision
// tie-breaker and as the fallback for a title that slugifies to nothing.
export function shortId(issueId) {
  const id = String(issueId || '');
  const stem = /^i-(.+)$/.exec(id);
  return slugify(stem ? stem[1] : id);
}

// The IDEAL branch name for an issue: the title, slugified, and nothing else.
// Deterministic and pure — it knows nothing about what other branches exist, so
// it always returns the name we'd most like to use. A titleless issue (or one
// whose title is all punctuation) falls back to the short id, which is still a
// valid, if terse, ref. A title that slugifies to a reserved name gets the same
// fallback rather than a branch called `main`.
export function branchNameFor(issueId, title) {
  const slug = slugify(title);
  const stub = shortId(issueId);
  if (!slug || RESERVED.has(slug)) return stub || 'issue';
  return slug;
}

// The name to ACTUALLY create, given what already exists. `taken(name)` answers
// "is this ref already in use" — a git lookup at worktree-create time, or the
// set of local branches plus names already planned during a migration run.
//
// The ideal name wins whenever it's free. Only a genuine clash pulls the id in,
// and only then: two issues titled "Chat attach crash" become
// `chat-attach-crash` and `chat-attach-crash-a03f7f`. A numeric tail is the last
// resort for the pathological case where even that is taken.
//
// The result is NOT recomputable from the issue alone — it depends on repo state
// — which is exactly why the branch is recorded on the row. Identity was never
// the name's job.
export function uniqueBranchName(issueId, title, taken = () => false) {
  const ideal = branchNameFor(issueId, title);
  if (!taken(ideal)) return ideal;

  const stub = shortId(issueId);
  const withStub = stub && ideal !== stub ? `${ideal}-${stub}` : ideal;
  if (withStub !== ideal && !taken(withStub)) return withStub;

  for (let n = 2; n < 100; n++) {
    const candidate = `${withStub}-${n}`;
    if (!taken(candidate)) return candidate;
  }
  return `${withStub}-${Date.now().toString(36)}`;
}
