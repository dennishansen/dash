import { WebglAddon } from '@xterm/addon-webgl';

// The dash terminal's GPU-renderer seam — the ONE place a chat pane acquires or
// releases its renderer accelerator. ChatPane (Terminal.jsx) and the renderer
// contract fixture (dash/terminal-webgl-probe.html) both import it, so the
// tested lifecycle IS the shipped lifecycle.
//
// Contract: WebGL is the PREFERRED renderer, not a precondition. Wherever a GPU
// context exists WebGL must win — xterm's DOM renderer paints claude's heavy
// TUI redraws synchronously on the main thread, which freezes keystroke input
// (type → freeze → keystrokes burst in). But an uncaught renderer throw inside
// a React effect unmounts the entire dash (issue i-webgl-pool: one chat pane
// took down the whole board), so every failure here degrades to the DOM
// renderer instead of propagating.
//
// There is deliberately NO capability latch: "WebGL2 missing" (headless
// chromium, some VMs) and "context allocation failed right now" (browsers cap
// ~16 live contexts; transient driver trouble) are indistinguishable from the
// outside — even getContext('webgl2') returning null is a failed allocation
// attempt, not an immutable property of the client. So every ACTIVATION simply
// tries the real addon and degrades on failure. Activations are user-paced
// (a pane showing), so the retry costs one caught exception per show on a
// WebGL-less client — and a capable client that failed transiently heals on
// the next show instead of being latched onto the slow path forever.

// ── OFF BY DEFAULT (2026-08-18) ──────────────────────────────────────────────
//
// The terminal does not acquire a GPU context at all. This is a deliberate
// product decision taken while the board was unusable: xterm's addon recovers
// from a lost context by rebuilding against the restored one while its old
// renderers still hold GL objects from the dead one, and the resulting
// loss → restore → "object does not belong to this context" cycle repeated
// until Artifact crashed.
//
// The seam below fixes that cycle at its source (dispose on the lost EVENT, so
// the addon never reaches its own recovery path) and dash/terminal-webgl.test
// pins it at zero errors across repeated cycles. But that proof covers the
// fixture's cycle, not a live board with many panes showing and hiding, and a
// terminal that acquires ANY context is still a terminal that can be evicted
// and re-acquire — a slower version of the same loop, and one more claim on a
// budget the canvas also needs. Not acquiring removes the terminal from that
// budget entirely.
//
// THE COST IS REAL: xterm's DOM renderer paints claude's heavy TUI redraws
// synchronously on the main thread, which is what made keystrokes feel like
// type → freeze → burst. That regression is the price of a board that does not
// crash, and it is why this is a switch rather than a deletion — the whole
// WebGL lifecycle below stays live and tested behind it.
//
// Turn it back on for an experiment with `?termgl=1`, or
// localStorage.setItem('dashTermWebgl', '1'). Flip DEFAULT_WEBGL to true to
// ship it on again.
const DEFAULT_WEBGL = false;

export function webglEnabled() {
  try {
    const q = new URLSearchParams(location.search).get('termgl');
    if (q === '1') return true;
    if (q === '0') return false;
  } catch { /* no location */ }
  try {
    const stored = localStorage.getItem('dashTermWebgl');
    if (stored === '1') return true;
    if (stored === '0') return false;
  } catch { /* storage blocked */ }
  return DEFAULT_WEBGL;
}

// Teardown for the loss listener below, kept on the addon so releaseWebgl stays
// a one-argument call for every caller.
const TEARDOWN = Symbol('term-renderer.teardown');

// Try to attach the WebGL renderer to an OPENED terminal (the canvas must
// exist — call after term.open()). Returns the addon, or null when degraded to
// the DOM renderer. `onLost` fires if the addon's context dies later: xterm's
// own guidance is dispose-on-loss, so the pane falls back to DOM painting
// instead of holding a dead canvas — the owner must drop its reference so a
// future activation reacquires a fresh context.
//
// DISPOSE ON THE EVENT, NOT ON THE ADDON'S onContextLoss. The two are not the
// same moment and the difference is a real defect (i-render-context-loss):
// the addon cancels its own lost event, waits THREE SECONDS for the context to
// come back, and only fires onContextLoss if it never does. Inside that window
// it takes its own recovery path — and that path rebuilds against the restored
// context while its old renderers still hold GL objects created by the dead
// one, so tearing them down deletes those objects against a context they do not
// belong to:
//
//   xterm.js: webglcontextrestored event received
//   WebGL: INVALID_OPERATION: delete: object does not belong to this context
//   WebGL: INVALID_OPERATION: deleteVertexArray: object does not belong to this context
//
// Measured at 42 GL errors per loss/restore cycle, repeating for as long as the
// browser keeps recycling contexts (dash/terminal-webgl.test.mjs pins it at 0).
// We cannot fix the addon's internals from out here, so we make sure it never
// reaches that path: a lost context means this addon is finished. Disposing
// while the context is still lost is clean — every GL call on a lost context is
// a no-op, so the stale handles go quietly — and the next show builds a fresh
// addon against a live context, which is the recovery that actually works.
//
// The listener is CAPTURING on the terminal's element: webglcontextlost does
// not bubble, but capture reaches the canvas's ancestors on the way down, which
// also puts us ahead of the addon's own handler.
export function acquireWebgl(term, onLost) {
  // Before `new WebglAddon()`, so a disabled terminal never allocates a context
  // — not one it releases quickly, not one at all.
  if (!webglEnabled()) return null;
  let webgl = null;
  try {
    webgl = new WebglAddon();
    const addon = webgl;
    const degrade = (why) => {
      console.error(`[dash terminal] WebGL context lost (${why}) — DOM renderer until this pane next shows`);
      releaseWebgl(addon);
      onLost?.();
    };
    // The addon's own signal still matters on clients where the context dies
    // without an event we can see; it is just no longer the only one.
    webgl.onContextLoss(() => degrade('addon'));
    term.loadAddon(webgl);
    const host = term.element;
    if (host) {
      const onContextLost = () => degrade('canvas');
      host.addEventListener('webglcontextlost', onContextLost, true);
      addon[TEARDOWN] = () => host.removeEventListener('webglcontextlost', onContextLost, true);
    }
    return webgl;
  } catch (e) {
    console.warn('[dash terminal] WebGL renderer unavailable — using the DOM renderer for this pane', e);
    releaseWebgl(webgl);
    return null;
  }
}

// Release a pane's GPU context (pane going hidden, unmounting, or context
// lost). A deliberate release, not a fallback — a hidden pane never paints, so
// xterm's idle DOM baseline costs nothing.
export function releaseWebgl(webgl) {
  try { webgl?.[TEARDOWN]?.(); } catch { /* never attached */ }
  if (webgl) webgl[TEARDOWN] = null;
  try { webgl?.dispose(); } catch { /* half-activated or already disposed */ }
}
