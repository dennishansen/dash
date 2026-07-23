// One placement rule for every dropdown in the dash — the filter menus, the chip
// multiselects (tags, requires, unlocks), the display-properties menu, the owner
// picker, the status menu.
//
// They used to be absolutely positioned inside their trigger's wrapper, which
// made a menu part of its scroll container's content: one opening near the right
// edge of a pane grew that pane's scrollWidth, so the app visibly stretched and
// gained a scrollbar. Fixed positioning takes a menu out of every ancestor's
// scroll extent — it is measured against the viewport instead — and lets us flip
// it away from an edge instead of spilling past one.
//
// The anchor is the popover's own PARENT element: every menu here renders as a
// sibling of the control that opens it, inside a wrapper that hugs that control,
// so there is nothing to wire up at the call site.
import { useLayoutEffect, useRef, useState } from 'react';

const GAP = 6;      // breathing room between the anchor and the menu
const MARGIN = 8;   // keep this far from any viewport edge

export function useAnchoredPopover(open) {
  const ref = useRef(null);
  // Hidden until measured, so a menu never paints for a frame at the wrong place.
  const [style, setStyle] = useState({ visibility: 'hidden' });

  useLayoutEffect(() => {
    if (!open) { setStyle({ visibility: 'hidden' }); return; }
    const el = ref.current;
    const anchor = el?.parentElement;
    if (!el || !anchor) return;

    const place = () => {
      const a = anchor.getBoundingClientRect();
      const { width, height } = el.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;

      // Start left-aligned with the anchor; if that runs off the right edge,
      // right-align to it instead, then clamp so it can never leave the viewport.
      let left = a.left;
      if (left + width > vw - MARGIN) left = a.right - width;
      left = Math.min(Math.max(MARGIN, left), Math.max(MARGIN, vw - width - MARGIN));

      // Below the anchor; above it when there isn't room, clamped as a last resort.
      let top = a.bottom + GAP;
      if (top + height > vh - MARGIN) {
        const above = a.top - GAP - height;
        top = above >= MARGIN ? above : Math.max(MARGIN, vh - height - MARGIN);
      }
      setStyle({ position: 'fixed', top, left, maxHeight: vh - 2 * MARGIN });
    };

    place();
    // Re-place while it's open: the menu's own size changes as you filter it, and
    // any scroll (capture phase — the panes scroll, not the window) or resize
    // moves the anchor under it.
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      ro.disconnect();
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  return { ref, style };
}
