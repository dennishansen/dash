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

  // Build claude's argv. The MAIN chat (main / main-init) is claude-only and
  // stays here. Issue chats: NEW mints a --session-id; RESUME reopens --resume;
  // both carry an initial prompt as a positional arg when given (stays
  // interactive AND submits that first turn).
  buildArgs({ mode, sessionId, initialPrompt, model, effort }) {
    if (mode === 'main') return ['--continue', '--dangerously-skip-permissions'];
    if (mode === 'main-init') {
      const args = ['--session-id', sessionId, '--dangerously-skip-permissions'];
      if (initialPrompt) args.push(initialPrompt);
      return args;
    }
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

// A conversations[] entry → { agent, sessionId }. Bare uuid = claude (backward
// compatible with every pre-existing row); `<agent>:<uuid>` = that agent.
export function parseHandle(entry) {
  if (typeof entry !== 'string') return { agent: DEFAULT_AGENT, sessionId: '' };
  const i = entry.indexOf(':');
  if (i > 0) {
    const maybe = entry.slice(0, i);
    if (AGENTS[maybe]) return { agent: maybe, sessionId: entry.slice(i + 1) };
  }
  return { agent: DEFAULT_AGENT, sessionId: entry };
}

// { agent, sessionId } → conversations[] entry. Claude stays a bare uuid so
// existing rows and the many-callers that read conversations as plain ids are
// unchanged; other agents get an `<agent>:` prefix.
export function formatHandle(agent, sessionId) {
  return agent && agent !== DEFAULT_AGENT ? `${agent}:${sessionId}` : sessionId;
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

// The pgrep alternation that matches a live process of ANY agent for this
// session — the union of every adapter's argv pattern.
export function liveArgvPatternAny(sessionId) {
  return Object.values(AGENTS).map(a => a.liveArgvPattern(sessionId)).join('|');
}
