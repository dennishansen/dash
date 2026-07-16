---
name: issue
description: Invoke when the user wants to LOG a unit of work to the Dash board without doing it now — "log this", "log a bug", "track this", "add an issue", "record this", "/issue …", or bulk collection like "I'm going to log a bunch of bugs". Pure logging — creates a row in the Supabase issues table via scripts/board.mjs. Does NOT fix anything. For "fix X" / "X is broken" use /bug; to log AND launch an agent on it use /kick-off-issue.
---

# Log an issue to the board

Bare logging for the `issues` table. Creates one row per issue via
`scripts/board.mjs` — no reproduce, no fix. See `docs/dashboard.md` for the
schema. Requires a network connection (writes go straight to Supabase; set
`DASH_SUPABASE_SERVICE_KEY`).

## When to invoke

- "log a bug: …" / "log this: …" / "record an issue: …" / `/issue …`
- "I'm going to log 20 things, here's the first" — bulk collection.
- "track that X happens when Y" — an observation with no fix planned now.

Do NOT invoke if the user wants the fix this session (use `/bug`), or wants an
agent launched on it (use `/kick-off-issue`).

## Step 1 — Pick an id

A plain kebab slug (`toolbar-icon-misaligned`), or `<hex>-<slug>` if you anchor
issues to an agent session. `board.mjs new` rejects a duplicate; check first with
`node scripts/board.mjs get <id>` (errors if it doesn't exist yet).

## Step 2 — Create the row

Write the body (markdown) to a temp file, then create the row. New issues default
to the `next` column.

```bash
cat > /tmp/<id>.md <<'EOF'
## Repro / Context

<the user's description>

## Notes

<optional>
EOF

node scripts/board.mjs new <id> \
  --title "<one-line description>" \
  --tags <tag>,<tag> \
  --created $(date +%F) \
  --body-file /tmp/<id>.md
```

Tags are free-form and lowercase — group however your project wants. For a
speculative idea pass `--status maybe`; for planned-but-not-now `--status future`.
Logging in bulk: create one row per item, never concatenate.

## Step 3 — Confirm

Reply with the issue id. If the user is collecting more, prompt for the next. When
they're done, print a short summary (count + ids/titles) and suggest `/bug <id>`
or `/kick-off-issue <id>` when they're ready to work one.
