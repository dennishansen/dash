import React, { useState, useRef } from 'react';

// A tiny inline icon button that copies `text` to the clipboard and flashes a
// checkmark for ~2s. Self-contained — drop next to any value you want copyable
// (breadcrumb ids, codes, etc.). Clipboard works on localhost (a secure context).
export function CopyButton({ text, title = 'Copy id' }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);

  const onCopy = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard blocked */ }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      type="button"
      className={`copy-btn${copied ? ' copied' : ''}`}
      onClick={onCopy}
      title={copied ? 'Copied!' : title}
      aria-label={title}
    >
      {copied ? (
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
