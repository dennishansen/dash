import React from 'react';

// Minimal line icons (lucide-style: 24-unit viewBox, currentColor stroke, round
// caps). The ink is centered inside the viewBox, so they sit dead-center in an
// .icon-btn — unlike the `+` / `×` / `✕` text glyphs they replace, which ride
// the font baseline and never truly center no matter the padding.
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

export function Plus({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function X({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

export function ArrowUpRight({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M7 17 17 7M7 7h10v10" />
    </svg>
  );
}

export function Refresh({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v5h-5" />
    </svg>
  );
}

// Framed rect with a filled RIGHT column — the app panel docks as the rightmost
// column, so this reads as "the right panel" (mirrors the left PanelIcon's
// filled-left column). The docked-close glyph on the app panel.
export function AppPanelIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <rect x="10" y="2.5" width="4.5" height="11" rx="2" fill="currentColor" opacity="0.55" />
    </svg>
  );
}

export function Pencil({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

export function Trash({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
    </svg>
  );
}
