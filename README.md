# Dash

A kanban board where every card comes with its own terminal, backed by your own
[Supabase](https://supabase.com).

The board itself is a live, multiplayer Supabase app: cards are Postgres rows,
drag-to-reorder runs as atomic server-side functions, and every change streams to
open tabs over Supabase Realtime. There's no `@supabase/supabase-js` here — the
client is hand-rolled `fetch` plus a from-scratch Realtime socket, so it stays
small and there's nothing between you and your database you can't read.

Run Dash on your own machine and each card grows a real shell. Alongside it: a
workspace panel that previews your running app and browses the repo in a Monaco
editor, and terminals that know when the coding agent inside them is working or
waiting on you.

> Bring your own Supabase. Nothing is hardcoded to any project — point it at yours
> with three env vars and it's yours.

## What's in the box

**The board.** Create, rename, drag between columns, reorder, edit card bodies.
Changes land in every open tab and for every teammate in real time. Sign-in is an
email one-time code, gated to an allow-list you control. This part talks straight
to Supabase — no local server — so you can host the static board anywhere.

**A terminal on every card.** A genuine shell/PTY on the host, in the browser.
Sessions live server-side, so a refresh drops you back into the same running
process with its scrollback intact. Open one session in two panes and they stay
in lockstep. (Needs Dash running on your machine, plus the optional `node-pty`.)

**Agents that report back.** Run `claude` or `codex` in that terminal and Dash
watches the screen to tell working from idle — so a card tells you whether its
agent is still going or has handed the turn back to you.

**A workspace panel.** The right-hand dock has two modes. *App* renders your
running dev server in an iframe. *Code* walks the repository and opens changed
files in a Monaco editor for review. Both stay mounted, so switching between them
never resets your preview or your place in a file. Toggle with `Cmd+/`.

**Light, dark, or whatever your OS is doing.** One theme menu.

## Quickstart

**1. Create a Supabase project** at [supabase.com](https://supabase.com) (the
free tier is fine).

**2. Run the schema.** In the project's SQL Editor, paste and run
[`supabase/schema.sql`](supabase/schema.sql). It creates the `issues` table, the
board RPCs, the email allow-list, RLS policies, and the Realtime publication.

**3. Allow your email.** Still in the SQL Editor:

```sql
insert into public.dash_allowed_emails (email) values ('you@example.com');
```

**4. Set env vars.** Copy the example and fill in your project's values (from
Supabase → Project Settings → API):

```bash
cp .env.example .env.local
# edit .env.local: DASH_SUPABASE_URL, DASH_SUPABASE_ANON_KEY, DASH_SUPABASE_SERVICE_KEY
```

**5. Install, build, run.**

```bash
npm install        # node-pty (browser terminal) is optional; install still succeeds without it
npm run build      # bakes the anon URL/key into the browser bundle
npm start          # or: npx dash  — serves the built app + backend on http://localhost:5173
```

Open <http://localhost:5173>, sign in with your allow-listed email, and enter the
6-digit code Supabase emails you.

### Development

```bash
npm run dev        # Vite dev server with HMR + the same backend middleware
```

## Environment variables

| Variable | Required | Where it's used | Purpose |
| --- | --- | --- | --- |
| `DASH_SUPABASE_URL` | yes | node + browser (baked at build) | Your project URL, e.g. `https://xxxx.supabase.co` |
| `DASH_SUPABASE_ANON_KEY` | yes | node + browser (baked at build) | Public anon/publishable key. Identifies the project; grants nothing on its own (RLS gates access). |
| `DASH_SUPABASE_SERVICE_KEY` | for local writes | **node only** — never shipped to the browser | Service-role key. Bypasses RLS so the local server can read/write the board and mint a local dev session. Keep it secret. |
| `DASH_HOST` | no | node (`npm start`) | Interface to bind. Defaults to `127.0.0.1` (loopback only). Set to `0.0.0.0` to expose on your network — only on a trusted network. |
| `DASH_ALLOWED_ORIGINS` | no | node (`npm start` / dev) | Comma-separated extra origins allowed to reach the terminal websocket and HTTP API (e.g. `https://dash.example.com`). Loopback is always allowed. Needed if you expose Dash beyond localhost. |
| `DASH_ALLOWED_HOSTS` | no | node (`npm start` / dev) | Comma-separated extra `Host` values the HTTP API will accept, when the request host differs from your allowed origins. Loopback is always allowed. |
| `DASH_TERMINAL_TOKEN` | no | node (`npm start` / dev) | Secret required on the terminal handshake. Auto-generated (and the URL printed) whenever Dash binds a non-loopback host; set it to pin a stable token, or to require one on loopback too. |

Set these in `.env` / `.env.local` (git-ignored) or in the real environment. The
browser values are injected at **build time**, so re-run `npm run build` after
changing them.

## Which features need what

The board is built so the core works from anywhere, while the machine-specific
features light up only when the local backend is running (probed once at boot via
`/api/dash`; see `src/capabilities.js`).

**Runs from the static board (Supabase-direct, no local backend):**

- The full kanban board: create, rename, drag/reorder, move between columns,
  delete cards, edit card bodies.
- Live realtime updates across tabs and users.
- Email OTP sign-in and the allow-list gate.

**Needs the local backend (`npm start` / `npm run dev` on your machine):**

- **The card terminal** — requires the optional native dependency `node-pty`.
  Spawns a real shell/CLI, so it's powerful and specific to the machine Dash runs
  on. Agent status detection rides on top of it.
- **The workspace panel** — the *App* preview needs your dev server running on a
  port; *Code* reads the repository through the backend.

On a remote or static deploy with no local backend, these render a "not on this
machine" guard and the board keeps working.

## Security

The card terminal spawns a **real shell/PTY on the host** for any signed-in user.
Treat access to a running Dash the way you'd treat SSH to that machine. Three
protections are on by default:

- **Loopback bind.** `npm start` binds `127.0.0.1`, so the server — and the
  terminal — is reachable only from the same machine. Expose it deliberately with
  `DASH_HOST=0.0.0.0`, and only on a network you trust.
- **Same-origin handshake.** The terminal websocket and the HTTP API reject any
  request whose `Origin`/`Host` isn't loopback (or listed in
  `DASH_ALLOWED_ORIGINS` / `DASH_ALLOWED_HOSTS`). Browsers don't apply the
  same-origin policy to websockets, so without this a page you merely *visit*
  could reach the socket — this closes that drive-by (and DNS-rebinding) class of
  attack.
- **Secret token when exposed.** The origin check only constrains *browsers* — a
  direct network client (curl, a script) can send any `Origin` it likes. So the
  moment Dash binds a routable host, the handshake also requires a secret token.
  Dash generates one at startup and prints the URL to open (`…/?token=…`); the
  browser reads the token from that URL and it never rides in the page HTML, so a
  network attacker can't fetch it. This is what actually secures the exposed PTY
  (the origin list alone does not). Pin your own with `DASH_TERMINAL_TOKEN`.

If you deploy Dash behind a real origin, set `DASH_ALLOWED_ORIGINS` to that
origin, open the tokenized URL Dash prints, and put it behind your own auth/TLS.
Access is otherwise gated by Supabase email-OTP sign-in against the
`dash_allowed_emails` allow-list.

## How it works

- **`src/`** — the React app (Vite, HashRouter). `board-store.js` talks to
  Supabase's REST API directly from the browser; `realtime.js` hand-rolls the
  Supabase Realtime websocket; `auth.js` does email-OTP against GoTrue. No
  `@supabase/supabase-js` — it's plain `fetch`, so the client stays tiny. The
  terminal lives in `views/Terminal.jsx` (xterm) with agent adapters in
  `agents.js`; the workspace panel is `WorkspacePanel.jsx` + `CodeBrowser.jsx`
  (Monaco).
- **`server/`** — isomorphic Supabase modules (`issues-store.mjs`,
  `dash-config.mjs`) shared by browser and node, plus the node-only dev API
  (`dash-api.js`), the terminal PTY bridge (`terminal.js`), the agent runners
  (`agents.mjs`), and the code/workspace backends (`code-browser.mjs`,
  `workspace-env.mjs`).
- **`bin/dash.mjs`** — the production server: a plain Node `http` server that
  serves the built `dist/` and mounts the same backend and terminal websocket.
- **`vite.config.js`** — dev server and build. Injects the browser Supabase config
  via `define` (the service key is deliberately excluded).

## License

MIT © 2026 Dennis Hansen
