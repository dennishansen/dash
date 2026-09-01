// What an agent's SCREEN means, plus the UI metadata that names it. The other
// half of an agent lives in server/agents.mjs — CLI, process, transcript; this
// half is the terminal viewport grammar and the labels.
//
// Pure, and deliberately dependency-free, because BOTH sides run it: the
// supervisor samples each chat's headless emulator through `isWorking`
// (server/chat-activity.mjs — the one detector on the machine), and the browser
// reads the labels and the launchable set. One module, so "what a frozen codex
// pane means" can never be answered two ways.
//
// An adapter says what a screen MEANS, never which chat it belongs to. A chat's
// identity is its bare session uuid, the one key every map already uses
// (session-pool, liveTerms, selected_session, the activity store) — the
// agent/role tokens in a conversations[] handle are server routing metadata,
// not identity, and a uuid belongs to exactly one agent's store anyway.

import { spinnerState } from './spinner.js';

export const DEFAULT_AGENT = 'claude';

const streaming = (recentChanges = []) => recentChanges.length >= 2;

// Codex leaves its interruptable status frozen while thinking/tooling and later
// prints a Worked-for divider. Scan bottom-up so the later done divider beats a
// stale Working line still visible above it, mirroring Claude's spinner rule.
//
// A turn BLOCKED on a human decision needs no rule of its own: codex renders an
// approval prompt into the same bottom pane the status line occupies, erasing it
// (verified against a live codex-cli 0.146.0 capture — the row carrying
// "• Working (…• esc to interrupt)" is overwritten by "› 1. Yes, proceed (y)").
// No status on screen is 'none', which is not live, so a chat waiting on a
// decision flags for input exactly like one whose turn ended.
const CODEX_LIVE = /\b(?:esc|ctrl\s*\+\s*c)\s+to interrupt\b/i;
const CODEX_DONE = /\bworked for\s+\d/i;

export function codexStatus(viewport) {
  if (!viewport) return 'none';
  const lines = viewport.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CODEX_DONE.test(lines[i])) return 'done';
    if (CODEX_LIVE.test(lines[i])) return 'live';
  }
  return 'none';
}

const AGENTS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    launchable: true,
    isWorking({ viewport, recentChanges }) {
      return spinnerState(viewport) === 'live' || streaming(recentChanges);
    },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    launchable: true,
    isWorking({ viewport, recentChanges }) {
      return codexStatus(viewport) === 'live' || streaming(recentChanges);
    },
  },
  // Cursor is an editor, not a CLI — its chats are readable and never runnable
  // (see server/agents.mjs). It needs an entry so a Cursor chat renders with its
  // own badge, and `launchable: false` keeps it out of the new-chat picker.
  // There is no viewport to watch, so it never reports working.
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    launchable: false,
    isWorking() { return false; },
  },
};

export function agentById(id) {
  return AGENTS[id] || AGENTS[DEFAULT_AGENT];
}

// The agents a person can START a chat with — what the picker offers. A
// read-only agent is rendered wherever its chats appear but never offered here.
export function agentChoices() {
  return Object.values(AGENTS).filter(a => a.launchable);
}
