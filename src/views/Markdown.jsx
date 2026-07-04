import React from 'react';
import { ZoomImg } from './ZoomImg.jsx';

// Tiny markdown renderer for recap/note bodies. Handles the subset we use:
// headings, paragraphs, lists, code blocks/spans, blockquotes, bold/italic,
// links, images (gif receipts embed as ![label](url) — zoomable), and bare
// H-id / bench-name auto-links into Dash.
//
// Not a complete CommonMark — but enough for Dash's hand-edited prose.

export function Markdown({ text }) {
  if (!text) return null;
  const blocks = parseBlocks(text);
  return <div className="recap-body">{blocks.map((b, i) => renderBlock(b, i))}</div>;
}

function parseBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // code fence
    if (/^```/.test(line)) {
      const lang = line.replace(/^```/, '').trim();
      i++;
      const buf = [];
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // skip closing fence
      blocks.push({ type: 'code', lang, text: buf.join('\n') });
      continue;
    }
    // heading
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, text: h[2] });
      i++; continue;
    }
    // hr
    if (/^---+\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      i++; continue;
    }
    // blockquote
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', text: buf.join('\n') });
      continue;
    }
    // list
    if (/^[\s]*[-*]\s+/.test(line) || /^[\s]*\d+\.\s+/.test(line)) {
      const ordered = /^[\s]*\d+\.\s+/.test(line);
      const buf = [];
      while (i < lines.length && (/^[\s]*[-*]\s+/.test(lines[i]) || /^[\s]*\d+\.\s+/.test(lines[i]) || (lines[i] && /^\s+/.test(lines[i])))) {
        buf.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'list', ordered, items: parseListItems(buf) });
      continue;
    }
    // blank
    if (line.trim() === '') { i++; continue; }
    // paragraph
    const buf = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(```|#|>|---+|[-*]\s|\d+\.\s)/.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'p', text: buf.join('\n') });
  }
  return blocks;
}

function parseListItems(lines) {
  const items = [];
  let cur = null;
  for (const l of lines) {
    const m = l.match(/^[\s]*(?:[-*]|\d+\.)\s+(.*)$/);
    if (m) {
      if (cur) items.push(cur);
      cur = m[1];
    } else if (cur != null) {
      cur += '\n' + l.trim();
    }
  }
  if (cur) items.push(cur);
  return items;
}

function renderBlock(b, key) {
  switch (b.type) {
    case 'heading': {
      const Tag = `h${Math.min(b.level + 1, 6)}`; // demote h1→h2 since the page already has an h2
      return React.createElement(Tag, { key }, renderInline(b.text));
    }
    case 'p':
      return <p key={key}>{renderInline(b.text)}</p>;
    case 'hr':
      return <hr key={key} style={{ border: 0, borderTop: '1px solid var(--line)', margin: '16px 0' }} />;
    case 'quote':
      return <blockquote key={key}>{renderInline(b.text)}</blockquote>;
    case 'list': {
      const Tag = b.ordered ? 'ol' : 'ul';
      return React.createElement(Tag, { key }, b.items.map((it, j) => (
        <li key={j}>{renderInline(it)}</li>
      )));
    }
    case 'code':
      return <pre key={key}><code>{b.text}</code></pre>;
    default:
      return null;
  }
}

// Inline: bold, italic, code, links, autolinks for H-ids and bench-N names.
function renderInline(text) {
  if (!text) return null;
  // Tokenize. We process in passes: code spans first (so we don't markup inside them), then links, then bold/italic.
  const tokens = tokenizeInline(text);
  return tokens.map((t, i) => {
    if (typeof t === 'string') return <React.Fragment key={i}>{linkify(t)}</React.Fragment>;
    if (t.type === 'code') return <code key={i}>{t.text}</code>;
    if (t.type === 'image') return <ZoomImg key={i} src={t.href} alt={t.text} className="md-img" />;
    if (t.type === 'link') return <a key={i} href={t.href} target={t.href.startsWith('http') ? '_blank' : undefined} rel="noreferrer">{linkify(t.text)}</a>;
    if (t.type === 'bold') return <strong key={i}>{linkify(t.text)}</strong>;
    if (t.type === 'italic') return <em key={i}>{linkify(t.text)}</em>;
    return null;
  });
}

function tokenizeInline(text) {
  // Pass 1: split out backtick-code so we don't rewrite content inside it
  const out = [];
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end < 0) { buf += text[i]; continue; }
      if (buf) { out.push(buf); buf = ''; }
      out.push({ type: 'code', text: text.slice(i + 1, end) });
      i = end;
      continue;
    }
    buf += text[i];
  }
  if (buf) out.push(buf);

  // Pass 2: in each text segment, apply bold/italic/link patterns
  const out2 = [];
  for (const tok of out) {
    if (typeof tok !== 'string') { out2.push(tok); continue; }
    const parts = applyBoldItalicLink(tok);
    out2.push(...parts);
  }
  return out2;
}

function applyBoldItalicLink(text) {
  // Find first match of any pattern; recurse on the remainder.
  const imageRe = /!\[([^\]]*)\]\(([^)]+)\)/;
  const linkRe = /\[([^\]]+)\]\(([^)]+)\)/;
  const boldRe = /\*\*([^*]+)\*\*/;
  const italicRe = /(?<!\*)\*([^*]+)\*(?!\*)/;
  // Find earliest. Images (![alt](url)) must be tested before links since they
  // share the [text](url) tail — otherwise the leading `!` strands as text.
  const matches = [];
  let m;
  if ((m = text.match(imageRe))) matches.push({ idx: m.index, end: m.index + m[0].length, type: 'image', text: m[1], href: m[2] });
  if ((m = text.match(linkRe))) matches.push({ idx: m.index, end: m.index + m[0].length, type: 'link', text: m[1], href: m[2] });
  if ((m = text.match(boldRe))) matches.push({ idx: m.index, end: m.index + m[0].length, type: 'bold', text: m[1] });
  if ((m = text.match(italicRe))) matches.push({ idx: m.index, end: m.index + m[0].length, type: 'italic', text: m[1] });
  if (!matches.length) return [text];
  matches.sort((a, b) => a.idx - b.idx);
  const first = matches[0];
  const before = text.slice(0, first.idx);
  const after = text.slice(first.end);
  return [
    ...(before ? [before] : []),
    { type: first.type, text: first.text, href: first.href },
    ...applyBoldItalicLink(after),
  ];
}

// Auto-link H-ids (H001) and bench-N entries to Dash routes
function linkify(text) {
  if (typeof text !== 'string') return text;
  const re = /\b(H\d{3}[a-z]?(?!\w)|bench-\d+[a-z0-9-]*|worktree-agent-[a-z0-9]+)\b/g;
  const out = [];
  let lastIdx = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > lastIdx) out.push(text.slice(lastIdx, m.index));
    const token = m[0];
    let href = '';
    if (/^H\d/.test(token)) href = `#/hypotheses/${encodeURIComponent(token)}`;
    else if (/^bench-/.test(token)) href = `#/tests/${encodeURIComponent(token)}`;
    else if (/^worktree-agent-/.test(token)) href = `#/changes/${encodeURIComponent(token.replace(/^worktree-agent-/, ''))}`;
    out.push(<a key={m.index} href={href}>{token}</a>);
    lastIdx = m.index + token.length;
  }
  if (lastIdx < text.length) out.push(text.slice(lastIdx));
  return out;
}
