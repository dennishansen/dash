// Detect whether a Claude Code chat is actively working — read from the RENDERED
// VIEWPORT (the grid xterm maintains), not the raw PTY stream.
//
// Why the viewport and not the stream: the stream is an unreliable proxy. During
// heavy text output Claude stops repainting the spinner for 10-18s (only content
// flows), and during a `Task` subagent the parent PTY can go SILENT for ~14s.
// Either way a stream-derived "spinner glyph seen recently" reads idle mid-turn
// and the needs-input dot flickers on. The viewport doesn't have these holes:
// xterm's buffer is updated by term.write regardless of whether the pane is
// painting (so a hidden/backgrounded pane reads accurately), and it RETAINS the
// last frame when the stream falls silent (so a frozen-mid-subagent frame still
// shows the spinner).
//
// The signal has two OR'd clauses (computed by the caller, which samples the
// viewport on a timer and tracks change):
//   1. spinnerState(viewport) === 'live' — a live spinner is the BOTTOMMOST
//      spinner line on screen. Covers thinking, tool calls, and subagents (the
//      spinner sits at the bottom, frozen or animating, with no done-summary
//      below it yet). We scan bottom-up so a STALE spinner frame left in history
//      ABOVE the post-turn summary doesn't win — the summary, printed last, sits
//      below it (that lingering frame was the bug that made detection stick on
//      "working" in a tall viewport).
//   2. the viewport text CHANGED since the last sample — covers text streaming,
//      which shows no spinner (the streaming content itself is the liveness).
// These are complementary and exhaustive: while working, Claude EITHER streams
// text (viewport changing) OR shows the spinner when paused/thinking/tooling
// (state 'live') — one is always true. Idle is a FROZEN viewport whose bottommost
// spinner line is the done-summary (or there's none): the input box waiting, or a
// menu awaiting the human — both correctly "needs input".
//
// The post-turn summary keeps a glyph but means done ("✻ Worked for 19s") — its
// "for <time>" tail distinguishes it from a live spinner.

const SPINNER = /[✻✽✶✳✢]/;          // asterisk-class frames (NOT '·', the footer separator)
const DONE_TAIL = /\bfor\s+\d/;       // "<verb> for <time>" → the done summary, not a live spinner

// Snapshot the VISIBLE viewport (term.rows lines from the scroll base) as text.
// Returns '' if the terminal isn't ready. translateToString(true) trims trailing
// whitespace per line.
export function viewportText(term) {
  const buf = term && term.buffer && term.buffer.active;
  if (!buf) return '';
  const base = buf.baseY;
  const rows = term.rows || 0;
  const out = [];
  for (let i = 0; i < rows; i++) {
    const ln = buf.getLine(base + i);
    out.push(ln ? ln.translateToString(true) : '');
  }
  return out.join('\n');
}

// Classify the spinner on screen from the BOTTOMMOST spinner-glyph line:
//   'live' — a live spinner ("✻ Verb…") is the bottommost glyph line → working
//   'done' — the bottommost glyph line is the "✻ … for <time>" summary → turn over
//   'none' — no spinner glyph on screen
// Bottom-up so a stale spinner frame lingering above the done-summary can't win.
export function spinnerState(viewport) {
  if (!viewport) return 'none';
  const lines = viewport.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SPINNER.test(lines[i])) return DONE_TAIL.test(lines[i]) ? 'done' : 'live';
  }
  return 'none';
}
