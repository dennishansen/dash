import React from 'react';

// A recording's final drawing, at any size.
//
// This is the preview, and it costs nothing: the geometry is already in the
// session JSON the card had to fetch anyway, so the thumbnail is a derivation
// rather than a render job. A replay gif would be truer to what HAPPENED, but it
// is minutes of node-side ffmpeg per recording — and for the question this page
// answers ("which of these forty is the one I want"), the shape somebody drew is
// the more recognisable answer than a moving picture of them drawing it.
//
// WHICH canvas this is — where the recording got to, or where it started — is
// the summary's business, not this component's: recordings made before the
// recorder kept both ends only have the start (recording-summary.mjs).
//
// The sketch arrives already fitted to a unit square (recording-summary.mjs), so
// there is no transform here — only ink: segments first, points over them.
// Strokes are non-scaling so a 96px thumbnail and a 320px detail carry the same
// weight, and the viewBox is padded by a point's radius so nothing on the
// boundary is clipped in half.
export function SceneSketch({ scene, size = 96, title }) {
  if (!scene?.points?.length) return null;
  const pad = 0.06;
  return (
    <svg
      className="scene-sketch"
      width={size}
      height={size}
      viewBox={`${-pad} ${-pad} ${1 + pad * 2} ${1 + pad * 2}`}
      role="img"
      aria-label={title || 'drawing'}
    >
      {scene.segments.map(([a, b], i) => (
        <line key={`s${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
          vectorEffect="non-scaling-stroke" />
      ))}
      {scene.points.map((p, i) => (
        <circle key={`p${i}`} cx={p.x} cy={p.y} r={2.6 / size} />
      ))}
    </svg>
  );
}
