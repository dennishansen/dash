import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';

// A gif/image that opens at full scale in a lightbox on click. Drop-in
// replacement for any <img> we want zoomable — the inline thumbnail keeps
// its caller's layout (sized by surrounding CSS), and clicking it portals a
// dark backdrop with the image at native resolution (capped to the viewport).
// Click the backdrop or press Escape to close; clicking the image itself does
// not close (so you can read it without the backdrop swallowing the click).
export function ZoomImg({ src, alt, className, ...rest }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Capture-phase + stopImmediatePropagation so the open lightbox owns Escape:
    // the detail views also listen on window for Escape (to navigate back to the
    // list), and we must close the overlay without also triggering that nav.
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

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
