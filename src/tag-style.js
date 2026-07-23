// The ONE place a tag's identity drives its chip styling, so a toned tag reads
// the same wherever a tag chip is drawn — the board card, the issue-detail
// multiselect, and anything added later. Sites call tagPillClass() instead of
// hardcoding 'field-pill--tag', which is what keeps the tone from being a
// board-card-only accident.
//
// Exact tag match, never a substring or fuzzy test: a tag is either `bug` or it
// isn't, so 'debug' or 'bugfix' stay neutral.
export const TAG_TONES = {
  bug: 'field-pill--danger',
};

export function tagPillClass(tag) {
  const tone = TAG_TONES[tag];
  return `field-pill--tag${tone ? ` ${tone}` : ''}`;
}
