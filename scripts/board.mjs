#!/usr/bin/env node
// board.mjs — read/write the kanban (Supabase `issues`). One row per issue:
// content (title, body, tags, sessions, branches, commits, created) AND
// board slice (status column, rank, owner) live together. This is the single
// source of truth; the /issue, /change, and /merge skills (and you, by hand)
// use this CLI to read and change the board without a running Dash server.
//
// Writes authenticate as the Supabase service role (RLS on `issues` is locked
// to authenticated + allow-listed emails; the service key bypasses it), so
// DASH_SUPABASE_SERVICE_KEY must be set — see .env.example. Pure online, no
// offline fallback.
//
// Usage:
//   board.mjs list [--status next] [--tag <tag>]
//   board.mjs get <id>                              # full row (incl. body) as JSON
//   board.mjs new <id> --title "..." [--tags a,b] [--sessions h1,h2]
//            [--branches b1] [--created YYYY-MM-DD] [--status next]
//            [--body "..." | --body-file path]      # create an issue
//   board.mjs body <id> (--body "..." | --body-file path)   # replace body
//   board.mjs title <id> <new title>
//   board.mjs status <id> <maybe|future|next|in-progress|done|rejected>
//   board.mjs start  <id>                           # → in-progress + link this convo
//   board.mjs done   <id> [<id>...]                 # /merge convenience (also frees the dev-server port)
//   board.mjs reject <id> [<id>...]                 # (also frees the dev-server port)
//   board.mjs free-port <id> [<id>...]              # release the reserved dev-server port
//   board.mjs owner  <id> <name|->                  # '-' clears the owner
//   board.mjs tag     <id> <tag> [<tag>...]         # append tags (de-duped)
//   board.mjs session <id> <hex> [<hex>...]         # append sessions
//   board.mjs convo   <id> <id> [<id>...]           # append conversation ids
//   board.mjs branch  <id> <name> [<name>...]       # append branches
//   board.mjs commit  <id> <sha> [<sha>...]         # append commit SHAs (/merge)
//   board.mjs untag / unsession / unconvo / unbranch / uncommit  <id> <value>...
//   board.mjs find-branch <branch>                  # ids whose branches[] has it
//   board.mjs rm <id>                               # delete an issue
//
// New issues default to the `next` column. See docs/dashboard.md for the schema.

import fs from 'fs';
// Load DASH_SUPABASE_SERVICE_KEY from .env.local BEFORE issues-store reads it, so
// board writes authenticate as the service role.
import '../server/node-env.mjs';
import {
  listAll, get, create, update, appendToArray, removeFromArray,
  setStatus, setOwner, remove, exists, VALID_STATUS,
} from '../server/issues-store.mjs';
import { freePort } from '../server/ports.mjs';

const [cmd, ...rest] = process.argv.slice(2);

function flag(name) {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : null;
}
function csv(v) { return v ? v.split(',').map(s => s.trim()).filter(Boolean) : undefined; }
function fail(msg) { console.error(msg); process.exit(1); }

function readBody() {
  const inline = flag('body');
  if (inline != null) return inline;
  const file = flag('body-file');
  if (file) return fs.readFileSync(file, 'utf8');
  return null;
}


async function main() {
  switch (cmd) {
    case 'list': {
      const wantStatus = flag('status');
      const wantTag = flag('tag');
      let rows = await listAll();
      if (wantStatus) rows = rows.filter(r => r.status === wantStatus);
      if (wantTag) rows = rows.filter(r => (r.tags || []).includes(wantTag));
      rows.sort((a, b) => a.status.localeCompare(b.status)
        || ((a.rank ?? 1e9) - (b.rank ?? 1e9))
        || a.id.localeCompare(b.id));
      for (const r of rows) {
        const owner = r.owner ? ` @${r.owner}` : '';
        const ord = r.rank != null ? `#${r.rank}` : '  ';
        console.log(`${r.status.padEnd(8)} ${ord.padStart(4)}${owner}  ${r.id}  —  ${r.title}`);
      }
      console.log(`\n${rows.length} issue(s)`);
      break;
    }
    case 'get': {
      const id = rest[0];
      if (!id) fail('usage: board.mjs get <id>');
      const row = await get(id);
      if (!row) fail(`no issue "${id}"`);
      console.log(JSON.stringify(row, null, 2));
      break;
    }
    case 'new': {
      const id = rest[0];
      const title = flag('title');
      if (!id || id.startsWith('--')) fail('usage: board.mjs new <id> --title "..." [...]');
      if (!title) fail('new requires --title');
      if (await exists(id)) fail(`issue "${id}" already exists — pick a unique id`);
      const status = flag('status');
      if (status && !VALID_STATUS.has(status)) fail(`invalid status "${status}"`);
      const issue = { id, title };
      const tags = csv(flag('tags')); if (tags) issue.tags = tags;
      const sessions = csv(flag('sessions')); if (sessions) issue.sessions = sessions;
      const branches = csv(flag('branches')); if (branches) issue.branches = branches;
      if (flag('created')) issue.created = flag('created');
      if (status) issue.status = status;
      const body = readBody(); if (body != null) issue.body = body;
      const r = await create(issue);
      if (r.error) fail(`ERROR: ${r.error}`);
      console.log(`created ${id} (${status || 'next'})`);
      break;
    }
    case 'body': {
      const id = rest[0];
      if (!id || id.startsWith('--')) fail('usage: board.mjs body <id> (--body "..." | --body-file path)');
      const body = readBody();
      if (body == null) fail('body requires --body or --body-file');
      if (!(await exists(id))) fail(`no issue "${id}"`);
      await update(id, { body });
      console.log(`${id} body updated (${body.length} chars)`);
      break;
    }
    case 'title': {
      const id = rest[0];
      const title = rest.slice(1).filter(a => !a.startsWith('--')).join(' ');
      if (!id || !title) fail('usage: board.mjs title <id> <new title>');
      if (!(await exists(id))) fail(`no issue "${id}"`);
      await update(id, { title });
      console.log(`${id} title → ${title}`);
      break;
    }
    case 'status': {
      const [id, status] = rest;
      if (!id || !status) fail('usage: board.mjs status <id> <status>');
      if (!VALID_STATUS.has(status)) fail(`invalid status "${status}" (one of ${[...VALID_STATUS].join('|')})`);
      const r = await setStatus(id, status);
      console.log(r.error ? `ERROR: ${r.error}` : `${id} → ${status}`);
      if (r.error) process.exit(1);
      break;
    }
    case 'start': {
      // Work has begun on this issue: move it to the in-progress column and
      // link the current agent conversation (deterministic, from the env var —
      // multiple convos accrue as different sessions touch the issue).
      const id = rest[0];
      if (!id || id.startsWith('--')) fail('usage: board.mjs start <id>');
      if (!(await exists(id))) fail(`no issue "${id}"`);
      const r = await setStatus(id, 'in-progress');
      if (r.error) fail(`ERROR: ${r.error}`);
      const convo = process.env.CLAUDE_CODE_SESSION_ID;
      if (convo) await appendToArray(id, 'conversations', [convo]);
      console.log(`${id} → in-progress${convo ? ` (convo ${convo})` : ' (no CLAUDE_CODE_SESSION_ID in env)'}`);
      break;
    }
    case 'done':
    case 'reject': {
      // Landing or rejecting an issue ends its active life, so its reserved
      // dev-server port is released back to the pool here. freePort tears down
      // any listener still on the port (the issue's dev server, or a zombie)
      // before clearing the registry entry — so a freed port is really free.
      const status = cmd === 'done' ? 'done' : 'rejected';
      const ids = rest.filter(a => !a.startsWith('--'));
      if (ids.length === 0) fail(`usage: board.mjs ${cmd} <id> [<id>...]`);
      for (const id of ids) {
        const r = await setStatus(id, status);
        if (r.error) { console.log(`ERROR ${id}: ${r.error}`); continue; }
        const fp = await freePort(id);
        if (fp.error) { console.log(`${id} → ${status} — ERROR freeing port: ${fp.error}`); continue; }
        const freed = fp.freed != null
          ? ` (freed port ${fp.freed}${fp.killed ? `, killed ${fp.killed} listener${fp.killed > 1 ? 's' : ''}` : ''})`
          : '';
        console.log(`${id} → ${status}${freed}`);
      }
      break;
    }
    case 'free-port': {
      const ids = rest.filter(a => !a.startsWith('--'));
      if (ids.length === 0) fail('usage: board.mjs free-port <id> [<id>...]');
      for (const id of ids) {
        const r = await freePort(id);
        console.log(r.error ? `ERROR ${id}: ${r.error}`
          : `${id} port freed${r.freed != null ? ` (${r.freed}${r.killed ? `, killed ${r.killed} listener${r.killed > 1 ? 's' : ''}` : ''})` : ' (was already free)'}`);
      }
      break;
    }
    case 'owner': {
      const [id, owner] = rest;
      if (!id) fail('usage: board.mjs owner <id> <name|->');
      const r = await setOwner(id, owner === '-' ? null : owner);
      console.log(`${id} owner → ${r.owner ?? '(none)'}`);
      break;
    }
    case 'tag':
    case 'session':
    case 'convo':
    case 'branch':
    case 'commit': {
      const field = { tag: 'tags', session: 'sessions', convo: 'conversations', branch: 'branches', commit: 'commits' }[cmd];
      const [id, ...vals] = rest.filter(a => !a.startsWith('--'));
      if (!id || vals.length === 0) fail(`usage: board.mjs ${cmd} <id> <value> [<value>...]`);
      const r = await appendToArray(id, field, vals);
      if (r.error) fail(`ERROR: ${r.error}`);
      console.log(`${id} ${field} += ${vals.join(', ')}`);
      break;
    }
    case 'untag':
    case 'unsession':
    case 'unconvo':
    case 'unbranch':
    case 'uncommit': {
      const field = { untag: 'tags', unsession: 'sessions', unconvo: 'conversations', unbranch: 'branches', uncommit: 'commits' }[cmd];
      const [id, ...vals] = rest.filter(a => !a.startsWith('--'));
      if (!id || vals.length === 0) fail(`usage: board.mjs ${cmd} <id> <value> [<value>...]`);
      const r = await removeFromArray(id, field, vals);
      if (r.error) fail(`ERROR: ${r.error}`);
      console.log(`${id} ${field} -= ${vals.join(', ')}`);
      break;
    }
    case 'find-branch': {
      const branch = rest[0];
      if (!branch) fail('usage: board.mjs find-branch <branch>');
      const rows = await listAll();
      const hits = rows.filter(r => (r.branches || []).includes(branch)).map(r => r.id);
      for (const id of hits) console.log(id);
      break;
    }
    case 'rm': {
      const id = rest[0];
      if (!id) fail('usage: board.mjs rm <id>');
      await remove(id);
      console.log(`removed ${id}`);
      break;
    }
    default:
      fail(`unknown command "${cmd || ''}". Run with no args for usage:\n` +
        'list | get | new | body | title | status | start | done | reject | free-port | owner | tag | session | convo | branch | commit | untag | unsession | unconvo | unbranch | uncommit | find-branch | rm');
  }
}

main().catch(e => fail(e.message));
