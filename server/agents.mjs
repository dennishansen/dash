// Agent adapters — the per-CLI knowledge the dash needs to launch, resume, watch
// and read a chat, factored out of terminal.js so a chat is FIRST-CLASS in its
// agent type rather than hardwired to `claude`. Two agents today:
//
//   claude — Anthropic's `claude` CLI. The dash MINTS the session id (a uuid)
//            and passes it as `--session-id`; the transcript lands at
//            ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl.
//   codex  — OpenAI's `codex` CLI. Codex MINTS ITS OWN session id (there is no
//            flag to pre-specify one), so a NEW codex chat is spawn-then-
//            discover: we start it, then read the id back from the fresh rollout
//            it wrote under ~/.codex/sessions/**. Resume is `codex resume <id>`.
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
import { repositoryLoc } from './code-browser.mjs';

// --- chat-status: live context-window fill + LOC for one chat ---
// Both agents publish the SAME shape — { used, added, removed, compactAt?,
// compactExact? } — so the Dash ring/LOC badge read one contract regardless of
// which CLI is behind a chat. `used` is % of the context window filled;
// `compactAt` is the % at which that CLI auto-compacts (the ring's red line),
// carried in the payload so the client needn't hardcode a per-agent threshold;
// `compactExact` marks it as a read-back trigger rather than an estimate. claude
// forwards whatever its statusline published (the ring falls back to ~83.5% if a
// field is absent); codex derives its own from the rollout (see each adapter).
//
// Codex auto-compacts at model_auto_compact_token_limit = context_window*9/10
// (codex-rs protocol.rs). Fed through codex's own display formula, that token
// point lands at exactly 90% used for every real window size — so the codex ring
// goes red at 90. Left as ~ (not exact) since a per-session config override isn't
// read back.
const CODEX_COMPACT_AT = 90;

// --- binary resolution (cached; sh -c, never a login shell — see terminal.js) ---

const _binCache = {};
function resolveBin(name, fallback = null) {
  if (_binCache[name]) return _binCache[name];
  const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  const p = (r.stdout || '').trim().split('\n')[0];
  _binCache[name] = p || fallback || name;
  return _binCache[name];
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

// ==================== claude ====================

const CLAUDE_PROJECTS = () => path.join(os.homedir(), '.claude', 'projects');

const claude = {
  id: 'claude',
  label: 'Claude Code',
  // The dash mints the session uuid and hands it to claude via --session-id, so
  // a 'new' chat can be spawned lazily on attach with an id chosen up front.
  dashMintsId: true,

  bin() {
    if (process.env.LAB_TERMINAL_CMD) return process.env.LAB_TERMINAL_CMD;
    return resolveBin('claude', '/Applications/cmux.app/Contents/Resources/bin/claude');
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

  // A live claude carries the session uuid in its argv (--session-id / --resume),
  // so a pgrep on those exact flag+uuid pairs is a deterministic identity check.
  liveArgvPattern(sessionId) {
    return `--session-id ${sessionId}|--resume ${sessionId}`;
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

  // Live context + LOC, published by the Claude Code statusline to
  // /tmp/claude-ctx-<uuid>.json every render ({ used, added, removed } plus the
  // live compaction threshold — used% and lines this chat changed, reset on
  // /clear). We forward the statusline's compactAt/compactExact verbatim (the ring
  // falls back to ~83.5% if they're absent), so the statusline stays the single
  // source of truth for claude's real trigger. Missing/partial file → null (the
  // statusline hasn't run yet, or /tmp was cleared, or this uuid isn't claude's).
  chatStatus(sessionId) {
    let j;
    try { j = JSON.parse(fs.readFileSync(`/tmp/claude-ctx-${sessionId}.json`, 'utf8')); }
    catch { return null; }
    if (!j || typeof j.used !== 'number') return null;
    const s = { used: j.used, added: j.added | 0, removed: j.removed | 0 };
    if (typeof j.compactAt === 'number') { s.compactAt = j.compactAt; s.compactExact = !!j.compactExact; }
    return s;
  },
};

// ==================== codex ====================

// LAB_CODEX_SESSIONS_DIR overrides the rollout store (same test-seam pattern as
// LAB_CHAT_REGISTRY_DIR) so id-discovery/transcript tests never touch the real one.
const CODEX_SESSIONS = () => process.env.LAB_CODEX_SESSIONS_DIR || path.join(os.homedir(), '.codex', 'sessions');
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

// Read the last `maxBytes` of a file (whole file if smaller). `atBOF` marks that
// the read reached byte 0, so a caller widening the window knows when to stop.
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
  // Codex mints its OWN session id (no flag to pre-specify one), so the dash
  // spawns first and discovers the id from the fresh rollout — see the eager
  // spawn in the /chat POST and discoverSessionId below.
  dashMintsId: false,

  bin() {
    // LAB_CODEX_CMD is the codex-specific stand-in; LAB_TERMINAL_CMD is the
    // generic one the whole test suite sets (so a codex chat spawned under test
    // also gets the harmless echo process, not real codex).
    if (process.env.LAB_CODEX_CMD) return process.env.LAB_CODEX_CMD;
    if (process.env.LAB_TERMINAL_CMD) return process.env.LAB_TERMINAL_CMD;
    return resolveBin('codex');
  },

  // Build codex's argv. NEW starts a fresh interactive session (codex mints the
  // id itself); RESUME reopens one by id. Both bypass approvals+sandbox (each
  // chat runs inside an isolated worktree) and carry an initial prompt as a
  // positional arg when given — `codex … "<prompt>"` / `codex resume <id>
  // "<prompt>"` stay interactive AND submit that first turn.
  buildArgs({ mode, sessionId, initialPrompt, model }) {
    const args = mode === 'resume'
      ? ['resume', sessionId, '--dangerously-bypass-approvals-and-sandbox']
      : ['--dangerously-bypass-approvals-and-sandbox'];
    if (model) args.push('-m', model);
    if (initialPrompt) args.push(initialPrompt);
    return args;
  },

  // A resumed codex carries `resume <id>` in its argv. A brand-new codex has NO
  // id in its argv (it hasn't minted one yet), so this only matches resumes —
  // which is exactly the double-resume case the liveness gate must catch.
  liveArgvPattern(sessionId) {
    return `resume ${sessionId}`;
  },

  // Codex stores rollouts at ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl.
  // Find the one whose filename embeds this id.
  async findTranscript(sessionId) {
    const re = ROLLOUT_RE(sessionId);
    return walkRollouts((full, name) => (re.test(name) ? full : null));
  },

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

  // Discover the id codex minted for a session it just started in `cwd`. Codex
  // writes the rollout (with session_meta.cwd) at session start, so the newest
  // rollout whose recorded cwd matches — created at/after `sinceMs` — is it. Each
  // dash chat runs in its own unique worktree and we start one codex per worktree
  // at a time, so cwd + recency is an exact match, not a guess. Polls briefly
  // because the file appears a beat after spawn. Returns the uuid or null.
  async discoverSessionId({ cwd, sinceMs, timeoutMs = 8000 }) {
    const deadline = Date.now() + timeoutMs;
    const idFromName = (name) => (name.match(/rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i) || [])[1] || null;
    while (Date.now() < deadline) {
      const hit = await walkRollouts(async (full, name, mtimeMs) => {
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

// ==================== registry + handle codec ====================

const AGENTS = { claude, codex };
export const DEFAULT_AGENT = 'claude';

// The agent adapter for an id, or the claude default for an unknown/blank one.
export function agentById(id) {
  return AGENTS[id] || AGENTS[DEFAULT_AGENT];
}

// Public list for the UI's picker: [{ id, label }, …].
export function agentChoices() {
  return Object.values(AGENTS).map(a => ({ id: a.id, label: a.label }));
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

// Read paths (readTranscript, resolveChat, liveness) are reached by bare uuid
// with no agent in hand — a given uuid belongs to exactly ONE agent's on-disk
// store, so trying each finder in turn is deterministic, not a guess. Returns
// { agent, transcriptPath } or null.
export async function findTranscriptAny(sessionId) {
  for (const a of Object.values(AGENTS)) {
    const p = await a.findTranscript(sessionId);
    if (p) return { agent: a.id, transcriptPath: p };
  }
  return null;
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

// The pgrep alternation that matches a live process of ANY agent for this
// session — the union of every adapter's argv pattern.
export function liveArgvPatternAny(sessionId) {
  return Object.values(AGENTS).map(a => a.liveArgvPattern(sessionId)).join('|');
}
