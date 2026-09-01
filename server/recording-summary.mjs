// recording-summary.mjs — what a session recording says about ITSELF.
//
// A recording is one JSON object holding two very different things: the body
// (every pointer frame — hundreds of them, most of a megabyte) and the handful
// of facts you need to decide whether to open it at all. This module is the
// second thing: a pure derivation from a loaded session down to the card the
// Dash paints.
//
// There is no index beside the bucket, so the only honest source for "how long
// was it, what was said, what got drawn" is the recording itself. Keeping the
// derivation here — pure, isomorphic, one place — is what makes every surface
// that summarises a recording agree by construction, and it is the seam an index
// would slot into later without any view noticing.

// A recording's readable name. The `tests/` prefix is the classification, not
// part of what anybody calls the thing, so it drops wherever the namespace is
// already on screen.
export function shortId(id) {
  return id.startsWith('tests/') ? id.slice('tests/'.length) : id;
}

// The first thing said, which is very often the best label a recording has —
// people narrate what they are about to do before they do it. Segments are
// `{ t, tEnd, text }` in recording-clock milliseconds.
export function transcriptLine(voice) {
  for (const seg of voice || []) {
    const text = (seg?.text || '').trim();
    if (text) return text;
  }
  return null;
}

// The whole narration as one paragraph — the transcript read rather than
// scrubbed.
export function transcriptText(voice) {
  return (voice || []).map(s => (s?.text || '').trim()).filter(Boolean).join(' ');
}

// The drawing itself, reduced to what a thumbnail needs: the points and the
// segments between them, fitted into a centred unit square under ONE uniform
// scale (so a tall sketch stays tall). Everything else a document holds —
// constraints, angles, sets, edit history — has no position of its own and is
// invisible at thumbnail size, so the sketch carries only what can be drawn.
//
// World y grows downward, the same direction SVG's does, so nothing is flipped.
export function sceneSketch(state) {
  const derivations = state?.derivations || {};
  const scalars = state?.scalars || {};

  const points = new Map();
  for (const [id, node] of Object.entries(derivations)) {
    if (node?.type !== 'point') continue;
    const x = scalars[`${id}.x`];
    const y = scalars[`${id}.y`];
    if (Number.isFinite(x) && Number.isFinite(y)) points.set(id, { x, y });
  }
  const segments = [];
  for (const node of Object.values(derivations)) {
    if (node?.type !== 'line') continue;
    const a = points.get(node.inputs?.[0]);
    const b = points.get(node.inputs?.[1]);
    if (a && b) segments.push([a, b]);
  }
  if (points.size === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points.values()) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  // A single point (or a perfectly flat row of them) has no extent to fit; give
  // it a unit span so it lands in the middle instead of dividing by zero.
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const offX = (span - (maxX - minX)) / 2;
  const offY = (span - (maxY - minY)) / 2;
  const fit = (p) => ({ x: (p.x - minX + offX) / span, y: (p.y - minY + offY) / span });

  return {
    points: [...points.values()].map(fit),
    segments: segments.map(([a, b]) => [fit(a), fit(b)]),
  };
}

// One recording's card. `id` comes from the object key rather than the body:
// the key is what `/session-read` takes and what every other tool resolves by,
// and a body's own `id` field can lag it (a collision reassigns the key).
//
// WHICH END the drawing comes from is part of the card, not an implementation
// detail. `session.state` is the state replay STARTS from — it always was, the
// field is just named for its role in replay — so a recording of somebody
// drawing on a blank canvas has an empty `state` and summarising from it showed
// a blank thumbnail for exactly the sessions with something to show.
// `finalState` (recorded since this tab landed) is where the recording got to.
// Prefer it, fall back, and SAY which one you got so the caption can be true
// for the recordings made before the field existed.
export function summarizeSession(id, session) {
  if (!session) return null;
  const startTime = Number(session.startTime) || null;
  const endTime = Number(session.endTime) || null;
  const voice = Array.isArray(session.voice) ? session.voice : [];
  const final = session.finalState || null;
  const state = final || session.state;
  return {
    id,
    // A recording is in the corpus from its first second (corpus-recording.mjs),
    // so a card can be looking at one of three things: a recording still being
    // made (`open`), one the sweep finished for a browser that never stopped it
    // (`interrupted`), or one somebody stopped. Said on the card, because the
    // first two are not what a person expects a recording to be.
    status: session.open ? 'recording' : (session.interrupted ? 'interrupted' : 'stopped'),
    startTime,
    endTime,
    durationMs: startTime && endTime ? Math.max(0, endTime - startTime) : null,
    frameCount: Number(session.frameCount) || (session.frames?.length ?? 0),
    voice,
    line: transcriptLine(voice),
    scene: sceneSketch(state),
    sceneAt: final ? 'stopped' : 'started',
    shapes: countShapes(state),
    // The commit this recording RAN on, stamped by the recorder at start
    // (`dev/app-server.mjs` codeVersion). A rendered video carries the commit it
    // was RENDERED at; the two are compared so the page can say when the video
    // is not showing what the person saw. See i-faithful-recordings.
    codeVersion: session.state?.context?.codeVersion || null,
  };
}

// How much was on the canvas when the recording stopped, by kind. Not a
// thumbnail concern — a "was anything happening here" one.
export function countShapes(state) {
  const counts = { point: 0, line: 0, constraint: 0 };
  for (const node of Object.values(state?.derivations || {})) {
    if (node?.type === 'point') counts.point++;
    else if (node?.type === 'line') counts.line++;
  }
  counts.constraint = Object.keys(state?.constraints || {}).length;
  return counts;
}
