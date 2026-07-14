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

// Try to attach the WebGL renderer to an OPENED terminal (the canvas must
// exist — call after term.open()). Returns the addon, or null when degraded to
// the DOM renderer. `onLost` fires if the addon's context dies later: xterm's
// own guidance is dispose-on-loss, so the pane falls back to DOM painting
// instead of holding a dead canvas — the owner must drop its reference so a
// future activation reacquires a fresh context.
export function acquireWebgl(term, onLost) {
  let webgl = null;
  try {
    webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      console.error('[dash terminal] WebGL context lost — DOM renderer until this pane next shows');
      releaseWebgl(webgl);
      onLost?.();
    });
    term.loadAddon(webgl);
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
  try { webgl?.dispose(); } catch { /* half-activated or already disposed */ }
}
