---
name: kick-off-issue
description: Invoke when the user wants to file a board issue AND autonomously launch an agent on it — "kick off an issue", "kick this off and run it", "make issue X and run it", "spawn an agent on this", "set it running so I can monitor it", "/kick-off-issue …". The CLI equivalent of opening a card, creating its worktree, and starting an agent that runs the change to completion. Routes through the running dash server so the human can open the card later and reattach to the live chat. DO NOT invoke for plain logging with no launch (use /issue), or to fix something in THIS chat (use /bug).
---

# Spawn an issue and run it autonomously

File a tracked issue (if it doesn't exist yet) and immediately launch its board
chat as a real agent session that implements it end-to-end in its own git
worktree. Parity with a human opening the card and starting the agent — except the
agent both files it and sends it off. The human opens the card later only to
**monitor and unblock**, not to start it.

## When to invoke

- "kick off an issue" / "kick this off and run it"
- "make issue X and run it" / "spawn a chat on this and let it execute"
- `/kick-off-issue <id> …`

Do NOT invoke for pure logging with no launch (`/issue`), or to fix something in
this chat (`/bug`).

## Step 1 — Confirm the dash server is running

The autonomous agent's PTY can only live inside the running dash server, so it can
be reattached when the card is opened later. `spawn-issue.mjs` probes
`GET /api/dash` and errors clearly if the server is down. If it errors, tell the
user to start the dash dev server (`npm run dev`, default `http://localhost:5173`)
and stop — don't fall back to a standalone agent spawn (a detached process would
collide with a later card-open). The terminal backend (`node-pty`) must be
installed.

## Step 2 — Run the script

```bash
node scripts/spawn-issue.mjs <id> [--title "..."] [--tags a,b] \
     [--bug] [--agent claude|codex] [--model M] [--effort E]
```

- `<id>` — reused if it exists; otherwise `--title` is required to create the row.
- `--title` — keep it short; put context and detail in the issue body, not the title.
- `--bug` — run the reproduce-first flow instead of the default change flow.
- `--agent` — `claude` (default) or `codex`.
- `--base` — dash origin if not `http://localhost:5173`.

It ensures the worktree, reserves a dev-server port, mints and links a session,
spawns the agent server-side, moves the card to **in-progress**, and prints the
session id, worktree dir, and monitor pointer.

## Step 3 — Hand off

Tell the user the agent is running and where to watch it: open the issue's card in
the dash to reattach to the live chat and monitor / unblock. Don't wait on it in
this chat — it runs independently.

## Afterwards — talk to the launched agent

Launching isn't the end of the relationship. `/agent-chat`
(`scripts/agent-chat.mjs`) reads the launched chat's transcript
(`read <session> --after <cursor> --wait`) and sends follow-ups into it
(`send <issue> <session> "…"`). Use it to check progress, feed the agent new
context, or answer a question it sent you. The session id is in the spawn output
and the issue's `conversations[]`.
