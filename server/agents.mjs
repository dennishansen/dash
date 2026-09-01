// Agent adapters — the per-CLI knowledge the dash needs to launch, resume, watch
// and read a chat, factored out of terminal.js so a chat is FIRST-CLASS in its
// agent type rather than hardwired to `claude`. Three agents today:
//
//   claude — Anthropic's `claude` CLI. The dash MINTS the session id (a uuid)
//            and passes it as `--session-id`; the transcript lands at
//            ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl.
//   codex  — OpenAI's `codex` CLI. Codex MINTS ITS OWN session id (there is no
//            flag to pre-specify one), so a NEW codex chat is spawn-then-
//            discover: we start it, then read the id back from the fresh rollout
//            it wrote under ~/.codex/sessions/**. Resume is `codex resume <id>`.
//   cursor — the Cursor editor. NOT LAUNCHABLE: it is a GUI app, not a CLI the
//            dash can put behind a PTY, so a Cursor chat is readable and never
//            runnable. It is also the only agent whose chats are DISCOVERED
//            rather than linked (see discoverChats) — Cursor records no issue,
//            but it does record the folder, and a folder IS an environment.
//
// `launchable` is the axis that separates them. Everything that spawns, resumes
// or probes a process reads it, so a non-launchable agent can never reach the
// picker, the availability probe or the liveness pgrep — while every READ path
// (turns, cwd, discovery) treats all three identically.
//
// A chat's agent rides IN its conversations[] entry as a prefix so it can never
// drift from the id: a bare uuid is claude (every pre-existing row keeps
// working), `codex:<uuid>` is codex. parseHandle/formatHandle are that codec.
//
// The uuid-keyed concurrency machinery in terminal.js (the live-chat registry,
// claim/tomb reclaim, PTY map) stays agent-AGNOSTIC — codex session ids are also
// uuids, so the same key space and the same single-owner guarantees cover both.
// Only the pieces that actually touch a specific CLI live here.

import os from 'os';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { run } from './proc.mjs';
import { repositoryLoc } from './code-browser.mjs';
import {
  cursorPresent, cursorDbPath, isComposerId, listComposers,
  composerHead, composerBubbles, composerUpdatedAt,
} from './cursor-db.mjs';

// --- chat-status: live context-window fill + LOC for one chat ---
// Both agents publish the SAME shape — { used, added, removed, compactAt?,
// compactExact? } — so the Dash ring/LOC badge read one contract regardless of
// which CLI is behind a chat. `used` is % of the context window filled;
// `compactAt` is the % at which that CLI auto-compacts (the ring's red line),
// carried in the payload so the client needn't hardcode a per-agent threshold;
// `compactExact` marks it as a read-back trigger rather than an estimate. claude
// forwards whatever its statusline published (the ring falls back to ~83.5% if a
// field is absent); codex derives its own from the rollout (see each adapter).
// `added`/`removed` are the lines this chat's BRANCH changed — both agents read
// them from git in the chat's working directory, so the badge always agrees with
// the file list next to it and survives the chat's process restarting.
//
// Codex auto-compacts at model_auto_compact_token_limit = context_window*9/10
// (codex-rs protocol.rs). Fed through codex's own display formula, that token
// point lands at exactly 90% used for every real window size — so the codex ring
// goes red at 90. Left as ~ (not exact) since a per-session config override isn't
// read back.
const CODEX_COMPACT_AT = 90;

// --- binary resolution (cached; sh -c, never a login shell — see terminal.js) ---
//
// "Not installed" is a REAL state, distinguishable from "resolved fine". This
// used to fall back to the bare command name on a miss, so a machine without the
// CLI looked identical to one with it right up until pty.spawn threw ENOENT into
// the terminal pane. Now a miss is `null`, and every caller has to decide what to
// do about it — which is what lets the UI say "Claude Code isn't installed on
// this computer" before the person commits to opening a chat.
//
// Two deterministic signals, no string matching: a value containing a slash is a
// PATH to test with access(X_OK); a bare name is resolved with `command -v`,
// which is the shell's own answer to "is this installed".
function executable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

// Resolved paths are cached (an installed binary doesn't move); MISSES are not,
// so installing the CLI while the dash is running is picked up on the next look
// rather than being remembered as absent for the life of the process.
const _binCache = {};
function resolveBin(name) {
  if (!name) return null;
  if (_binCache[name]) return _binCache[name];
  const found = name.includes('/')
    ? (executable(name) ? name : null)
    : ((spawnSync('sh', ['-c', `command -v -- "$1"`, 'sh', name], { encoding: 'utf8' }).stdout || '')
        .trim().split('\n')[0] || null);
  if (found) _binCache[name] = found;
  return found;
}

// --- reading a chat's spoken turns ---
//
// `readTurns(sessionId, after)` is the ONE read every agent answers, resolving
// to { messages:[{ i, role, text, timestamp }], cursor } or null when this agent
// has no such chat here. It is an ADAPTER method rather than something the
// caller does around parseTranscript because a transcript is not always a file:
// claude and codex append jsonl to disk, Cursor keeps rows in SQLite. The shared
// contract is the turns, not the bytes.
//
// `after` is the previous read's cursor, and `i` is a turn's stable position, so
// an incremental reader never re-receives what it already has.

// The read the two FILE-BACKED agents share: locate the transcript, then read
// it INCREMENTALLY. A transcript is an append-only jsonl log, and these reads
// are polled (the 20s mirror sweep over every changed chat, the 4s transcript
// view) on the same event loop that relays keystrokes — re-reading and
// re-parsing a multi-MB active transcript on every poll was a recurring
// hundreds-of-ms block per chat. So each path keeps a cursor: `bytes`/`lines`
// mark the parsed complete-line boundary, and `messages` accumulates the SPOKEN
// turns (tiny next to the raw jsonl), so any `after` is served from memory. An
// unchanged file costs one stat; growth costs only the appended bytes; a file
// that SHRANK (rewritten — e.g. /clear) resets and re-parses from zero. The
// boundary is tracked in BYTES on the raw buffer (multibyte-safe: it always
// lands just past a newline), while `lines`/`i` stay the line-index cursor the
// contract exposes.
const _turnsCache = new Map(); // transcript path → { bytes, lines, mtimeMs, size, messages }
// Two readers advancing one path's cursor concurrently (a transcript-view poll
// racing the mirror sweep) would each append the same chunk; serialize per path.
const _turnsInflight = new Map(); // transcript path → tail of the read chain

async function fileBackedTurns(adapter, sessionId, after) {
  const p = await adapter.findTranscript(sessionId);
  if (!p) return null;
  const job = (_turnsInflight.get(p) || Promise.resolve())
    .then(() => incrementalTurns(adapter, p, after));
  _turnsInflight.set(p, job.catch(() => {}));
  return job;
}

async function incrementalTurns(adapter, p, after) {
  let st;
  try { st = await fs.promises.stat(p); } catch { return null; }
  let c = _turnsCache.get(p);
  if (!c || st.size < c.bytes) c = { bytes: 0, lines: 0, mtimeMs: -1, size: -1, messages: [] };
  if (st.size !== c.size || st.mtimeMs !== c.mtimeMs) {
    let buf;
    try {
      const fh = await fs.promises.open(p, 'r');
      try {
        buf = Buffer.alloc(st.size - c.bytes);
        await fh.read(buf, 0, buf.length, c.bytes);
      } finally { await fh.close(); }
    } catch { return null; }
    const nl = buf.lastIndexOf(0x0A);
    if (nl >= 0) {
      const chunk = adapter.parseTranscript(buf.subarray(0, nl + 1).toString('utf8'), 0);
      const base = c.lines;
      c = {
        bytes: c.bytes + nl + 1,
        lines: base + chunk.cursor,
        mtimeMs: st.mtimeMs,
        size: st.size,
        messages: c.messages.concat(chunk.messages.map((m) => ({ ...m, i: m.i + base }))),
      };
    } else {
      // Only a mid-append fragment landed since last read — nothing complete to
      // consume; remember the stat so an unchanged file stays a single stat.
      c = { ...c, mtimeMs: st.mtimeMs, size: st.size };
    }
    _turnsCache.set(p, c);
  }
  return { messages: after > 0 ? c.messages.filter((m) => m.i >= after) : c.messages.slice(), cursor: c.lines };
}

// --- shared transcript cursor discipline ---
// A poll can catch the CLI MID-APPEND: the final line has no \n yet. Only
// COMPLETE lines participate, and the cursor never advances past a fragment, so
// the next poll re-reads it whole. `mapLine` turns one parsed jsonl object into
// { role, text } for a spoken turn, or null to skip (tool calls, meta, noise).
function parseLines(raw, after, mapLine) {
  const end = raw.lastIndexOf('\n');
  const lines = end < 0 ? [] : raw.slice(0, end).split('\n');
  const messages = [];
  for (let i = 0; i < lines.length; i++) {
    if (i < after || !lines[i]) continue;
    let o;
    try { o = JSON.parse(lines[i]); } catch { continue; }
    let m;
    try { m = mapLine(o); } catch { m = null; }
    if (!m || !m.text || !m.text.trim()) continue;
    messages.push({ i, role: m.role, text: m.text, timestamp: m.timestamp ?? o.timestamp ?? null });
  }
  return { messages, cursor: lines.length };
}

// Read the last `maxBytes` of a file (whole file if smaller). `atBOF` marks that
// the read reached byte 0, so a caller widening the window knows when to stop.
// Shared: two different tail scans (codex's token_count, both agents' last
// timestamp) need the same bounded read of a transcript that may be many MB.
async function readTail(fpath, maxBytes) {
  const fd = await fs.promises.open(fpath, 'r');
  try {
    const { size } = await fd.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    if (buf.length) await fd.read(buf, 0, buf.length, start);
    return { text: buf.toString('utf8'), atBOF: start === 0 };
  } finally { await fd.close(); }
}

// --- when a conversation last MOVED -----------------------------------------
// The timestamp on the last record that carries one, as epoch ms. Both
// file-backed agents stamp every jsonl record with a top-level ISO `timestamp`,
// so this is ONE reader for both — which is the whole reason codex can be dated
// exactly like claude rather than by a second, parallel rule.
//
// It exists because a transcript's MTIME is not the conversation's clock. A file
// can be rewritten in place — same inode, same size, not one new line — and on
// this machine that happens in bulk (164 of 273 transcripts had an mtime newer
// than their last message by over 20 minutes, several by days). Anything reading
// mtime as "when did this agent last do something" is reading the filesystem's
// last opinion, not the chat's; the reaper read it, so a fleet that had been
// silent for days looked freshly active and nothing was ever collected.
//
// Scanned BACKWARDS from the tail so the common case is one small read: a tail
// slice can cut its first line mid-object and the CLI can be mid-append at the
// end, and both fragments simply fail JSON.parse and are skipped — the same
// complete-records-only discipline parseLines keeps. The window escalates only
// when a chunk yields nothing parseable, and stops at BOF, so an unreadable or
// timestamp-less transcript returns null rather than a guess.
function lastTimestampIn(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    try {
      const t = Date.parse(JSON.parse(lines[i]).timestamp);
      if (Number.isFinite(t)) return t;
    } catch { /* fragment, or a record with no timestamp */ }
  }
  return null;
}

async function lastJsonlTimestamp(fpath) {
  for (const cap of [64 * 1024, 4 * 1024 * 1024, Infinity]) {
    let read;
    try { read = await readTail(fpath, cap); } catch { return null; }
    const t = lastTimestampIn(read.text);
    if (t != null || read.atBOF) return t;
  }
  return null;
}

// ==================== claude ====================

// The transcript tree is mutable global state on a developer machine. Test
// supervisors point this at their run namespace so transcript fixtures from
// overlapping runs cannot discover, overwrite, or delete one another.
export const CLAUDE_PROJECTS = () => process.env.LAB_CLAUDE_PROJECTS_DIR
  || path.join(os.homedir(), '.claude', 'projects');

// --- session liveness: which processes own a session, right now -------------
//
// "Is this session already running somewhere?" is the question that keeps two
// agents off one transcript, and only the agent itself knows how its answer is
// provable — so each adapter answers for its own sessions (sessionPids) and the
// union is sessionPidsAny. Every answer is either PROVEN pids or an admitted
// `uncertain`; an adapter never guesses, and the caller decides what an
// unanswerable question means (the dash fails closed and refuses the resume).
const UNKNOWN = { pids: [], uncertain: true };

const parsePids = (out) => out.split('\n')
  .map((s) => Number(s.trim()))
  .filter((p) => Number.isInteger(p) && p > 0);

const mergePids = (...answers) => ({
  pids: [...new Set(answers.flatMap((a) => a.pids))],
  uncertain: answers.some((a) => a.uncertain),
});

// A session id written so a pattern containing it cannot match ITSELF: the
// first character becomes a one-character class, so `[0]19ff…` matches the real
// argv `019ff…` while the pattern text does not contain it. Without this a
// probe finds the OTHER probe — every pgrep carries its pattern in its own
// command line, so codex's `resume <id>` matched the sibling pgrep running
// claude's `--resume <id>`, and a session with nothing running read as live
// whenever the two overlapped. (The `ps | grep [f]oo` idiom, and the reason it
// exists.)
const selfExcluding = (sessionId) => `[${sessionId[0]}]${sessionId.slice(1)}`;

// Pids whose full command line matches `pattern` (an extended regex). Excludes
// bystanders whose argv merely mentions a uuid (activity-monitor hooks, greps)
// because the patterns carry the flag/verb, not the bare id.
async function argvPids(pattern) {
  // '--' ends pgrep's own option parsing — a pattern can start with a dash.
  const r = await run('pgrep', ['-f', '--', pattern]);
  // pgrep exits 0 on match, 1 on no-match; anything else means we could not ask.
  if (r.error || (r.status !== 0 && r.status !== 1)) return UNKNOWN;
  return { pids: parsePids(r.stdout), uncertain: false };
}

// The pids holding `file` open FOR WRITING — the kernel's own answer, via lsof
// (the same instrument the reaper uses to read a process's cwd). Field output
// is a record stream — `p<pid>` once, then `f<fd>`/`a<mode>` per descriptor —
// so a pid counts only when one of ITS descriptors carries a write mode (w, or
// u for read/write). Read-only holders are excluded deliberately: the dash
// reads transcripts constantly (chat status, turn lists), and a reader caught
// mid-read is not the thread's writer. lsof reports "nothing holds it" and "I
// failed" with the same exit 1, so only a failure to run it at all is uncertain.
async function openWriterPids(file) {
  const r = await run('lsof', ['-F', 'pfa', '--', file]);
  if (r.error) return UNKNOWN;
  const pids = new Set();
  let pid = null;
  for (const line of r.stdout.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1)) || null;
    else if (line[0] === 'a' && pid && /[wu]/.test(line.slice(1))) pids.add(pid);
  }
  return { pids: [...pids], uncertain: false };
}

// What each pid IS — the basename of the executable it ran, from the kernel's
// own record (`ps -o comm`), which is the same identity the reaper matches
// against agentProcNames. Null when the probe could not run at all; a pid the
// probe simply doesn't name is left out of the map.
async function execNames(pids) {
  const r = await run('ps', ['-o', 'pid=', '-o', 'comm=', '-p', pids.join(',')]);
  if (r.error) return null;
  const out = new Map();
  for (const line of (r.stdout || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (m) out.set(Number(m[1]), path.basename(m[2]));
  }
  return out;
}

const claude = {
  id: 'claude',
  label: 'Claude Code',
  // basename of the executable, for recognising its processes — see agentProcNames.
  procName: 'claude',
  // A CLI the dash can put behind a PTY — so it appears in the new-chat picker,
  // is probed for availability, and is pgrep-able for liveness.
  launchable: true,
  // The dash mints the session uuid and hands it to claude via --session-id, so
  // a 'new' chat can be spawned lazily on attach with an id chosen up front.
  dashMintsId: true,

  // The install guidance shown when this CLI isn't on the machine. Guidance
  // only — the dash never installs anything on someone's computer.
  install: {
    name: 'Claude Code',
    command: 'npm install -g @anthropic-ai/claude-code',
    url: 'https://docs.claude.com/en/docs/claude-code/setup',
  },

  // The test stand-in this agent would run instead of the real CLI, or null.
  // ONE place decides it, so bin() and the "does it take CLI flags?" question
  // can never disagree about whether we're talking to a stand-in.
  standInCmd() { return process.env.LAB_TERMINAL_CMD || null; },

  // null when claude isn't installed here. The cmux-bundled copy is a real
  // second location (not a guess): it's tested with access(X_OK) exactly like
  // any other path, so it counts only when it genuinely exists.
  bin() {
    const standIn = claude.standInCmd();
    if (standIn) return resolveBin(standIn);
    return resolveBin('claude') || resolveBin('/Applications/cmux.app/Contents/Resources/bin/claude');
  },

  // Build claude's argv. NEW mints a --session-id; RESUME reopens --resume; both
  // carry an initial prompt as a positional arg when given (stays interactive AND
  // submits that first turn). Main chats build the same way — a new main chat is
  // a NEW spawn carrying the `/main` intro; resuming one is a plain --resume.
  buildArgs({ mode, sessionId, initialPrompt, model, effort }) {
    const args = mode === 'resume'
      ? ['--resume', sessionId, '--dangerously-skip-permissions']
      : ['--session-id', sessionId, '--dangerously-skip-permissions'];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (initialPrompt) args.push(initialPrompt);
    return args;
  },

  // A live claude carries the session uuid in its argv (--session-id / --resume)
  // in BOTH spawn modes, so a pgrep on those exact flag+uuid pairs is the whole
  // answer.
  sessionPids(sessionId) {
    const id = selfExcluding(sessionId);
    return argvPids(`--session-id ${id}|--resume ${id}`);
  },

  // ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl — the encode is lossy, so scan
  // every project dir for the uuid file rather than reconstructing the path.
  async findTranscript(sessionId) {
    const base = CLAUDE_PROJECTS();
    let dirs;
    try { dirs = await fs.promises.readdir(base); } catch { return null; }
    for (const d of dirs) {
      const p = path.join(base, d, `${sessionId}.jsonl`);
      try { if ((await fs.promises.stat(p)).isFile()) return p; } catch {}
    }
    return null;
  },

  // The cwd a transcript ran in — the first line that records one.
  async transcriptCwd(transcriptPath) {
    let raw;
    try { raw = await fs.promises.readFile(transcriptPath, 'utf8'); } catch { return null; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { const o = JSON.parse(line); if (o && o.cwd) return o.cwd; } catch {}
    }
    return null;
  },

  // Spoken user/assistant turns only. Tool calls, tool results, meta, sidechains
  // (subagent transcripts share the file) and summaries are skipped.
  parseTranscript(raw, after = 0) {
    return parseLines(raw, after, (o) => {
      if (!o || o.isMeta || o.isSidechain) return null;
      if (o.type !== 'user' && o.type !== 'assistant') return null;
      const content = o.message?.content;
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.filter(b => b?.type === 'text' && b.text).map(b => b.text).join('\n')
          : '';
      return { role: o.type, text };
    });
  },

  readTurns(sessionId, after = 0) { return fileBackedTurns(claude, sessionId, after); },

  // When this chat's conversation last moved — the last stamped record in its
  // jsonl, never the file's mtime. See lastJsonlTimestamp.
  lastMessageAt(transcriptPath) { return lastJsonlTimestamp(transcriptPath); },

  // Live context + LOC. Context fill is published by the Claude Code statusline
  // to /tmp/claude-ctx-<uuid>.json every render; we forward its
  // compactAt/compactExact verbatim (the ring falls back to ~83.5% if they're
  // absent), so the statusline stays the single source of truth for claude's
  // real compaction trigger. Missing/partial file → null (the statusline hasn't
  // run yet, or /tmp was cleared, or this uuid isn't claude's).
  //
  // LOC comes from git, NOT from the statusline, and it means what the code pane
  // beside it means: the lines this BRANCH changed. The statusline could only
  // report what the current claude PROCESS had edited, which is a different
  // question and a fragile one — the counter restarts with the process while the
  // baseline subtracted from it persisted on disk, so a reattached chat reported
  // 0 lines against a branch full of work, or went negative once the baseline
  // outlived the count it was baselining. Same derivation as codex now, so both
  // agents' badges answer one question.
  // Owning a transcript is what makes a session claude's — not owning a file in
  // /tmp. Keying on the transcript is what lets the LOC badge appear for a chat
  // whose statusline never ran, which is the whole point of taking the number
  // from git: it describes the branch, so it should not need the agent's process
  // to have published anything.
  async chatStatus(sessionId) {
    const transcript = await claude.findTranscript(sessionId);
    if (!transcript) return null;
    let added = 0;
    let removed = 0;
    const cwd = await claude.transcriptCwd(transcript);
    if (cwd) {
      try { ({ added, removed } = await repositoryLoc(cwd)); } catch { /* cwd not a git worktree */ }
    }
    let j = null;
    const contextDir = process.env.LAB_CLAUDE_CONTEXT_DIR || '/tmp';
    try { j = JSON.parse(fs.readFileSync(path.join(contextDir, `claude-ctx-${sessionId}.json`), 'utf8')); } catch { /* no fill published */ }
    const s = { used: typeof j?.used === 'number' ? j.used : null, added, removed };
    if (typeof j?.compactAt === 'number') { s.compactAt = j.compactAt; s.compactExact = !!j.compactExact; }
    return s;
  },
};

// ==================== codex ====================

// LAB_CODEX_SESSIONS_DIR overrides the rollout store (same test-seam pattern as
// LAB_CHAT_REGISTRY_DIR) so id-discovery/transcript tests never touch the real one.
// Exported because a harness that SEEDS a codex chat must write into the very
// tree this server reads — it asks via /api/dash/store rather than guessing a
// path, the same way it asks which issues table the server serves.
export const CODEX_SESSIONS = () => process.env.LAB_CODEX_SESSIONS_DIR || path.join(os.homedir(), '.codex', 'sessions');
const ROLLOUT_RE = (id) => new RegExp(`^rollout-.*-${id}\\.jsonl$`, 'i');

// Walk ~/.codex/sessions/YYYY/MM/DD, newest day first, yielding rollout files.
// Codex partitions sessions by date, so we descend the date tree rather than a
// flat readdir. `onFile(fullPath, name, mtimeMs)` returns truthy to stop early.
async function walkRollouts(onFile) {
  const base = CODEX_SESSIONS();
  const descend = async (dir) => {
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return null; }
    // Newest first: date components sort lexically, filenames start with an ISO
    // timestamp, so a reverse sort visits the most recent rollout first.
    ents.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { const hit = await descend(full); if (hit) return hit; continue; }
      if (!e.name.startsWith('rollout-') || !e.name.endsWith('.jsonl')) continue;
      let mtimeMs = 0;
      try { mtimeMs = (await fs.promises.stat(full)).mtimeMs; } catch {}
      const hit = await onFile(full, e.name, mtimeMs);
      if (hit) return hit;
    }
    return null;
  };
  return descend(base);
}

// Snapshot rollout *identities* before creating a new Codex process. CWD plus
// recency is not enough: an already-active Codex chat can append to its rollout
// while the new process is starting, making the existing chat appear newer than
// the child we are trying to discover. A fresh Codex session always owns a new
// rollout path, so identity is the deterministic boundary.
async function rolloutInventory() {
  const paths = new Set();
  await walkRollouts((full) => { paths.add(full); return null; });
  return paths;
}

// --- codex context-window math (verbatim from codex-rs protocol.rs) ---
// Codex writes a `token_count` event per turn into its rollout, carrying
// last_token_usage.total_tokens + model_context_window. Its TUI shows "% context
// left" = percent_of_context_window_remaining(last_token_usage, window), which
// subtracts a fixed BASELINE (system prompt + tool defs, always present) from both
// numerator and denominator so a fresh chat reads 100% left. The ring wants % USED,
// so chatStatus returns 100 − this.
const CODEX_BASELINE_TOKENS = 12000;
const _rolloutPathCache = new Map(); // uuid → rollout path (immutable once written)
const _statusCache = new Map(); // rollout path → { mtimeMs, size, status }
function codexPercentRemaining(totalTokens, window) {
  if (!(window > CODEX_BASELINE_TOKENS)) return 0;
  const effective = window - CODEX_BASELINE_TOKENS;
  const used = Math.max(0, totalTokens - CODEX_BASELINE_TOKENS);
  const remaining = Math.max(0, effective - used);
  return Math.round(Math.min(100, Math.max(0, (remaining / effective) * 100)));
}

// The most-recent COMPLETE token_count event in a chunk of rollout text. Jump
// straight to the last occurrence of the marker (no full split of a multi-MB
// chunk) and walk back over any that don't parse. A tail read can slice the first
// line mid-object — that fragment fails JSON.parse, and if it sits at the chunk
// start we return null so the caller widens the window. Returns { tokens, window }.
function lastTokenCountIn(text) {
  const MARK = '"type":"token_count"';
  let at = text.length;
  for (;;) {
    const hit = text.lastIndexOf(MARK, at - 1);
    if (hit < 0) return null;
    at = hit;
    const start = text.lastIndexOf('\n', hit) + 1; // 0 → the (possibly partial) first line
    const end = text.indexOf('\n', hit);
    // A line counts only if terminated by '\n' — same "complete lines only"
    // discipline as parseLines. An unterminated final fragment (end < 0, codex
    // mid-write) is skipped; the next poll sees it whole. A tail-sliced partial
    // first line fails JSON.parse below, and start === 0 then ends the scan.
    if (end >= 0) {
      try {
        const info = JSON.parse(text.slice(start, end))?.payload?.info;
        const last = info?.last_token_usage;
        if (last && typeof last.total_tokens === 'number' && typeof info.model_context_window === 'number') {
          return { tokens: last.total_tokens, window: info.model_context_window };
        }
      } catch { /* fragment or a non-event line that merely contains the marker */ }
    }
    if (start === 0) return null; // reached the chunk start without a clean parse
  }
}

// The last token_count in a rollout. Escalate the tail window until one turns up
// or we've read the whole file. token_count events fire every turn and are tiny,
// so the first (small) read almost always hits; escalation is a deterministic
// fallback, never a guess at "enough tail".
async function readLastTokenCount(fpath) {
  for (const cap of [512 * 1024, 8 * 1024 * 1024, Infinity]) {
    const { text, atBOF } = await readTail(fpath, cap);
    const tok = lastTokenCountIn(text);
    if (tok || atBOF) return tok;
  }
  return null;
}

// The cwd a codex chat runs in, from session_meta on line 1 — a head read, not the
// whole (possibly huge) rollout. This is the worktree its LOC diff is taken in.
async function codexHeadCwd(fpath) {
  const fd = await fs.promises.open(fpath, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    const text = buf.toString('utf8', 0, bytesRead);
    const nl = text.indexOf('\n');
    const o = JSON.parse(nl >= 0 ? text.slice(0, nl) : text);
    return o?.payload?.cwd || o?.cwd || null;
  } catch { return null; }
  finally { await fd.close(); }
}

const codex = {
  id: 'codex',
  label: 'Codex',
  launchable: true,
  // basename of the executable, for recognising its processes — see agentProcNames.
  procName: 'codex',
  // Codex mints its OWN session id (no flag to pre-specify one), so the dash
  // spawns first and discovers the id from the fresh rollout — see the eager
  // spawn in the /chat POST and discoverSessionId below.
  dashMintsId: false,

  install: {
    name: 'Codex',
    command: 'npm install -g @openai/codex',
    url: 'https://github.com/openai/codex',
  },

  // LAB_CODEX_CMD is the codex-specific stand-in; LAB_TERMINAL_CMD is the
  // generic one the whole test suite sets (so a codex chat spawned under test
  // also gets the harmless echo process, not real codex).
  standInCmd() { return process.env.LAB_CODEX_CMD || process.env.LAB_TERMINAL_CMD || null; },

  bin() {
    const standIn = codex.standInCmd();
    if (standIn) return resolveBin(standIn);
    return resolveBin('codex');
  },

  // Build codex's argv. NEW starts a fresh interactive session (codex mints the
  // id itself); RESUME reopens one by id. Both bypass approvals+sandbox (each
  // chat runs inside an isolated worktree) and carry an initial prompt as a
  // positional arg when given — `codex … "<prompt>"` / `codex resume <id>
  // "<prompt>"` stay interactive AND submit that first turn.
  //
  // Hook trust is bypassed for the same reason approvals are. Codex blocks
  // startup on a modal ("N hooks are new or changed") whenever the repo's
  // .codex/hooks.json hasn't been trusted from THIS directory — and every
  // worktree is a new directory, so every dash-spawned codex hit it. Nothing
  // answers a modal behind a PTY: codex never mints an id, never writes a
  // rollout, and discoverSessionId times out into "could not determine codex
  // session id". The dash spawns codex on hooks it owns, in a worktree of this
  // repo, which is exactly the vetted-source automation the flag is for.
  buildArgs({ mode, sessionId, initialPrompt, model }) {
    const args = mode === 'resume'
      ? ['resume', sessionId, '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust']
      : ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust'];
    if (model) args.push('-m', model);
    if (initialPrompt) args.push(initialPrompt);
    return args;
  },

  // Codex is the case argv ALONE cannot answer. A resumed codex carries
  // `resume <id>`, but a chat the dash started fresh carries no id at all (it
  // hadn't minted one yet) — so an argv-only check is blind to most of the codex
  // processes the dash itself spawns, and card-open cold-resumes over a stranded
  // one straight into codex's `already has an active writer` refusal
  // (i-codex-resume-collision). The refusal names the answer: a thread has ONE
  // writer, and a live codex holds its thread's rollout open for writing for
  // the whole session — verified against the journal's stamped pids, both spawn
  // modes, days apart. So ask the kernel who holds it; that is an OS fact about
  // the exact file, not an inference from a name or a command line.
  async sessionPids(sessionId) {
    const argv = await argvPids(`resume ${selfExcluding(sessionId)}`);
    const rollout = await codex.findTranscript(sessionId);
    if (!rollout) return argv;
    const held = await openWriterPids(rollout);
    if (!held.pids.length) return mergePids(argv, held);
    // Holding the file open makes you A writer; being CODEX makes you the
    // thread's writer. Anything else with a rollout open for append — an
    // editor, a sync tool, a test stand-in — is a bystander, and callers act on
    // this answer by ending processes, so "it had my file open" is not enough.
    // Unnameable pids keep the session marked held AND uncertain: refuse the
    // resume, refuse the kill.
    const names = await execNames(held.pids);
    if (!names) return mergePids(argv, { pids: held.pids, uncertain: true });
    const named = held.pids.filter((pid) => names.has(pid));
    return mergePids(argv, {
      pids: named.filter((pid) => names.get(pid) === codex.procName),
      uncertain: held.uncertain || named.length !== held.pids.length,
    });
  },

  // Codex stores rollouts at ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl.
  // Find the one whose filename embeds this id.
  async findTranscript(sessionId) {
    const re = ROLLOUT_RE(sessionId);
    return walkRollouts((full, name) => (re.test(name) ? full : null));
  },

  rolloutInventory,

  // Codex records the session's cwd in its session_meta (first line).
  async transcriptCwd(transcriptPath) {
    let raw;
    try { raw = await fs.promises.readFile(transcriptPath, 'utf8'); } catch { return null; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const o = JSON.parse(line);
        const cwd = o?.payload?.cwd || o?.cwd;
        if (cwd) return cwd;
      } catch {}
    }
    return null;
  },

  // Spoken turns from codex's rollout schema: event_msg records with a
  // user_message / agent_message payload. The parallel response_item records
  // (structured role/content) are skipped so each turn counts once.
  parseTranscript(raw, after = 0) {
    return parseLines(raw, after, (o) => {
      if (!o || o.type !== 'event_msg') return null;
      const p = o.payload;
      if (!p || typeof p.message !== 'string') return null;
      if (p.type === 'user_message') return { role: 'user', text: p.message };
      if (p.type === 'agent_message') return { role: 'assistant', text: p.message };
      return null;
    });
  },

  readTurns(sessionId, after = 0) { return fileBackedTurns(codex, sessionId, after); },

  // Identical to claude's: a rollout stamps every record with the same top-level
  // ISO `timestamp`, so one reader dates both agents. This is what lets the
  // reaper hold codex to exactly the claude rule instead of keeping it forever
  // for want of a clock.
  lastMessageAt(transcriptPath) { return lastJsonlTimestamp(transcriptPath); },

  // Discover the id codex minted for a session it just started in `cwd`. Codex
  // writes the rollout (with session_meta.cwd) at session start, so the newest
  // rollout whose recorded cwd matches — created at/after `sinceMs` — is it. Each
  // dash chat runs in its own unique worktree and we start one codex per worktree
  // at a time, so cwd + recency is an exact match, not a guess. Polls briefly
  // because the file appears a beat after spawn. Returns the uuid or null.
  async discoverSessionId({ cwd, sinceMs, timeoutMs = 8000, excludeRollouts = null }) {
    const deadline = Date.now() + timeoutMs;
    const idFromName = (name) => (name.match(/rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i) || [])[1] || null;
    while (Date.now() < deadline) {
      const hit = await walkRollouts(async (full, name, mtimeMs) => {
        if (excludeRollouts?.has(full)) return null;
        // Recency guard: skip a rollout older than this spawn — it's a PREVIOUS
        // codex chat in the same worktree, not the one we just started. A hair of
        // slack on sinceMs because fs mtime can round just under a same-instant
        // write. Returning null skips this file and keeps scanning (newest-first,
        // so the fresh rollout is hit early).
        if (mtimeMs < sinceMs - 2000) return null;
        const id = idFromName(name);
        if (!id) return null;
        const rcwd = await codex.transcriptCwd(full);
        return rcwd && path.resolve(rcwd) === path.resolve(cwd) ? id : null;
      });
      if (hit) return hit;
      await new Promise(r => setTimeout(r, 150));
    }
    return null;
  },

  // Live context + LOC for a codex chat, read straight from codex's rollout —
  // codex has no claude-style statusline. `used` inverts codex's own
  // context-remaining formula on the latest token_count; LOC is the worktree's git
  // diff, because codex (unlike claude) keeps no self-reported line count. null
  // until the first turn writes a token_count, or if no rollout matches this id.
  //
  // A rollout only grows when the chat takes a turn, and both the token count and
  // the file edits land within that turn — so the whole result is cached against
  // the file's mtime+size and only recomputed when the rollout advances. A poll
  // between turns is one stat(); the token scan and the git diff run once per turn.
  async chatStatus(sessionId) {
    // The rollout path for a uuid is immutable once written, so cache it — the
    // date-tree walk would otherwise repeat on every poll. A cached path that has
    // since vanished falls back to a fresh walk.
    let rollout = _rolloutPathCache.get(sessionId);
    if (!rollout || !fs.existsSync(rollout)) {
      rollout = await codex.findTranscript(sessionId);
      if (!rollout) return null;
      _rolloutPathCache.set(sessionId, rollout);
    }
    let st;
    try { st = await fs.promises.stat(rollout); } catch { return null; }
    const cached = _statusCache.get(rollout);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.status;

    const tok = await readLastTokenCount(rollout);
    if (!tok) return null;
    const used = 100 - codexPercentRemaining(tok.tokens, tok.window);
    let added = 0;
    let removed = 0;
    const cwd = await codexHeadCwd(rollout);
    if (cwd) {
      try { ({ added, removed } = await repositoryLoc(cwd)); } catch { /* cwd not a git worktree */ }
    }
    const status = { used, added, removed, compactAt: CODEX_COMPACT_AT };
    _statusCache.set(rollout, { mtimeMs: st.mtimeMs, size: st.size, status });
    return status;
  },
};

// ==================== cursor ====================

// Cursor is an editor, not a CLI: there is no binary the dash can put behind a
// PTY, no session id to mint, no argv to pgrep. So this adapter implements
// exactly the READ half of the contract — turns, cwd, discovery — and the
// `launchable: false` flag keeps it out of every path that would try to run it.
//
// It is also the only agent whose chats are DISCOVERED. claude and codex chats
// are linked explicitly (the dash created them, so it recorded them); Cursor
// records nothing about issues, so a Cursor chat's environment is derived from
// the folder it ran in — an exact structural fact from its workspace record, not
// a guess. See cursor-db.mjs for the store's shape and why reading it is a
// deliberately-accepted dependency on an internal format.
const cursor = {
  id: 'cursor',
  label: 'Cursor',
  launchable: false,
  dashMintsId: false,

  // No install guidance: the dash cannot make a Cursor chat, so "not installed"
  // is never a state anyone needs to act on. A machine without Cursor simply
  // contributes no Cursor chats.
  install: null,

  standInCmd() { return null; },
  bin() { return null; },

  // Every Cursor chat lives in ONE shared database, so a "transcript path" is
  // the same file for all of them. Returned so resolveChat and the liveness
  // gates get a truthful answer to "does this chat exist here?", and null when
  // the conversation isn't in this machine's store.
  async findTranscript(sessionId) {
    if (!isComposerId(sessionId)) return null;
    return (await composerHead(sessionId)) ? cursorDbPath() : null;
  },

  // The folder the chat ran in — from its workspace record, not from the
  // database path (which is shared). Takes a sessionId rather than the path for
  // that reason: the path identifies the store, the id identifies the chat.
  async transcriptCwd(_transcriptPath, sessionId) {
    if (!isComposerId(sessionId)) return null;
    const all = await listComposers();
    return all.find(c => c.composerId === sessionId)?.dir || null;
  },

  // Spoken turns: a bubble's `type` is 1 for the person and 2 for the agent, and
  // its `text` is what was said. Bubbles with empty text are the agent's tool
  // steps — skipped, exactly as claude's tool-call lines are.
  async readTurns(sessionId, after = 0) {
    const head = await composerHead(sessionId);
    if (!head) return null;
    const bubbles = await composerBubbles(sessionId);
    const messages = [];
    head.bubbleIds.forEach((id, i) => {
      if (i < after) return;
      const b = bubbles.get(id);
      const text = b && typeof b.text === 'string' ? b.text : '';
      if (!text.trim()) return;
      const role = b.type === 1 ? 'user' : b.type === 2 ? 'assistant' : null;
      if (!role) return;
      messages.push({ i, role, text, timestamp: b.createdAt ? new Date(b.createdAt).toISOString() : null });
    });
    return { messages, cursor: head.bubbleIds.length };
  },

  // Every Cursor chat on this machine, as [{ sessionId, dir, title, updatedAt }].
  // The dash maps `dir` onto an environment (a worktree is an issue, the repo
  // root is main) — which is the whole reason a teammate working in Cursor shows
  // up on the board at all.
  //
  // `updatedAt` is the mirror's "has this moved?" stamp, and every entry gets
  // one: a conversation Cursor left unstamped falls back to the store's own
  // mtime, which is truthful (something in Cursor changed) and merely
  // conservative — it re-reads a few unchanged chats rather than missing a
  // changed one. One stat for the whole list, not one per chat.
  async discoverChats() {
    if (!cursorPresent()) return [];
    let storeMtime = 0;
    try { storeMtime = fs.statSync(cursorDbPath()).mtimeMs; } catch {}
    return (await listComposers()).map(c => ({
      sessionId: c.composerId, dir: c.dir, title: c.title, updatedAt: c.updatedAt || storeMtime,
    }));
  },

  // When one chat last changed, epoch ms — the same fact as discoverChats'
  // stamp, for a caller holding a single id.
  changedAt(sessionId) { return composerUpdatedAt(sessionId); },

  // The same question the file-backed agents answer by tailing their jsonl.
  // Cursor's store is a shared database, so the ID is what identifies the
  // conversation and the path says nothing — hence the second argument.
  lastMessageAt(_transcriptPath, sessionId) { return composerUpdatedAt(sessionId); },

  // No context ring: Cursor publishes no token accounting the dash can read.
  async chatStatus() { return null; },
};

// ==================== registry + handle codec ====================

const AGENTS = { claude, codex, cursor };
export const DEFAULT_AGENT = 'claude';

// The agents the dash can actually START. Every spawn/resume/probe/liveness path
// reads this list rather than the full registry, so a read-only agent can never
// leak into a launch surface.
const LAUNCHABLE = () => Object.values(AGENTS).filter(a => a.launchable);

// The agent adapter for an id, or the claude default for an unknown/blank one.
export function agentById(id) {
  return AGENTS[id] || AGENTS[DEFAULT_AGENT];
}

// Public list for the UI's picker: [{ id, label }, …]. LAUNCHABLE agents only —
// the picker's job is "start a chat with…", and Cursor cannot be started.
export function agentChoices() {
  return LAUNCHABLE().map(a => ({ id: a.id, label: a.label }));
}

// The basename of each launchable agent's EXECUTABLE — how you recognise one of
// its processes in `ps` without knowing any session id. `sessionPids` above
// answers "is THIS session live"; this answers the prior question, "is that a
// chat at all", which the reaper needs to sweep the machine (idle-reaper's
// parseAgentLine). Basename, because bin() resolves an absolute path — from PATH
// or an app bundle — so the argv never carries the bare name. Launchable only:
// a read-only agent (Cursor) has no process of its own to find.
export function agentProcNames() {
  return LAUNCHABLE().map(a => a.procName).filter(Boolean);
}

// Thrown when a chat can't start because its CLI isn't installed here. A TYPE,
// not a message to pattern-match: the attach boundary tests `instanceof` and
// turns it into install guidance, so the person never sees a raw
// `spawn claude ENOENT`. Carries the agent id so the UI can name the right one.
export class AgentMissingError extends Error {
  constructor(agentId) {
    const a = agentById(agentId);
    super(`${a.label} is not installed on this computer`);
    this.name = 'AgentMissingError';
    this.agent = a.id;
    this.install = a.install;
  }
}

// Which agents this computer can actually run, with the install guidance for the
// ones it can't: [{ id, label, available, bin, install:{ name, command, url } }].
// The picker reads this so an uninstalled CLI is visibly unavailable BEFORE the
// person clicks, instead of failing at spawn — and the chat pane reads it to
// explain a failed attach. `available` is the binary resolving, nothing softer.
export function agentAvailability() {
  return LAUNCHABLE().map((a) => {
    const bin = a.bin();
    return { id: a.id, label: a.label, available: !!bin, bin: bin || null, install: a.install };
  });
}

// Can the dash START a chat of this agent? The one question every spawn/resume
// path asks before it does anything process-shaped.
export function isLaunchable(agentId) {
  return !!agentById(agentId).launchable;
}

// Roles a chat can carry BEYOND its agent. A `reviewer` is a chat spawned to
// review the branch (usually codex): it rides ALONGSIDE the agent, never
// replaces it, and is orthogonal — a reviewer is still a claude/codex CLI. Kept
// as its own token so the trailing sessionId stays a clean uuid and so the
// "never the default selection / never dots the card" rules key off one field.
export const ROLES = { reviewer: true };

// A conversations[] entry → { agent, role, sessionId }. The entry is an optional
// role token, then an optional agent token, then the bare session uuid:
//   `<uuid>`                 → claude, no role   (every pre-existing row)
//   `codex:<uuid>`           → codex,  no role
//   `reviewer:codex:<uuid>`  → codex,  reviewer
//   `reviewer:<uuid>`        → claude, reviewer
// KNOWN tokens are peeled off the FRONT (order-independent); the first unknown
// segment is the sessionId and keeps its bytes verbatim, so every read path
// (transcript, liveness, delete-resolve) still gets a clean id.
export function parseHandle(entry) {
  if (typeof entry !== 'string') return { agent: DEFAULT_AGENT, role: null, sessionId: '' };
  let rest = entry, agent = DEFAULT_AGENT, role = null;
  for (;;) {
    const i = rest.indexOf(':');
    if (i <= 0) break;
    const head = rest.slice(0, i);
    if (ROLES[head] && !role) role = head;
    else if (AGENTS[head] && agent === DEFAULT_AGENT) agent = head;
    else break; // unknown token → this is the sessionId
    rest = rest.slice(i + 1);
  }
  return { agent, role, sessionId: rest };
}

// { agent, sessionId, role } → conversations[] entry. Claude-with-no-role stays a
// bare uuid so existing rows and the many callers that read conversations as
// plain ids are unchanged; other agents get an `<agent>:` prefix and a reviewer
// gets a leading `reviewer:` token (role first, then agent, then uuid).
export function formatHandle(agent, sessionId, role = null) {
  const parts = [];
  if (role && ROLES[role]) parts.push(role);
  if (agent && agent !== DEFAULT_AGENT) parts.push(agent);
  parts.push(sessionId);
  return parts.join(':');
}

// Read paths (readTurnsAny, resolveChat, liveness) are reached by bare uuid
// with no agent in hand — a given uuid belongs to exactly ONE agent's on-disk
// store, so trying each finder in turn is deterministic, not a guess. Returns
// { agent, transcriptPath, launchable } or null.
export async function findTranscriptAny(sessionId) {
  for (const a of Object.values(AGENTS)) {
    const p = await a.findTranscript(sessionId);
    if (p) return { agent: a.id, transcriptPath: p, launchable: !!a.launchable };
  }
  return null;
}

// The cwd a chat ran in, by bare uuid. Same dispatch as findTranscriptAny; the
// sessionId rides along because a database-backed agent's chats all share one
// store path and only the id distinguishes them.
export async function transcriptCwdAny(sessionId) {
  const found = await findTranscriptAny(sessionId);
  if (!found) return null;
  return agentById(found.agent).transcriptCwd(found.transcriptPath, sessionId);
}

// A chat's spoken turns, by bare uuid — the one read every consumer (the HTTP
// transcript endpoint, agent-to-agent dialog, the mirror) goes through. Returns
// { agent, messages, cursor } or null when no agent on this machine has the chat.
export async function readTurnsAny(sessionId, after = 0) {
  for (const a of Object.values(AGENTS)) {
    const t = await a.readTurns(sessionId, after);
    if (t) return { agent: a.id, ...t };
  }
  return null;
}

// Chats an agent can find on disk that NOTHING linked — [{ agent, sessionId,
// dir, title, updatedAt }]. Only Cursor has any (it records no issue, so its
// chats reach the board through their folder alone); claude and codex chats are
// always explicitly linked, and inferring membership for them is exactly the
// guess main-chats-store refuses to make.
export async function discoverChatsAny() {
  const out = [];
  for (const a of Object.values(AGENTS)) {
    if (!a.discoverChats) continue;
    for (const c of await a.discoverChats()) out.push({ agent: a.id, ...c });
  }
  return out;
}

// Live context + LOC for a chat, dispatched by BARE uuid exactly like
// findTranscriptAny — a uuid lives in exactly ONE agent's on-disk store, so trying
// each adapter in turn is deterministic, not a guess. claude's cheap /tmp read
// short-circuits before codex's rollout walk in the common (claude) case. Returns
// { used, added, removed, compactAt } or null.
export async function chatStatusAny(sessionId) {
  for (const a of Object.values(AGENTS)) {
    const s = await a.chatStatus(sessionId);
    if (s) return s;
  }
  return null;
}

// WHEN a chat last did anything, with the evidence for it:
//   { transcript, lastMessageMs, fileMs }
// or null when this agent has no such chat on this machine. `lastMessageMs` is
// the conversation's own clock (the last stamped record); `fileMs` is the
// transcript's mtime, carried alongside NOT because anything decides on it but
// because the gap between the two is the bug — the reaper prints both so a
// transcript being rewritten without gaining a line is visible rather than
// silently resetting the fleet's idle clock.
//
// Dispatched by the agent id the caller already holds, rather than by trying
// every store like findTranscriptAny: the reaper knows which CLI a process is
// (it matched its executable), so guessing would only add work and ambiguity.
export async function chatActivity(agentId, sessionId) {
  if (!sessionId) return null;
  const a = agentById(agentId);
  if (!a.lastMessageAt) return null;
  const transcript = await a.findTranscript(sessionId);
  if (!transcript) return null;
  let fileMs = null;
  try { fileMs = (await fs.promises.stat(transcript)).mtimeMs; } catch { /* raced a delete */ }
  return { transcript, lastMessageMs: await a.lastMessageAt(transcript, sessionId), fileMs };
}

// Every process that provably owns this session, whichever agent it belongs to
// — each adapter answering however IT can prove it (see sessionPids above).
// `uncertain` means a probe could not run at all; callers fail closed on it.
// Restricted to LAUNCHABLE agents deliberately: a read-only agent (a Cursor
// conversation) has no process of its own to find.
export async function sessionPidsAny(sessionId) {
  return mergePids(...await Promise.all(LAUNCHABLE().map(a => a.sessionPids(sessionId))));
}
