#!/usr/bin/env node
// spawn-issue: file a tracked issue (if it doesn't exist yet) and AUTONOMOUSLY
// launch its dashboard chat — the agent equivalent of pressing "create worktree
// and start the agent" on the kanban card AND sending that session off to
// execute. Open the card any time afterward to monitor / unblock the live chat.
//
//   make-issue-and-run  ──▶  worktree + reserved port + linked agent session,
//                            already implementing the issue end-to-end.
//
// Why it routes through the dash server (not a standalone agent spawn): the PTY
// must live in the dash server's in-process `chats` map so that when the human
// later opens the card, the browser REATTACHES to this same process instead of
// resuming a second one onto the same session id. A detached spawn would
// collide. So this CLI is machine-local: it requires the dash dev server to be
// running (default http://localhost:5173) and POSTs the autonomous chat to it.
//
// Usage:
//   spawn-issue.mjs <id> [--title "..."] [--body "..."] [--tags a,b]
//                        [--bug] [--agent claude|codex] [--prompt "..."]
//                        [--model M] [--effort E] [--base http://localhost:5173]
//
//   --bug      run the /bug flow (reproduce → fix) instead of the /change flow.
//   --agent    which agent to launch: claude (default) or codex.
//   --prompt   override the autonomous intro entirely (advanced).
//   --title    required only when <id> doesn't exist yet (creates the row).
//   --model    model for the spawned agent (default claude-opus-4-8 for claude;
//              codex uses its own configured default unless --model is passed).
//   --effort   reasoning effort for claude (default max; ignored for codex).
//   --base     dash server origin (default http://localhost:5173, or $DASH_BASE_URL).

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
const id = args._[0];
if (!id) die('usage: spawn-issue.mjs <id> [--title "..."] [--bug] [--prompt "..."] [--base URL]');
const base = (args.base || BASE_DEFAULT).replace(/\/$/, '');
const flow = args.bug ? 'bug' : 'change';
const agent = args.agent === 'codex' ? 'codex' : 'claude';
if (args.agent && args.agent !== 'claude' && args.agent !== 'codex') die(`unknown --agent "${args.agent}" (claude | codex)`);
// Kicked-off claude agents run Opus 4.8 at max effort unless overridden — pinned
// explicitly so they don't ride whatever the user's interactive default happens
// to be. Codex rides its own configured default unless --model is passed.
const model = args.model || (agent === 'codex' ? undefined : 'claude-opus-4-8');
const effort = args.effort || (agent === 'codex' ? undefined : 'max');

// 1. The dash server must be up — the autonomous PTY can only live in its
//    in-process chats map. Probe /api/dash (same shape capabilities.js uses).
try {
  const r = await fetch(`${base}/api/dash`, { method: 'GET' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body?.ok) throw new Error(`unexpected response ${r.status}`);
} catch (e) {
  die(`dash server not reachable at ${base} (${e.message}). Start the dash dev server first (npm run dev), or pass --base.`);
}

// 2. Create the issue row if it doesn't exist yet (needs --title to mint one).
await import('../server/node-env.mjs'); // DASH_SUPABASE_SERVICE_KEY, before issues-store reads env
const { get, create, setStatus } = await import('../server/issues-store.mjs');
const existing = await get(id).catch(() => null);
if (!existing) {
  if (!args.title) die(`issue "${id}" doesn't exist — pass --title to create it.`);
  const issue = { id, title: args.title };
  if (args.tags) issue.tags = String(args.tags).split(',').map(s => s.trim()).filter(Boolean);
  if (args.body) issue.body = args.body;
  const c = await create(issue);
  if (c.error) die(`create failed: ${c.error}`);
  console.log(`created issue ${id}`);
}

// 3. Fire the autonomous chat: worktree + port + linked session + server-side PTY.
//    The server links the session to the issue's conversations[] and moves the
//    card to in-progress as part of the spawn.
const res = await fetch(`${base}/api/dash/terminal/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ issue: id, autonomous: true, flow, agent, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(args.prompt ? { prompt: args.prompt } : {}) }),
});
const out = await res.json().catch(() => ({}));
if (!res.ok || !out?.ok) die(`spawn failed (${res.status}): ${out?.error || 'unknown error'}`);

// Kicking off IS starting work: move the card to in-progress now, so the kanban
// reflects the running agent immediately (the session itself was already linked
// to conversations[] by the server).
const st = await setStatus(id, 'in-progress');
if (st?.error) console.error(`warning: could not move ${id} to in-progress: ${st.error}`);

console.log(`launched ${agent} ${flow} chat on ${id} → in-progress`);
console.log(`  session : ${out.sessionId}`);
console.log(`  worktree: ${out.dir}`);
if (out.port != null) console.log(`  preview : ${base}/api/dash/terminal/${encodeURIComponent(id)}/open  (port ${out.port})`);
console.log(`  monitor : open the "${id}" card in the dash to watch it live`);
