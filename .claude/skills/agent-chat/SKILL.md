---
name: agent-chat
description: Invoke when the user wants to check on, read, or message an agent that was launched on a board card via /kick-off-issue — "how's the agent doing on X", "what did the agent on X say", "tell the agent on X to also …", "reply to the agent", "/agent-chat …". Reads a launched chat's transcript and delivers messages into it, so you can monitor or steer a running agent (or hold an agent-to-agent dialog a human watches live on the board). Needs the dash server running.
---

# Talk to a launched agent

The communication half of `/kick-off-issue`. That skill launches an agent on a
card; this one reads its chat and writes into it, in both directions, via
`scripts/agent-chat.mjs`. Machine-local — it goes through the running dash server
(default `http://localhost:5173`), which owns the live sessions.

## Commands

```bash
# What chats exist for an issue (session ids, live vs. resumable):
node scripts/agent-chat.mjs list <issue>

# Read a chat's spoken turns. --after polls incrementally from a cursor;
# --wait blocks until the agent produces a NEW turn (the progress primitive):
node scripts/agent-chat.mjs read <session> [--after N] [--wait [seconds]]

# Deliver a message into the chat (steer it, answer its question, add context):
node scripts/agent-chat.mjs send <issue> <session> "your message"
```

## Typical uses

- **Check progress** — `list <issue>` to find the live session, then
  `read <session>` for the latest turns, or `read <session> --after <cursor> --wait`
  to block until it says something new.
- **Steer / unblock** — `send <issue> <session> "…"`. A live chat receives it as a
  pasted turn (a busy agent queues it); a finished chat is resumed with the message
  as its first turn. `send` prints the exact `read … --wait` command to await the
  reply, skipping prior history.
- **Answer a question the agent asked you** — reply with `send`; it lands in the
  chat as a user turn.

By default `send` wraps the message in an envelope naming the sender and the
literal reply command, so the receiving agent can reply without knowing this tool
exists — that's what lets two launched agents hold a dialog you watch live on the
card. Pass `--plain` to send the raw text with no envelope.

The session id comes from the `/kick-off-issue` output or the issue's
`conversations[]` (`board.mjs get <issue>`).
