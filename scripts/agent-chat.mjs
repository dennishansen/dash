#!/usr/bin/env node
// agent-chat: talk to another agent's dashboard chat — the communication half
// of spawn-issue. spawn-issue launches a chat; this reads it and writes to it,
// in both directions, so two agents can hold a dialog a human can watch live
// on the dash.
//
//   list <issue>                          → the issue's chats (session ids, live/resumable)
//   read <session> [--after N] [--wait [S]] [--json]
//                                         → the chat's spoken turns; --after polls
//                                           incrementally from a previous cursor;
//                                           --wait blocks until a NEW message lands
//   send <issue> <session> "message" [--plain]
//                                         → deliver a message into the chat. By
//                                           default the message is wrapped in an
//                                           envelope naming YOUR coordinates and the
//                                           literal reply command, so the receiver
//                                           can answer without knowing this tool.
//
// Sender coordinates for the envelope come from the environment: your session id
// is $CLAUDE_CODE_SESSION_ID, your issue is the worktree you're in
// (.claude/worktrees/<issue>). Outside a worktree (e.g. the main chat) the
// envelope says you aren't directly addressable — the receiver just replies in
// its own chat and you poll it with `read --after <cursor> --wait`.
//
// Machine-local like spawn-issue: goes through the dash dev server, which owns
// the live PTYs. Delivery routes (server-side): live PTY → paste+Enter (a busy
// chat queues it); dead chat → resumed with the message as its first turn.

import { fileURLToPath } from 'url';

const BASE_DEFAULT = process.env.DASH_BASE_URL || 'http://localhost:5173';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; }
    else { args[key] = next; i++; }
  }
  return args;
}

function die(msg, code = 1) { console.error(msg); process.exit(code); }

const args = parseArgs(process.argv);
const cmd = args._[0];
const base = (args.base || BASE_DEFAULT).replace(/\/$/, '');

async function api(path, init) {
  let res;
  try { res = await fetch(`${base}${path}`, init); }
  catch (e) { die(`dash server not reachable at ${base} (${e.message}). Start the dash dev server first, or pass --base.`); }
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

// Your own coordinates, for the reply envelope. Issue = the worktree this
// process runs in; session = the agent session running this command.
function selfCoords() {
  const session = process.env.CLAUDE_CODE_SESSION_ID || null;
  const m = process.cwd().match(/\.claude\/worktrees\/([^/]+)/);
  return { issue: m ? m[1] : null, session };
}

function envelope(text) {
  const { issue, session } = selfCoords();
  if (issue && session) {
    // The reply command pins --base to the server THIS send went through (live
    // PTYs exist per-server-process — a different server would resume-fork a
    // session that's live here) and names this CLI by ABSOLUTE path: the
    // receiver's cwd is its own worktree, which may not carry this script at
    // all (e.g. branched off main before it landed). Everything here is
    // machine-local, so the sender's copy is the one guaranteed to exist.
    const cliPath = fileURLToPath(import.meta.url);
    return `[agent-msg from ${issue}/${session}] ${text}\n\n(Message from another agent. Reply with: node ${cliPath} send ${issue} ${session} "<your reply>" --base ${base} — it lands in their chat as a user turn.)`;
  }
  return `[agent-msg] ${text}\n\n(Message from another agent that isn't directly addressable — it is polling this chat's transcript, so just answer here.)`;
}

function printMessages(messages) {
  for (const m of messages) {
    console.log(`\n[${m.role}${m.timestamp ? ' ' + m.timestamp : ''}]`);
    console.log(m.text);
  }
}

if (cmd === 'list') {
  const issue = args._[1];
  if (!issue) die('usage: agent-chat.mjs list <issue>');
  const { res, body } = await api(`/api/dash/terminal/chats?issue=${encodeURIComponent(issue)}`);
  if (!res.ok) die(`list failed (${res.status}): ${body?.error || 'unknown error'}`);
  if (args.json) { console.log(JSON.stringify(body, null, 2)); process.exit(0); }
  console.log(`${issue} — worktree: ${body.worktree ? body.dir : 'none'}${body.port != null ? `, port ${body.port}` : ''}`);
  if (!body.chats?.length) console.log('  (no chats)');
  for (const c of body.chats || []) {
    console.log(`  ${c.sessionId}  ${c.live ? 'LIVE' : c.resumable ? 'resumable' : 'unreachable'}`);
  }
  process.exit(0);
}

if (cmd === 'read') {
  const session = args._[1];
  if (!session) die('usage: agent-chat.mjs read <session> [--after N] [--wait [seconds]] [--json]');
  let after = Math.max(0, parseInt(args.after || '0', 10) || 0);
  const waitSecs = args.wait === true ? 120 : args.wait ? parseInt(args.wait, 10) : 0;
  const deadline = Date.now() + waitSecs * 1000;

  for (;;) {
    const { res, body } = await api(`/api/dash/terminal/transcript?session=${encodeURIComponent(session)}&after=${after}`);
    // A 404 under --wait is usually a freshly-spawned chat that hasn't written
    // its first transcript line yet — keep polling instead of dying.
    if (!res.ok && !(res.status === 404 && waitSecs)) die(`read failed (${res.status}): ${body?.error || 'unknown error'}`);
    // --wait means "wake when the chat SAYS something new": only an assistant
    // turn satisfies it. New user turns alone (e.g. your own just-sent message
    // being written into the transcript) keep the wait alive — otherwise a
    // sender polling for the reply wakes on its own echo.
    const satisfied = waitSecs ? body.messages?.some(m => m.role === 'assistant') : true;
    if (res.ok && satisfied) {
      if (args.json) { console.log(JSON.stringify(body, null, 2)); process.exit(0); }
      printMessages(body.messages);
      console.log(`\n-- ${body.messages.length} message(s), live: ${body.live}, cursor: ${body.cursor} (poll with --after ${body.cursor})`);
      process.exit(0);
    }
    if (Date.now() > deadline) die(`timed out after ${waitSecs}s waiting for an assistant reply (cursor ${body?.cursor ?? after})`, 2);
    await new Promise(r => setTimeout(r, 3000));
  }
}

if (cmd === 'send') {
  const [, issue, session, ...rest] = args._;
  const text = rest.join(' ');
  if (!issue || !session || !text) die('usage: agent-chat.mjs send <issue> <session> "message" [--plain]');
  const payload = args.plain ? text : envelope(text);
  const { res, body } = await api('/api/dash/terminal/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ issue, session, text: payload }),
  });
  if (!res.ok || !body?.ok) die(`send failed (${res.status}): ${body?.error || 'unknown error'}`);
  console.log(`delivered via ${body.delivered} to ${issue}/${session}`);
  // The server returns the transcript cursor at delivery — waiting from there
  // skips all prior history, and --wait itself ignores your own echoed turn.
  console.log(`await the reply: node scripts/agent-chat.mjs read ${session} --after ${body.cursor ?? 0} --wait --base ${base}`);
  process.exit(0);
}

die('usage: agent-chat.mjs <list|read|send> …  (see file header for details)');
