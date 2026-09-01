import React, { useState, useRef } from 'react';
import { copyText, copyFailureHint } from '../clipboard.js';

// A tiny inline icon button that copies `text` to the clipboard and flashes a
// checkmark for ~2s. Self-contained — drop next to any value you want copyable
// (breadcrumb ids, codes, etc.).
//
// The checkmark means the copy LANDED. It used to mean the click happened: the
// write was fired into a try/catch and the flash ran regardless, so on an
// insecure origin — where there is no `navigator.clipboard` at all — the button
// said copied and the clipboard never changed (issue i-tailnet-secure-context).
// This button always sits next to the value it copies, so on failure it only
// has to stop lying; the text is already on screen to select by hand.
export function CopyButton({ text, title = 'Copy id' }) {
  const [state, setState] = useState('idle');   // idle | copied | failed
  const timer = useRef(null);
  const copied = state === 'copied';
  const failed = state === 'failed';

  const onCopy = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = await copyText(text);
    setState(ok ? 'copied' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), ok ? 2000 : 4000);
  };

  return (
    <button
      type="button"
      className={`copy-btn${copied ? ' copied' : ''}${failed ? ' copy-failed' : ''}`}
      onClick={onCopy}
      title={copied ? 'Copied!' : failed ? copyFailureHint() : title}
      aria-label={failed ? 'Copy failed' : title}
    >
      {failed ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      ) : copied ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}
