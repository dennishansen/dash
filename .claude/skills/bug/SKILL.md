---
name: bug
description: Invoke when the user reports a bug and wants it fixed this session — "X is broken", "I can no longer Y", "this is incorrect", "fix the failures", or a symptom with a repro. Provides the bug prelude — track it on the board, reproduce, write a failing test — then hands off to /change for the fix. DO NOT invoke for pure analysis with no fix intent, or for bare logging with no fix intent (use /issue).
---

# Bug workflow

The bug-specific prelude (track → reproduce → failing test), then `/change` owns
the fix. Every bug becomes a board row first — the card is the durable record,
the chat is ephemeral. Adapt the reproduce/receipt steps to your project.

## Step 0 — Create or update the issue

Issues live in the Supabase `issues` table via `scripts/board.mjs` (schema in
`docs/dashboard.md`). Pick an id (plain slug, or `<hex>-<slug>` if anchored to a
session). If a matching issue already exists (e.g. the user ran `/issue`), append
to it; otherwise create it:

```bash
node scripts/board.mjs new <id> --title "<one-line>" --tags <tag> \
  --created $(date +%F) --body-file /tmp/<id>.md
```

A new issue defaults to the `next` column — a reported bug is something you intend
to fix.

## Step 1 — Identify

Read the implicated file at the relevant lines (files are truth; diffs age out).
State the bug in code terms, not just symptoms. Record the diagnosis in the issue
body's repro section (`board.mjs body <id> --body-file …`, regenerating the temp
file from the current body via `board.mjs get <id>`).

## Step 2 — Reproduce

Reproduce the broken behavior deterministically and capture whatever proof your
project uses (a failing assertion, a screenshot, a recording). Embed the proof in
the issue body so the card carries it.

## Step 3 — Failing test

Write a test that captures the bug and **fails on current code**. Note its path in
the issue body. This is the contract the fix has to flip.

## Step 4 — Hand off to /change

Mark it in-progress — `node scripts/board.mjs start <id>` (moves the card and
links this conversation) — then invoke `/change` for the fix. Don't patch from
inside `/bug`; the skills compose by handoff. Add an `issue: <id>` trailer to the
fix commit so `/merge` closes the card on landing.

## Step 5 — Confirm the fix

Re-run the failing test → now passing. Capture the after-proof next to the before
in the issue body so the delta is watchable, then present per `/change` Step 6.
