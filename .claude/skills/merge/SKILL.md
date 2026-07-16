---
name: merge
description: Invoke when the user is landing finished work and wants the board updated — "merge it", "land this", "ship it", "mark X done", "/merge …". Closes the board card(s) for the merged branch — moves them to done, records the commit SHAs, and frees the reserved dev-server port. DO NOT invoke to abandon work (use board.mjs reject), or before the change is actually merged.
---

# Merge — close the card on landing

When a change lands, reconcile the board so the card leaves `in-progress`. Adapt
the git steps to your project's merge process; the board reconciliation is the
part this skill owns.

## Step 1 — Find the issues this merge closes

- From commit trailers: scan the merged commits for `issue: <id>` lines.
- From the branch: `node scripts/board.mjs find-branch <branch>` lists ids whose
  `branches[]` include it.
- Or the user named the id directly.

## Step 2 — Close each card

For every closed issue:

```bash
node scripts/board.mjs done <id>              # → done, and frees the reserved dev-server port
node scripts/board.mjs commit <id> <sha>      # record the SHA(s) that resolved it
```

`done` also tears down any dev server still listening on the issue's reserved port
before releasing it, so a merged issue leaves nothing running behind it.

## Step 3 — Confirm

Reply with the closed ids and the SHAs recorded. If a branch had work that was
abandoned rather than landed, use `node scripts/board.mjs reject <id>` instead of
`done` (it also frees the port).
