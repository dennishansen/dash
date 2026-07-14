// Normalize markdown coming out of the MDXEditor body editor before it's
// persisted. MDXEditor serializes a trailing space at the end of ANY line as the
// hex entity `&#x20;` (Lexical's way of preserving whitespace markdown would
// otherwise strip) — not just the last line. A description never wants that
// artifact, so strip a run of `&#x20;` (plus any adjacent spaces/tabs) at every
// line end, then trim whatever whitespace is left dangling at the document tail.
export function normalizeBody(md) {
  return (md || '')
    .replace(/[ \t]*(?:&#x20;)+[ \t]*$/gm, '')
    .replace(/[ \t\r\n]+$/, '');
}
