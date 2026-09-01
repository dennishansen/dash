// --- Right-dock geometry: the numbers and the width math ---
//
// The dash shell carries two right-docked columns (the AI chat, then the running
// app). This module owns how wide they may be: the constants, the persisted-width
// read, the clamp, and the resize drag. It is deliberately plain JS with no React
// import, so it is the ONE definition for everyone who needs these numbers — the
// shell, the panel shell in dock.jsx, and node-side tests, which import the clamp
// rather than restating its constants and rotting when one of them moves.
//
// The panel ELEMENT (the shared <aside> shell) lives in dock.jsx.

export const DOCK_MIN_W = 300; // a docked column's drag-floor; also how thin the
//                                window can get before the panel flips to overlay
export const MAIN_MIN_W = 240; // content room that must remain beside the docked
//                                columns before they flip to overlay (anti-scrunch)
export const LEFT_W = 220;     // expanded left sidebar (keep in sync with --left-w)

export const CHAT_DEFAULT_W = 560;
export const APP_DEFAULT_W = 720;

// Read a persisted px width, falling back to a default when unset/garbage.
export function loadW(key, def) {
  const w = parseInt(localStorage.getItem(key) || '', 10);
  return Number.isFinite(w) ? w : def;
}

// A docked column may not eat into the content's min room: floor at DOCK_MIN_W,
// cap so that sidebar + thisColumn + the OTHER docked column + MAIN_MIN_W still
// fit. `otherW` is the width already claimed by the sibling docked panel (0 when
// it's closed) — that's what keeps two open panels from scrunching the topbar.
export function clampW(w, viewportW, sidebarW, otherW) {
  return Math.min(
    Math.max(w, DOCK_MIN_W),
    Math.max(DOCK_MIN_W, viewportW - sidebarW - otherW - MAIN_MIN_W),
  );
}

// Begin a left-edge resize drag for a docked panel. Width tracks live (onWidth)
// and persists on release (onEnd); clamping keeps MAIN_MIN_W of content room
// given the sibling panel's current width.
export function startDockResize(e, { startW, sidebarW, otherW, onWidth, onEnd, setResizing }) {
  e.preventDefault();
  const startX = e.clientX;
  setResizing(true);
  let w = startW;
  const move = (ev) => {
    w = clampW(startW + (startX - ev.clientX), window.innerWidth, sidebarW, otherW);
    onWidth(w);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    setResizing(false);
    onEnd(w);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
