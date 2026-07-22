import { useEffect, useRef } from 'react';

// The one dash keyboard-shortcut mechanism. Every shortcut registers through
// `useHotkey` so the focus rules that keep shortcuts working over the chat
// terminal — and out of it when they shouldn't — live in exactly one place.
//
// Why this exists: xterm's input surface is a real <textarea>
// (`.xterm-helper-textarea`). Hand-rolled `keydown` listeners guard "don't fire
// while typing" with `tagName === 'TEXTAREA'` and bail — which also bails inside
// the terminal, so the shortcut silently dies there. The ⌘-chords that DID work
// (issue nav, focus-steer) got it right: register in the CAPTURE phase and treat
// the xterm helper textarea as a PTY surface a command can fire OVER. That model
// is now shared, not re-derived per feature.
//
// The model, encoded once below:
//   • capture-phase registration (default) — beats the PTY, which reads on the
//     way down; `stopPropagation` on handle then keeps the chord out of the
//     terminal and `preventDefault` stops the browser's native ⌘←=Back / scroll.
//   • terminal handling is EXPLICIT, never inferred — a command that should work
//     with the terminal focused declares `terminal:'handle'`; everything else
//     yields the key to the PTY. (So Ctrl+E / Ctrl+←→ stay readline's, not ours.)
//   • real text fields (inputs, non-terminal textareas, contenteditable) always
//     keep the key unless a hotkey opts in with `allowInInput`.
//   • an open modal ([aria-modal="true"]) OWNS the keyboard: every hotkey yields
//     while focus is inside it, so no command acts on the surface behind it and
//     modals can't stack. Its own keys are local handlers on its focused element,
//     not global hotkeys — there is no opt-in, "yield everything" IS the contract.
//   • scoping — an `enabled` gate (panel open / board visible / route mounted).
//
// Invariant: at most one enabled binding per (combo, phase) — `stopPropagation`
// does not stop a sibling window listener, so overlapping bindings would both
// fire. Scopes here are disjoint (route vs board vs panel), so none overlap.
//
// Cross-origin caveat: when focus is inside the app IFRAME (a different origin)
// its keydowns never reach the dash document, so no hotkey — this one included —
// can see them. The model governs focus within the dash only.

// The platform's primary modifier: ⌘ on mac, Ctrl elsewhere. Binding the primary
// (and rejecting the other) is what keeps native terminal chords with the PTY —
// on mac, ⌘E is ours but Ctrl+E stays readline's end-of-line.
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');

// A combo is `+`-joined tokens: modifiers (`Mod` = the platform primary, or
// explicit `Meta`/`Ctrl`/`Alt`/`Shift`) then one key. The key matches either
// `e.key` or `e.code` case-insensitively, so `Slash`/`KeyE` are layout-proof and
// `ArrowLeft`/`Escape`/`Enter`/`/` all read naturally.
function parseCombo(combo) {
  const spec = { mod: false, meta: false, ctrl: false, alt: false, shift: false, key: null };
  for (const raw of combo.split('+')) {
    const p = raw.trim();
    if (!p) continue;
    switch (p.toLowerCase()) {
      case 'mod': spec.mod = true; break;
      case 'meta': case 'cmd': case '⌘': spec.meta = true; break;
      case 'ctrl': case 'control': spec.ctrl = true; break;
      case 'alt': case 'option': spec.alt = true; break;
      case 'shift': spec.shift = true; break;
      default: spec.key = p;
    }
  }
  return spec;
}

function keyMatches(e, key) {
  if (!key) return false;
  const k = key.toLowerCase();
  return (e.key && e.key.toLowerCase() === k) || (e.code && e.code.toLowerCase() === k);
}

function matches(e, spec) {
  if (spec.mod) {
    // Require the platform primary held and the OTHER primary-candidate absent,
    // so ⌘X and Ctrl+X stay distinct and Ctrl-chords reach the terminal on mac.
    if (IS_MAC ? (!e.metaKey || e.ctrlKey) : (!e.ctrlKey || e.metaKey)) return false;
  } else if (e.metaKey !== spec.meta || e.ctrlKey !== spec.ctrl) {
    // Explicit Meta/Ctrl pin that key; a bare hotkey (both false) requires
    // neither, so ⌘↑ never triggers a plain-↑ hotkey and vice-versa.
    return false;
  }
  if (e.altKey !== spec.alt || e.shiftKey !== spec.shift) return false;
  return keyMatches(e, spec.key);
}

// Does keydown `e` match `combo`? Same parse + match logic `useHotkey` uses,
// exposed for the few LOCAL onKeyDown handlers that own a single field's keys
// (a modal's own Esc / a second opener) and so can't be global hotkeys — they
// still source their combo from the registry via `matchesCombo(e, hk('id'))`
// instead of hand-rolling `(e.metaKey||e.ctrlKey) && e.key==='Enter'`.
export function matchesCombo(e, combo) {
  return matches(e, parseCombo(combo));
}

// What kind of surface currently holds focus, for the focus rules:
//   'terminal' — xterm's hidden helper textarea (a PTY surface, not a text field)
//   'modal'    — focus is inside an open modal dialog ([aria-modal="true"]). A
//               modal OWNS the keyboard: every hotkey yields to it, so no route /
//               board / panel command acts on the surface behind it. The modal's
//               own keys are LOCAL handlers on its focused element (the ⌘K palette
//               and the ? overlay both work this way), never global hotkeys — so
//               "yield everything" is the whole contract, no per-hotkey opt-in.
//               Checked before 'input' so a modal that contains a text field (the
//               palette's search box) still reads as a modal, not a plain field.
//   'input'    — a real text field (input / textarea / select / contenteditable)
//   'none'     — anything else (buttons, body, the board)
// A popover that is NOT aria-modal (a status menu, the tag/owner pickers) is
// deliberately not 'modal' — it owns only its own Escape (a capture-phase local
// listener), while the rest of the keyboard still works behind it.
export function focusedFieldKind(target) {
  const t = target;
  if (!t || t.nodeType !== 1) return 'none';
  if (t.classList && t.classList.contains('xterm-helper-textarea')) return 'terminal';
  if (t.closest && t.closest('[aria-modal="true"]')) return 'modal';
  if (t.isContentEditable) return 'input';
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return 'input';
  return 'none';
}

// Register `combo` → `handler` for as long as the calling component is mounted
// and `enabled`. Options:
//   enabled        gate the shortcut (default true)
//   allowInInput   also fire while a real text field owns focus (default false)
//   terminal       'handle' fires over the chat terminal; 'yield' (default) leaves
//                  the key to the PTY — declare 'handle' only for genuine commands
//   capture        capture-phase listener (default true; false = bubble, so an
//                  inner overlay/dialog can stopPropagation and win first)
//   when           extra predicate `(e) => bool` — an ownership gate finer than
//                  `enabled` (e.g. "the board owns the keyboard only when nothing
//                  is focused"). Must be a STABLE reference (module-level fn).
//   repeat         fire on auto-repeat keydowns (default true); toggles set false
//                  so holding the key doesn't oscillate.
// The handler may return `false` to DECLINE — the event is then left untouched
// (not prevented, not stopped), so e.g. board Enter with no card selected does
// not swallow the keystroke. And a keydown already handled elsewhere
// (`defaultPrevented`) is left alone — a local element handler that preventDefaults
// (a body editor, a tablist) suppresses the global hotkey without needing to also
// stopPropagation.
export function useHotkey(combo, handler, opts = {}) {
  const { enabled = true, allowInInput = false, terminal = 'yield', capture = true, when, repeat = true } = opts;
  // Keep the latest handler in a ref so the listener never re-subscribes just
  // because the closure changed — it always sees current state.
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return undefined;
    // A terminal-handling command must ride the capture phase to beat the PTY;
    // catch the misconfiguration in dev rather than shipping a dead shortcut.
    if (import.meta.env && import.meta.env.DEV && terminal === 'handle' && !capture) {
      console.error(`[hotkeys] "${combo}" declares terminal:'handle' but capture:false — it can't beat the PTY.`);
    }
    const spec = parseCombo(combo);
    const onKey = (e) => {
      if (e.defaultPrevented) return;                    // already handled by an inner element
      if (e.repeat && !repeat) return;                   // ignore held-key auto-repeat
      if (!matches(e, spec)) return;
      if (when && !when(e)) return;                      // finer ownership gate
      const kind = focusedFieldKind(e.target);
      if (kind === 'modal') return;                      // a modal owns the keyboard; its keys are local
      if (kind === 'input' && !allowInInput) return;     // real text field keeps the key
      if (kind === 'terminal' && terminal !== 'handle') return; // key belongs to the PTY
      if (handlerRef.current && handlerRef.current(e) === false) return; // handler declined
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, capture);
    return () => window.removeEventListener('keydown', onKey, capture);
  }, [combo, enabled, allowInInput, terminal, capture, when, repeat]);
}
