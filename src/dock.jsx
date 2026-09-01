import React from 'react';
import { X, NAV_ICON } from './icons.jsx';

// --- The shared right-docked panel shell ---
//
// The dash shell carries two right-docked columns: the AI chat, then the running
// app. Both solve the same geometry problem — a draggable, persisted-width column
// that docks beside readable content on a wide screen and flips to a full-screen
// overlay when the viewport gets too thin to leave room beside it. The width math
// (constants, clamp, resize drag, persistence) lives in ./dock-geometry.js so it
// stays importable without React; this file is the ELEMENT the two panels share.
// Each panel supplies only its own children (a terminal pool, an iframe) and its
// storage keys; the layout is identical.

// ONE stable element per panel: `mode` (docked vs overlay) and `open` (visible vs
// hidden) are class swaps only — the <aside> and whatever lives inside it never
// unmount, so resizing across the docked↔overlay threshold, closing/reopening,
// and switching routes all keep the live content (PTY, iframe) attached. `prefix`
// selects the class family ('chat' | 'app') so each panel keeps its own column
// placement + skin while sharing this structure. The close is an ✕ floating
// top-left of the panel's own navbar — the topbar opener disappears while the
// panel is open, and this ✕ is how you close it.
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
        <X size={NAV_ICON} />
      </button>
      {children}
    </aside>
  );
}
