# Dash

A self-hostable **kanban board** with a built-in **browser terminal**, backed by
your own [Supabase](https://supabase.com) project. The board is a live,
multiplayer Supabase app: cards are Postgres rows, drag-and-drop reordering runs
as atomic server-side functions, and updates stream to every open tab over
Supabase Realtime. Sign-in is email one-time-code, gated to an allow-list you
control.

It also ships some optional "lab" views (a metrics dashboard, a corpus gallery,
hypotheses, and a `claude`-style terminal per card) that came from the project
this was extracted out of. Those need extra setup and a local machine — see
[Which features need what](#which-features-need-what).

> Bring your own Supabase. Nothing here is hardcoded to any project — you point
> it at yours with three env vars.

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

Set these in `.env` / `.env.local` (git-ignored) or in the real environment. The
browser values are injected at **build time**, so re-run `npm run build` after
changing them.

## Which features need what

The board is designed so the core works from anywhere, while machine-specific
features light up only when the local backend is running (probed once at boot via
`/api/dash`; see `src/capabilities.js`).

**Work from the static board (Supabase-direct, no local backend required):**

- The full kanban board: create, rename, drag/reorder, move between columns,
  delete cards, edit card bodies.
- Live realtime updates across tabs/users.
- Email OTP sign-in + the allow-list gate.

**Need the local backend running (`npm start` / `npm run dev` on your machine):**

- **Browser terminal** per card — requires the optional native dependency
  `node-pty`. Spawns a real shell/CLI; this is powerful and machine-specific.
- **Metrics dashboard** — reads a `metric_runs` table you'd populate yourself.
- **Corpus gallery / session recordings** — read from Supabase Storage buckets
  (`corpus-gifs`, `corpus-sessions`) you'd create and fill.
- **Hypotheses / tests / git-worktree** views — these came from the original
  research-lab app and assume a specific repo layout + tooling. They render a
  "not on this machine" guard when the backend or those assets are absent.

If all you want is a clean, self-hosted, realtime kanban, you can ignore the lab
views entirely — they degrade gracefully.

## How it works

- **`src/`** — the React app (Vite, HashRouter). `board-store.js` talks to
  Supabase's REST API directly from the browser; `realtime.js` hand-rolls the
  Supabase Realtime websocket; `auth.js` does email-OTP against GoTrue. No
  `@supabase/supabase-js` — it's plain `fetch`, so the client stays tiny.
- **`server/`** — isomorphic Supabase modules (`issues-store.mjs`,
  `dash-config.mjs`) shared by browser and node, plus the node-only dev API
  (`dash-api.js`) and the terminal PTY bridge (`terminal.js`).
- **`bin/dash.mjs`** — the production server: a plain Node `http` server that
  serves the built `dist/` and mounts the same backend + terminal websocket.
- **`vite.config.js`** — dev server + build. Injects the browser Supabase config
  via `define` (service key deliberately excluded).

## License

MIT © 2026 Dennis Hansen
