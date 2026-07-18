# Driving Dash — the board and the agent CLIs

Dash is a kanban board over a single Supabase `issues` table, plus a set of
command-line tools that let a coding agent (Claude Code, Codex) **operate the
board and run itself against it**. This doc is the reference for that agent-facing
layer: the schema, the `board.mjs` CLI, and the spawn / chat API that turns a
card into a running agent session you can watch live.

The whole thing is designed so you work the way the author does: log a unit of
work as a card, kick an agent off on it (it gets its own git worktree and dev
server), and open the card later only to watch or unblock it.

## The `issues` table

One row per issue — content (title, body, tags, sessions, branches, commits) and
board slice (status column, rank, owner) live together as the single source of
truth, shared live across worktrees and machines. Read and write through
`scripts/board.mjs` or by dragging cards in the board UI; there is no separate
registry.

### Identity

`id` is any stable slug — a plain kebab slug (`toolbar-icon-misaligned`) or, if
you anchor issues to agent sessions, a `<hex>-<slug>` form (`9e4b-rect-corner-drift`).
`new` rejects a duplicate id; `board.mjs get <id>` errors if it doesn't exist yet.

### Schema

| column          | type        | notes                                                                 |
|-----------------|-------------|-----------------------------------------------------------------------|
| `id`            | text PK     | stable slug                                                           |
| `title`         | text        | required; one-line description                                       |
| `body`          | text        | markdown — repro / plan / notes / receipts (images embed as `![label](url)`) |
| `tags`          | text[]      | free-form; board views filter on these                              |
| `branches`      | text[]      | branches attempting this issue (often empty)                        |
| `sessions`      | text[]      | agent session ids reproducing / working it                          |
| `commits`       | text[]      | SHAs that resolved it (appended on merge)                            |
| `conversations` | text[]      | agent conversation ids that worked it (appended on `start`)         |
| `status`        | text        | board column (see below); default `next`                            |
| `rank`          | float8      | order within the column                                             |
| `owner`         | text        | who holds it                                                        |
| `created`       | date        | logical creation date (YYYY-MM-DD)                                  |
| `updated_at`    | timestamptz | last touched; bumped by trigger on any write                        |
| `port`          | integer     | dev-server port reserved for the issue's worktree while active; null = free. Allocated at worktree-create time, cleared on `done`/`reject`. Allocation bind-probes candidates so a live port is never handed out; freeing kills any listener still on the port before clearing the row (`server/ports.mjs`). |

Only `id` and `title` are required to create; everything else defaults
(`status:'next'`, empty arrays, `body:''`).

### Board columns

- **`maybe`** — idea / exploration / uncertain. No committed plan.
- **`future`** — planned, not committed to a near-term slot.
- **`next`** — committed / actively up. Default for a freshly logged issue.
- **`in-progress`** — work has begun. Set the moment an agent starts acting on the
  issue (or a worktree is created for it) via `board.mjs start`, which also links
  the conversation. Merging moves it out.
- **`done`** — shipped: at least one commit landed.
- **`rejected`** — won't do / wrong framing / dupe.

## `board.mjs` — the board CLI

Read and write the board with no running server needed (it talks straight to
Supabase). Writes authenticate as the service role, so `DASH_SUPABASE_SERVICE_KEY`
must be set (see `.env.example`).

```bash
node scripts/board.mjs list [--status next] [--tag <tag>]
node scripts/board.mjs search <query>                            # find issues by id/title/tag (same matcher as ⌘K)
node scripts/board.mjs get <id>                                  # full row incl. body
node scripts/board.mjs new <id> --title "..." [--tags a,b] [--sessions h1] \
     [--created YYYY-MM-DD] [--status next] [--body-file path]
node scripts/board.mjs body <id> (--body "..." | --body-file path)
node scripts/board.mjs status <id> <maybe|future|next|in-progress|done|rejected>
node scripts/board.mjs start <id>                # → in-progress + link this conversation
node scripts/board.mjs done <id> [<id>...]       # ship: → done + free the dev-server port
node scripts/board.mjs owner <id> <name|->       # claim / release
node scripts/board.mjs tag|session|convo|branch|commit <id> <value>...   # append (de-duped)
node scripts/board.mjs find-branch <branch>      # ids whose branches[] has it
```

`start` reads `$CLAUDE_CODE_SESSION_ID` from the environment to link the working
conversation. Attach a fix to a card durably by adding an `issue: <id>` trailer to
your commit message and `board.mjs commit <id> <sha>` when it lands.

The store (`server/issues-store.mjs`) is a plain `fetch` against PostgREST — no
client dependency — and is **isomorphic**: the same module runs in node (this CLI,
the dev middleware) and in the browser (the deployed board). Reorder and
cross-column moves run server-side as Postgres functions so a whole column
renumbers atomically.

## The agent chat API — spawn a card and run it

Two CLIs turn a card into a running, watchable agent session. They POST to the
running dash dev server (default `http://localhost:5173`; override with
`--base` or `DASH_BASE_URL`), because the agent's PTY must live inside the dash
server's process so that opening the card later **reattaches** to the same live
session instead of forking a second one.

### `spawn-issue.mjs` — file and launch

```bash
node scripts/spawn-issue.mjs <id> [--title "..."] [--tags a,b] \
     [--bug] [--agent claude|codex] [--model M] [--effort E] [--prompt "..."]
```

Creates the issue row if needed (`--title` required for a new id), then asks the
dash server to: ensure a git worktree for the issue, reserve a dev-server port,
mint and link an agent session, and spawn the agent **server-side immediately**
into its chats map. The agent's opening brief tells it to load the issue with
`board.mjs get <id>` and implement it end-to-end (the `--bug` flow reproduces
first). The card moves to `in-progress`. This is the CLI equivalent of opening a
card and pressing "create worktree and start the agent" — except the agent both
files it and sends it off. You open the card later only to monitor and unblock.

Requires the terminal backend (`node-pty`) — the same optional dependency the
browser terminal needs.

### `agent-chat.mjs` — read and talk to a running chat

```bash
node scripts/agent-chat.mjs list <issue>                          # the issue's chats (live/resumable)
node scripts/agent-chat.mjs read <session> [--after N] [--wait [S]]  # spoken turns; --wait blocks for a new one
node scripts/agent-chat.mjs send <issue> <session> "message"      # deliver a message into the chat
```

`read --after <cursor> --wait` blocks until the chat produces a *new* assistant
turn — the primitive for polling a launched agent's progress. `send` delivers a
message into the chat (live PTY → pasted as a turn; a dead chat is resumed with
the message as its first turn), wrapped by default in an envelope that names the
sender and the literal reply command, so two agents can hold a dialog a human
watches live on the board.

### The HTTP endpoints underneath

Both CLIs are thin clients over routes the dash server mounts at
`/api/dash/terminal/*` (defined in `server/terminal.js`), served by both the dev
server (`vite.config.js`) and the production server (`bin/dash.mjs`) when
`node-pty` is installed:

- `GET  /api/dash/terminal/chats?issue=<id>` → the issue's worktree, port, and chats
- `POST /api/dash/terminal/chat  { issue, autonomous?, flow?, agent?, prompt? }` → ensure worktree + reserve port + mint/spawn a chat
- `GET  /api/dash/terminal/transcript?session=<uuid>&after=<n>` → a chat's spoken turns
- `POST /api/dash/terminal/message { issue, session, text }` → deliver a message into a chat

These run git and spawn shells, so they sit behind the same Host/Origin guard as
the rest of `/api/dash` and the terminal websocket (see the Security section of
the README). On the loopback default they carry no token; expose them only
deliberately.

## Auth model

The board works remotely with no backend — the browser talks to Supabase
directly through the isomorphic store. The machine-bound half (the per-card
terminal, worktree spawning, the code browser) only exists where the dev
middleware or `bin/dash.mjs` runs; `src/capabilities.js` probes `GET /api/dash`
once at boot and renders a clean "not on this machine" guard for those panes
when there's no local backend.

Access is gated by **email one-time-code sign-in + row-level security**, not by
the committed anon key:

- The board sits behind an email OTP gate (`src/auth.js`, raw `fetch` GoTrue).
- The `issues` RLS policy only answers for an authenticated session whose email
  is in the `dash_allowed_emails` table; a bare anon key reads/writes nothing.
- Node tools bypass RLS via `DASH_SUPABASE_SERVICE_KEY` (the service role),
  loaded from `.env.local` by `server/node-env.mjs`. From a worktree it resolves
  `.env.local` in the main checkout via git's common dir.
- Add a teammate: `insert into dash_allowed_emails (email) values ('them@example.com');`.

Supabase setup this depends on: email auth enabled, an SMTP sender for code
delivery, and the magic-link email template must include `{{ .Token }}` so the
email carries the 6-digit code (see `supabase/schema.sql`).

## How it composes with skills

`.claude/skills/` ships a set of skills that wire this board into an agent's
workflow — they are starting points, meant to be edited for your project:

- **`/issue`** — bare logging. `board.mjs new` creates the row (defaults to `next`).
- **`/change`** — the change protocol: work in a worktree, confirm scope, pin
  behavior with tests, replace rather than parallel, verify, then report. Runs
  `board.mjs start <id>` when the change is tied to a card.
- **`/bug`** — reproduce → failing test, then hand to `/change` for the fix.
- **`/kick-off-issue`** — file a card and launch an autonomous agent on it via
  `spawn-issue.mjs`.
- **`/agent-chat`** — read and talk to a launched chat via `agent-chat.mjs`.
- **`/merge`** — on landing, `board.mjs done <id>` (moves the card out of
  in-progress, frees the port) and `board.mjs commit <id> <sha>`.
