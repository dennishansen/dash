---
name: change
description: Invoke for any codebase change the user asks for — add a feature, build a surface, refactor, restructure, modify behavior, "let's build X", "add a button/toggle/shortcut", "ship the X feature", or any imperative naming a concrete change. Enforces a protocol — work in a worktree, confirm scope, pin behavior with tests, replace don't parallel, verify, then report. When the change is tied to a board issue, moves the card to in-progress. DO NOT invoke on a bare "implement"/"redesign"/"fix" with no named target (that's discussion), or on a trivial numeric tweak (apply it literally).
---

# Change workflow

A protocol for making a codebase change well. This is a **starting point** — adapt
the steps and receipts to your project. When the change is tied to a Dash card,
it also keeps the board honest.

## Step 0 — Work in a worktree

Isolate the change on its own branch off `main` so edits, commits, and a dev
server never disturb the primary checkout. If your harness has a worktree tool
(e.g. `EnterWorktree`), use it; otherwise `git worktree add`. This is the default
for every non-trivial change.

## Step 1 — Confirm scope first, in prose

Before any edit, state what you're about to change. For user-visible changes
(new buttons, changed gestures, label/behavior changes), list them and wait for
confirmation. For internal-only changes (refactors, renames), state the surface
and intent in a sentence and proceed.

**If this change is tied to a tracked issue** (the user named one, or you're on a
branch/worktree for it): once scope is confirmed, run
`node scripts/board.mjs start <id>`. That moves the card to **in-progress** and
links the current conversation (`$CLAUDE_CODE_SESSION_ID`), so the board reflects
active work the moment it begins.

## Step 2 — Change-philosophy walk

Before settling on an approach, answer:

1. Does this pattern exist elsewhere — should the fix unify all instances?
2. Is the underlying model wrong, such that this fix is a band-aid?
3. Would the system look like this if the change had been a day-one assumption?

If any answer points at a redesign, propose it before implementing. If a nearby
part's shape blocks the clean version of your change, reshape it in the same pass
(as a separate behavior-preserving step, tests staying green) rather than working
around it.

## Step 3 — Pin behavior with tests before editing

Get a baseline green first. For changes to existing surfaces, write a test that
pins the contract you're about to modify. Enumerate the axes of variation (empty
vs. selection, on vs. off, single vs. multi) and cover each — a missed edge case
is the usual failure mode.

## Step 4 — Implement by replacing, not paralleling

Delete the old code in the same commit. Don't bolt an adapter on top of code that
should be removed. If scope forces keeping both temporarily, name a separate
cleanup task with an explicit trigger.

## Step 5 — Verify and show receipts

Run the test suite and state what passed. For a visible change, show the proof
your project uses (a screenshot, a recording, a passing assertion) — don't declare
done on "tests pass" alone. **Link a tracked issue in the commit** with an
`issue: <id>` trailer so `/merge` can move the card to done on landing.

## Step 6 — Present the result

Lead with what changed (architectural, not line-by-line), then the receipts, then
a way for the user to try it (a dev server link, the command to run). No "all
set" without all three.

## Sentinels that mean you're not actually done

- "this should work now" / "all set"
- "tests pass" (what about the visible proof?)
- shipping a case you never enumerated in Step 3
