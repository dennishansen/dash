import React from 'react';
import { agentById } from './agents.js';
import { ClaudeMark, OpenAIMark, CursorMark } from './icons.jsx';

// Which maker's mark stands for which agent. This lives HERE and not in the
// agent registry because that registry is imported by node tests directly —
// pulling JSX artwork into it would make it unparseable outside the browser.
const AGENT_MARKS = { claude: ClaudeMark, codex: OpenAIMark, cursor: CursorMark };

// What agent a chat runs on, so a Codex one reads apart from a Claude one at a
// glance — the bare maker's logo in the maker's own colour, which lands faster
// and costs a fraction of the width its name did. One component for every
// surface that names an agent (the switcher, its list, the new-chat picker, the
// ⌘K results), so a mark can never mean one thing in one place and another
// somewhere else.
export function AgentBadge({ agent, size = 14 }) {
  const m = agentById(agent);
  const Mark = AGENT_MARKS[m.id];
  return (
    <span className={`agent-badge agent-badge--mark agent-badge-${m.id}`}
      title={m.label} role="img" aria-label={m.label}>
      <Mark size={size} />
    </span>
  );
}
