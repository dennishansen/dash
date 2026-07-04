import React from 'react';
import { X } from './icons.jsx';

// --- Right-docked panel machinery, shared by the chat and the app panel ---
//
// The dash shell carries two right-docked columns: the AI chat, then the running
// app. Both solve the same geometry problem — a draggable, persisted-width column
// that docks beside readable content on a wide screen and flips to a full-screen
// overlay when the viewport gets too thin to leave room beside it. This module is
// that one solution, factored out so the two panels can't drift: the width math,
// the resize drag, the localStorage persistence, and the panel shell (resize
// handle + floating close + class-swap visibility) all live here. Each panel
// supplies only its own children (a terminal pool, an iframe) and its storage
// keys; the layout is identical.

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

// The shared panel shell. ONE stable element per panel: `mode` (docked vs
// overlay) and `open` (visible vs hidden) are class swaps only — the <aside> and
// whatever lives inside it never unmount, so resizing across the docked↔overlay
// threshold, closing/reopening, and switching routes all keep the live content
// (PTY, iframe) attached. `prefix` selects the class family ('chat' | 'app') so
// each panel keeps its own column placement + skin while sharing this structure.
// The close is an ✕ floating top-left of the panel's own navbar — the topbar
// opener disappears while the panel is open, and this ✕ is how you close it.
export function DockPanel({
  prefix, mode, open, onClose, onResizeStart, closeLabel, children, env,
}) {
  const overlay = mode === 'overlay';
  const cls = `${overlay ? `${prefix}-overlay` : `${prefix}-sidebar`}${open ? '' : ` ${prefix}-hidden`}`;
  return (
    <aside className={cls} data-env={env}>
      {overlay ? null : (
        <div className={`${prefix}-resize`} title="Drag to resize" onPointerDown={onResizeStart} />
      )}
      <button
        className={`topbar-btn ${prefix}-close`}
        title={closeLabel}
        aria-label={closeLabel}
        onClick={onClose}
      >
        <X size={14} />
      </button>
      {children}
    </aside>
  );
}
