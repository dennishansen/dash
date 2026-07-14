// Client-side agent adapters. Server adapters own CLI/process/transcript
// knowledge (server/agents.mjs); these own the terminal viewport grammar and UI
// metadata that only the browser can apply. Terminal.jsx samples the xterm grid
// and recent changes, then asks the selected agent whether that means working.

import { spinnerState } from './spinner.js';

export const DEFAULT_AGENT = 'claude';

const streaming = (recentChanges = []) => recentChanges.length >= 2;

// Codex leaves its interruptable status frozen while thinking/tooling and later
// prints a Worked-for divider. Scan bottom-up so the later done divider beats a
// stale Working line still visible above it, mirroring Claude's spinner rule.
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
    short: 'claude',
    activityKey(sessionId) { return sessionId; },
    isWorking({ viewport, recentChanges }) {
      return spinnerState(viewport) === 'live' || streaming(recentChanges);
    },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    short: 'codex',
    activityKey(sessionId) { return `codex:${sessionId}`; },
    isWorking({ viewport, recentChanges }) {
      return codexStatus(viewport) === 'live' || streaming(recentChanges);
    },
  },
};

export function agentById(id) {
  return AGENTS[id] || AGENTS[DEFAULT_AGENT];
}

export function agentChoices() {
  return Object.values(AGENTS);
}
