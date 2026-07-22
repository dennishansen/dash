-- Dash — Supabase schema.
--
-- Run this ONCE against your own Supabase project (SQL Editor → paste → Run,
-- or `psql` against the project's connection string). It creates everything the
-- app needs: the `issues` table (the kanban's single source of truth), the two
-- board RPCs used for atomic reordering/moving, the email allow-list + its RLS
-- gate, and the Realtime publication for live board updates.
--
-- Security model (mirrors the app code):
--   * The anon/publishable key only IDENTIFIES the project. On its own it can
--     read/write NOTHING once the RLS below is applied.
--   * A browser must sign in (email OTP) with an address present in
--     `dash_allowed_emails`. Its JWT is what RLS evaluates.
--   * Server-side writers (the CLI / dev middleware) use the SERVICE ROLE key,
--     which bypasses RLS entirely.
--
-- Some columns/tables reflect the app's original lab origins (branches,
-- sessions, commits, conversations, port). They are harmless for a general
-- kanban — cards just won't populate them. Comments flag the lab-specific ones.

-- ---------------------------------------------------------------------------
-- issues — every card is one row. Content + board slice live together.
-- ---------------------------------------------------------------------------
-- Column types are inferred from issues-shape.mjs (the row→card mapping) and the
-- PostgREST calls in issues-store.mjs:
--   * arrays are read/written as JSON arrays        → text[] columns
--   * `rank` is a numeric ordering within a column  → integer
--   * `port` is a reserved dev-server port or null  → integer, nullable
--   * `created` is a 'YYYY-MM-DD' string            → date
--   * updated_at / closed_at are timestamps
create table if not exists public.issues (
  id            text primary key,                 -- e.g. 'i-ab12cd' (app-generated)
  title         text not null default 'New issue',
  body          text not null default '',         -- markdown, fetched only on detail
  status        text not null default 'next',     -- kanban column (see CHECK below)
  rank          integer,                          -- order within a column (set by RPCs)
  owner         text,                             -- optional assignee, nullable

  -- Array fields. The app appends/removes de-duped values; empty array default.
  tags          text[] not null default '{}',
  branches      text[] not null default '{}',     -- lab: git branches linked to the card
  sessions      text[] not null default '{}',     -- lab: recorded session ids
  commits       text[] not null default '{}',     -- lab: linked commit shas
  conversations text[] not null default '{}',     -- linked chat/conversation ids

  -- Dependency edges (issue-deps). Both are text[] lists of issue ids and are
  -- INVERSES of each other: `A requires B` ⟺ `B unlocks A`. The invariant is
  -- maintained server-side by set_dep (below), never written directly.
  requires      text[] not null default '{}',     -- upstream: must land before this
  unlocks       text[] not null default '{}',     -- downstream: this enables once it lands

  -- Per-chat display names, keyed by full session uuid (see setChatName in
  -- issues-store.mjs). A blank name deletes the key, so {} means "no names".
  chat_names    jsonb not null default '{}'::jsonb,

  port          integer,                          -- lab: reserved dev-server port [5200-5299]

  created       date,                             -- 'YYYY-MM-DD' the card was created
  updated_at    timestamptz not null default now(),
  closed_at     timestamptz,                      -- set when it entered done/rejected

  -- The board's six columns. VALID_STATUS in issues-store.mjs is the source of
  -- truth; keep this list in sync if you add columns.
  constraint issues_status_check
    check (status in ('maybe', 'future', 'next', 'in-progress', 'done', 'rejected'))
);

-- Keep updated_at honest on every write (the card's "last touched").
create or replace function public.issues_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists issues_updated_at on public.issues;
create trigger issues_updated_at
  before update on public.issues
  for each row execute function public.issues_set_updated_at();

-- ---------------------------------------------------------------------------
-- set_ranks(p_ids) — reorder one column atomically.
-- ---------------------------------------------------------------------------
-- Called from issues-store.setRanks as rpc/set_ranks with body { p_ids: [...] }.
-- `p_ids` is the column's final ordering; each row's rank becomes its index in
-- the array (0..n). Status is untouched — reordering never changes a column.
-- Running it server-side renumbers the whole column with no rank collisions.
create or replace function public.set_ranks(p_ids text[])
returns void language plpgsql as $$
begin
  update public.issues i
     set rank = idx.ord - 1               -- 0-based rank matching the array order
    from (
      select unnest(p_ids) as id,
             generate_subscripts(p_ids, 1) as ord
    ) idx
   where i.id = idx.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- move_column(p_status, p_ids) — cross-column move + renumber, atomically.
-- ---------------------------------------------------------------------------
-- Called from issues-store.moveColumn as rpc/move_column with body
-- { p_status, p_ids }. `p_ids` is the target column's FINAL ordering (the
-- dragged card inserted at its drop slot). Every listed row gets status =
-- p_status and rank = its index (0..n), in one shot — atomic, collision-free.
create or replace function public.move_column(p_status text, p_ids text[])
returns void language plpgsql as $$
begin
  update public.issues i
     set status = p_status,
         rank   = idx.ord - 1
    from (
      select unnest(p_ids) as id,
             generate_subscripts(p_ids, 1) as ord
    ) idx
   where i.id = idx.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- set_dep(p_up, p_down, p_add) — add/remove ONE dependency edge, maintaining
-- the inverse in the same transaction.
-- ---------------------------------------------------------------------------
-- Called from issues-store.setDep as rpc/set_dep. The edge is directed
-- upstream→downstream: `p_up unlocks p_down` and equivalently `p_down requires
-- p_up`. The caller maps its verb to a direction (requires <id> <dep> → edge
-- dep→id; unlocks <id> <dep> → edge id→dep), so this function never branches on
-- which list — it always appends p_down to the up-row's `unlocks` and p_up to
-- the down-row's `requires`. Appends are de-duped; removal strips both sides. A
-- dangling p_down (no such row) simply no-ops the requires-side update — the
-- unlocks side still records it, so the id shows faintly rather than crashing.
-- Self-reference is refused. `p_table` exists for forward-compat; only the
-- board's `issues` table is served here.
create or replace function public.set_dep(
  p_up text, p_down text, p_add boolean, p_table text default 'issues'
) returns void language plpgsql as $$
begin
  if p_up = p_down then
    raise exception 'set_dep: self-reference (%)', p_up;
  end if;
  if p_table <> 'issues' then
    raise exception 'set_dep: unknown table %', p_table;
  end if;
  if p_add then
    update public.issues set unlocks  = (case when p_down = any(unlocks)  then unlocks  else array_append(unlocks,  p_down) end) where id = p_up;
    update public.issues set requires = (case when p_up   = any(requires) then requires else array_append(requires, p_up)   end) where id = p_down;
  else
    update public.issues set unlocks  = array_remove(unlocks,  p_down) where id = p_up;
    update public.issues set requires = array_remove(requires, p_up)   where id = p_down;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- prune_issue_deps — strip a deleted issue's id from every survivor's lists.
-- ---------------------------------------------------------------------------
-- Deleting an issue must remove its id from every other issue's requires/unlocks
-- or the survivors point at a ghost. A BEFORE DELETE trigger guarantees this on
-- EVERY delete path (UI double-opt-in, board.mjs rm, direct SQL), mirroring the
-- issues_updated_at trigger already on the table.
create or replace function public.prune_issue_deps() returns trigger language plpgsql as $$
begin
  update public.issues
     set requires = array_remove(requires, old.id),
         unlocks  = array_remove(unlocks,  old.id)
   where old.id = any(requires) or old.id = any(unlocks);
  return old;
end;
$$;

drop trigger if exists trg_issue_prune_deps on public.issues;
create trigger trg_issue_prune_deps before delete on public.issues
  for each row execute function public.prune_issue_deps();

-- ---------------------------------------------------------------------------
-- dash_allowed_emails — the sign-in allow-list.
-- ---------------------------------------------------------------------------
-- Only emails present here may access the board. Add your own address before
-- signing in, e.g.:  insert into public.dash_allowed_emails (email) values
-- ('you@example.com');
create table if not exists public.dash_allowed_emails (
  email text primary key
);

-- dash_email_allowed() — SECURITY DEFINER check used by auth.js at sign-in.
-- Answers "is the currently signed-in user's email on the allow-list?" It reads
-- the JWT email claim, so it evaluates for the calling session. SECURITY DEFINER
-- lets it read dash_allowed_emails regardless of that table's own RLS.
create or replace function public.dash_email_allowed()
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from public.dash_allowed_emails
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- ---------------------------------------------------------------------------
-- Row-Level Security — the whole point of the "safe to serve publicly" claim.
-- ---------------------------------------------------------------------------
alter table public.issues enable row level security;
alter table public.dash_allowed_emails enable row level security;

-- issues: full access ONLY for authenticated sessions whose email is on the
-- allow-list. The anon key alone matches nothing here. The service role bypasses
-- RLS entirely (that's how the server-side writers keep working).
drop policy if exists issues_allowed_emails on public.issues;
create policy issues_allowed_emails on public.issues
  for all
  to authenticated
  using (public.dash_email_allowed())
  with check (public.dash_email_allowed());

-- dash_allowed_emails: no client policies → the anon/authenticated keys can't
-- read or edit the list from the browser. Manage it via the SQL editor or the
-- service role. (dash_email_allowed() reads it via SECURITY DEFINER.)

-- ---------------------------------------------------------------------------
-- Realtime — live board updates (dash/src/realtime.js subscribes to changes).
-- ---------------------------------------------------------------------------
-- Add public.issues to the supabase_realtime publication so INSERT/UPDATE/DELETE
-- stream over the Realtime websocket. RLS still applies to the stream: only an
-- allow-listed authenticated socket receives rows.
do $$
begin
  if not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    create publication supabase_realtime;
  end if;
end $$;

alter publication supabase_realtime add table public.issues;

-- For an EXISTING install upgrading to the chat-rename feature, add the column
-- the board list now selects (fresh installs already have it from the table
-- definition above). Safe to run repeatedly.
alter table public.issues add column if not exists chat_names jsonb not null default '{}'::jsonb;

-- ===========================================================================
-- People / profiles / avatars.
-- ===========================================================================
-- Who owns a card. `issues.owner` holds a person's EMAIL (the same key sign-in
-- and the allow-list use). Three pieces, deliberately separate:
--   dash_allowed_emails  the team — already the access gate, now also the roster
--   dash_profiles        what a person LOOKS like (name, picture). Grants nothing.
--   dash_people          the join the browser reads: ONE fetch per session,
--                        shared by every card, so an avatar is never its own request.
-- The card avatar joins owner→dash_people by email in the browser; an owner that
-- isn't a teammate simply shows no avatar (there is deliberately NO hard FK on
-- issues.owner, so a plain kanban can still use free-text owners).

-- A person's look. `email` is the primary key and cascades from the allow-list,
-- so removing someone from the team removes their profile. `avatar_scope` is a
-- random per-person storage folder assigned ONCE on insert and frozen on update
-- (see the trigger) — so nothing is derived from an address that can move, and a
-- client can never claim a teammate's folder. `avatar_key` is content-addressed
-- (`<scope>/<sha256>.<ext>`); the CHECK pins it to THIS row's scope in canonical
-- shape, so a row can only ever point at its own folder.
create table if not exists public.dash_profiles (
  email        text primary key
                 references public.dash_allowed_emails(email)
                 on update cascade on delete cascade,
  display_name text,
  avatar_key   text,
  avatar_scope text not null default gen_random_uuid()::text,
  updated_at   timestamptz not null default now(),
  constraint dash_profiles_avatar_key_shape check (
    avatar_key is null
    or avatar_key ~ ('^' || avatar_scope || '/[0-9a-f]{32}\.(png|jpg|webp|gif)$')
  )
);

-- avatar_scope is assigned once and never changes; keep updated_at honest too.
create or replace function public.dash_profiles_freeze_scope()
returns trigger language plpgsql as $$
begin
  new.avatar_scope := old.avatar_scope;   -- ignore any client-supplied scope
  new.updated_at   := now();
  return new;
end;
$$;
drop trigger if exists dash_profiles_freeze on public.dash_profiles;
create trigger dash_profiles_freeze
  before update on public.dash_profiles
  for each row execute function public.dash_profiles_freeze_scope();

-- The roster the browser reads (server/profiles-store.mjs listPeople). A LEFT
-- join, so an allow-listed teammate who has never opened their profile still
-- appears (with no picture). A SECURITY DEFINER view (default) so it can read
-- the allow-list, gated by dash_email_allowed() so ONLY an allow-listed caller
-- gets rows — a signed-out or non-member session sees an empty roster.
create or replace view public.dash_people as
  select a.email, p.display_name, p.avatar_key, p.avatar_scope, p.updated_at
  from public.dash_allowed_emails a
  left join public.dash_profiles p on p.email = a.email
  where public.dash_email_allowed();
grant select on public.dash_people to authenticated;

-- Profiles RLS: an allow-listed member may READ every profile (decoration is
-- shared and grants nothing) but WRITE only their own row.
alter table public.dash_profiles enable row level security;
drop policy if exists dash_profiles_read on public.dash_profiles;
create policy dash_profiles_read on public.dash_profiles
  for select to authenticated
  using (public.dash_email_allowed());
drop policy if exists dash_profiles_insert_self on public.dash_profiles;
create policy dash_profiles_insert_self on public.dash_profiles
  for insert to authenticated
  with check (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));
drop policy if exists dash_profiles_update_self on public.dash_profiles;
create policy dash_profiles_update_self on public.dash_profiles
  for update to authenticated
  using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')))
  with check (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));
-- No delete policy → only the service role can drop a profile row.

-- ---------------------------------------------------------------------------
-- Avatar storage — a public-read but UNLISTABLE bucket at
-- `<avatar_scope>/<sha256>.<ext>`. Pictures are world-readable by URL (an avatar
-- on a public board must load), but the bucket cannot be listed and a member can
-- write only inside their OWN folder.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dash-avatars', 'dash-avatars', true, 2097152,
        array['image/png','image/jpeg','image/webp','image/gif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- The caller's own storage folder, read from their profile by JWT email. Used by
-- the storage policies so "my folder" is looked up server-side, never trusted
-- from the request path.
create or replace function public.dash_avatar_scope()
returns text language sql security definer stable as $$
  select avatar_scope from public.dash_profiles
  where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

-- INSERT / DELETE only inside your own scope folder; no SELECT policy at all, so
-- the bucket cannot be listed (public downloads go through the unauthenticated
-- public path, which needs no select policy). Public read is the bucket flag above.
drop policy if exists dash_avatars_insert_own on storage.objects;
create policy dash_avatars_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'dash-avatars'
    and public.dash_email_allowed()
    and (storage.foldername(name))[1] = public.dash_avatar_scope()
  );
drop policy if exists dash_avatars_delete_own on storage.objects;
create policy dash_avatars_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'dash-avatars'
    and (storage.foldername(name))[1] = public.dash_avatar_scope()
  );

-- ===========================================================================
-- OPTIONAL — corpus / metrics features (lab-origin, safe to skip).
-- ===========================================================================
-- These back the "Dashboard" trend view and the corpus gallery. They are only
-- needed if you use those lab-specific features; the kanban board works without
-- them. See dash/server/corpus-remote.mjs.
--
-- metric_runs — per-commit metric snapshots the Dashboard sparklines read
-- (rpc: GET /rest/v1/metric_runs?select=*&order=date.asc). Columns beyond
-- `date` are open-ended (the UI just charts numeric fields), so this is a
-- permissive shape. Read with the anon key (public-read).
create table if not exists public.metric_runs (
  id     bigint generated always as identity primary key,
  date   timestamptz not null default now(),
  commit text,
  data   jsonb not null default '{}'::jsonb
);
alter table public.metric_runs enable row level security;
drop policy if exists metric_runs_public_read on public.metric_runs;
create policy metric_runs_public_read on public.metric_runs
  for select to anon, authenticated using (true);

-- Storage buckets for the corpus gallery / session recordings (public-read,
-- service-write). Uncomment if you use those features:
--   insert into storage.buckets (id, name, public) values
--     ('corpus-gifs', 'corpus-gifs', true),
--     ('corpus-sessions', 'corpus-sessions', true)
--   on conflict (id) do nothing;
