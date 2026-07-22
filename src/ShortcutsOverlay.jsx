import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { useHotkey, matchesCombo } from './hotkeys.js';
import { HOTKEYS, SCOPES, comboCaps, hk } from './hotkey-registry.js';

// The keyboard-shortcuts overlay — a `?`-opened modal that renders the ONE
// hotkey registry (hotkey-registry.js) grouped by scope, so every shortcut is
// discoverable from one place instead of hidden behind a hover. It mirrors the
// ⌘K palette (CommandPalette.jsx): a body portal over any route, opened by a
// global chord OR its topbar-button twin (the `dash:open-shortcuts` event),
// closed by Esc / backdrop / the same key.
//
// Keyboard model — deliberately different from ⌘K's chord:
//   • The opener is a BARE `?` (Shift+Slash). Unlike a ⌘-chord, `?` is a
//     printable character, so it must YIELD to text fields and the chat PTY
//     (the primitive's default) — `allowInInput`/`terminal:'handle'` would
//     hijack every '?' you type. It fires only on a passive surface (board,
//     buttons, body). The topbar button is the affordance for when a field or
//     the terminal owns focus.
//   • While OPEN the modal owns focus (the panel is focused on mount), so a
//     second `?` closes it, and Esc — handled locally on the panel, bubble
//     phase + stopPropagation — closes it without falling through to a detail
//     route's Esc-to-board. No second global Escape binding, so the
//     one-binding-per-(combo,phase) invariant in hotkeys.js stays intact.

// Which route surface is active, so the overlay can dim the shortcuts that
// won't fire here. OSS routing: the board is home ('/'), an issue detail is
// '/changes/:id' — so anything that isn't a change detail reads as the board.
function activeRouteScope(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'changes' && parts[1]) return 'detail';
  return 'board';
}

export function ShortcutsOverlay() {
  const [open, setOpen] = useState(false);
  const restoreRef = useRef(null); // element focus returns to on close

  const close = useCallback(() => {
    setOpen(false);
    const el = restoreRef.current;
    restoreRef.current = null;
    // Return focus to wherever it was (the terminal, a card, the body) a beat
    // later, once React has torn the portal down — same as the ⌘K palette.
    if (el && el.isConnected) requestAnimationFrame(() => el.focus?.());
  }, []);

  const openOverlay = useCallback(() => {
    restoreRef.current = document.activeElement;
    setOpen(true);
  }, []);

  // The `?` opener — its combo comes from the registry it renders (dogfooding:
  // the overlay is just another entry). YIELDS to inputs and the terminal (no
  // allowInInput / no terminal:'handle') — `?` is a real character there. It only
  // OPENS: once open the panel is an aria-modal, so the primitive yields `?` to
  // it, and closing is a local key on the panel (Esc / a second `?`) below.
  useHotkey(hk('shortcuts'), () => { if (!open) openOverlay(); }, { repeat: false });

  // The pointer twin: the topbar keyboard button dispatches this so a click
  // reaches the same modal the `?` opens (one overlay, two affordances) — and it
  // works while a field or the terminal holds focus, where bare `?` can't.
  useEffect(() => {
    const onOpen = () => { if (!open) openOverlay(); };
    window.addEventListener('dash:open-shortcuts', onOpen);
    return () => window.removeEventListener('dash:open-shortcuts', onOpen);
  }, [open, openOverlay]);

  if (!open) return null;
  return createPortal(<ShortcutsModal onClose={close} />, document.body);
}

function KeyCaps({ combos }) {
  // Each combo is a run of <kbd> caps; a cluster (↑↓←→) shows its combos side by
  // side, separated by CSS gap.
  return (
    <span className="hk-keys">
      {combos.map((combo, i) => (
        <span className="hk-combo" key={i}>
          {comboCaps(combo).map((cap, j) => <kbd className="hk-cap" key={j}>{cap}</kbd>)}
        </span>
      ))}
    </span>
  );
}

function ShortcutsModal({ onClose }) {
  const panelRef = useRef(null);
  const { pathname } = useLocation();
  const routeScope = activeRouteScope(pathname);

  // Focus the panel as it mounts, so `?`/Esc land on it (not a card behind).
  useEffect(() => { requestAnimationFrame(() => panelRef.current?.focus()); }, []);

  const onKeyDown = (e) => {
    // Trap Tab so focus can't leave the modal for the page behind it (nothing in
    // the panel is tabbable, so this just keeps focus on the panel — where the
    // primitive reads 'modal' and yields every background hotkey).
    if (e.key === 'Tab') { e.preventDefault(); return; }
    // BARE Esc and a second `?` (both sourced via matchesCombo, so a MODIFIED
    // Escape and Meta+? don't spuriously close) close the overlay. Handled
    // locally so they win over any route-level Escape and never reach the page
    // behind the modal.
    if (matchesCombo(e, 'Escape') || matchesCombo(e, hk('shortcuts'))) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div className="cmdk-backdrop hk-backdrop" onMouseDown={onClose}>
      <div
        ref={panelRef}
        className="cmdk-panel hk-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="hk-header">
          <span className="hk-title">Keyboard shortcuts</span>
          <span className="hk-dismiss dim">esc to close</span>
        </div>
        <div className="hk-scroll">
          {SCOPES.map((scope) => {
            const rows = HOTKEYS.filter((h) => h.scope === scope.key);
            if (!rows.length) return null;
            // Dim the route surface you're NOT on — those chords won't fire here.
            const dim = scope.routeScope && routeScope && scope.key !== routeScope;
            return (
              <section className={`hk-group${dim ? ' is-dim' : ''}`} key={scope.key}>
                <h3 className="hk-group-title">{scope.label}</h3>
                {rows.map((h) => (
                  <div className="hk-row" key={h.id}>
                    <span className="hk-label">{h.label}</span>
                    <KeyCaps combos={h.combos} />
                  </div>
                ))}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
