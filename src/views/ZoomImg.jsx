import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useHotkey } from '../hotkeys.js';

// A gif/image that opens at full scale in a lightbox on click. Drop-in
// replacement for any <img> we want zoomable — the inline thumbnail keeps
// its caller's layout (sized by surrounding CSS), and clicking it portals a
// dark backdrop with the image at native resolution (capped to the viewport).
// Click the backdrop or press Escape to close; clicking the image itself does
// not close (so you can read it without the backdrop swallowing the click).
export function ZoomImg({ src, alt, className, ...rest }) {
  const [open, setOpen] = useState(false);

  // The open lightbox owns Escape: capture phase wins over the detail view's
  // Escape-to-board, and it closes from wherever focus sits — over the terminal
  // (terminal:'handle') or an input (allowInInput) — not just the backdrop.
  useHotkey('Escape', () => setOpen(false), { enabled: open, terminal: 'handle', allowInInput: true });

  return (
    <>
      <img
        src={src}
        alt={alt}
        loading="lazy"
        className={`zoomable${className ? ' ' + className : ''}`}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}
        {...rest}
      />
      {open ? createPortal(
        <div className="lightbox-backdrop" onClick={() => setOpen(false)} title="Click anywhere to close">
          <img src={src} alt={alt} className="lightbox-img" onClick={(e) => e.stopPropagation()} />
        </div>,
        document.body
      ) : null}
    </>
  );
}
