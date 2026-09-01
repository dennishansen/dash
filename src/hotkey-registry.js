// The one catalog of every Dash keyboard shortcut — shortcuts as DATA, with the
// overlay and every control's hover hint as VIEWS of that data. Before this,
// each chord lived twice: the `useHotkey('Mod+KeyK', …)` binding AND a
// hand-typed `title="… (⌘K)"` tooltip, edited in two places and free to drift.
// Here a shortcut is declared ONCE; the binding pulls its combo from the entry
// (`hk(id)`), the tooltip pulls its rendered caps (`hkCaps(id)` / `hkTitle(id)`),
// and the overlay (ShortcutsOverlay.jsx) renders the whole list grouped by scope.
//
// This is the source of truth `docs/hotkeys.md` now points at. It does NOT
// replace `useHotkey` (dash/src/hotkeys.js) — it FEEDS it: the focus-model that
// keeps chords alive over the chat terminal still lives there; this only owns
// which combo each named shortcut is and how it reads on screen.
//
// An entry is `{ id, (combos | keys), label, scope, twin? }`:
//   • combos — one or more `useHotkey` combo strings, for a shortcut that is one
//     binding (⌘K) OR several that read as one row but share nothing to bind by.
//   • keys — a CLUSTER that is several distinct bindings under one label (the
//     card cursor `↑↓←→` is four): a `{ name: combo }` map so each call site binds
//     `hk(id, name)` (e.g. `hk('boardCursor','up')`). This is what makes the
//     registry the ONE source even for clusters — the combo is never re-typed at
//     the call site. `combos` is derived from `keys` for display (see below).
//   • label — what the shortcut does, in plain words.
//   • scope — which surface it fires on; groups the overlay and (optionally) dims
//     out-of-context rows. See SCOPES.
//   • twin — the pointer affordance that mirrors it, if any (a control whose
//     tooltip sources from this entry, or a raw gesture like drag/click). Its
//     presence is `hasPointerTwin`; it's metadata + documentation, not rendered.

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');

// Modifier token → its rendered cap. `Mod` is the platform primary (⌘ on mac,
// Ctrl elsewhere) — the same rule `useHotkey` binds by, so the hint always
// matches the key that actually fires.
const MOD_CAP = {
  mod: IS_MAC ? '⌘' : 'Ctrl',
  meta: '⌘', cmd: '⌘', '⌘': '⌘',
  ctrl: '⌃', control: '⌃',
  alt: '⌥', option: '⌥',
  shift: '⇧',
};
const MOD_ORDER = ['ctrl', 'alt', 'shift', 'mod', 'meta']; // caps read ⌃⌥⇧⌘, modifiers before the key

// Key token → its rendered cap. Anything unlisted falls through to a KeyX-strip +
// uppercase (so `KeyK`→K, `f`→F) — layout-proof, matching how `useHotkey` reads
// `e.code`/`e.key`.
const KEY_CAP = {
  arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
  enter: '↵', escape: 'Esc', esc: 'Esc',
  slash: '/', space: '␣', tab: '⇥', backspace: '⌫', delete: '⌦',
};

// A shifted key that renders as its symbol, not ⇧+base — Shift+/ IS `?`, so the
// overlay opener reads `?` rather than `⇧/`. (US layout; the Dash is Mac-first.)
const SHIFTED_SYMBOL = { slash: '?' };

// Parse a combo string into { mods:Set, key } — the display twin of
// hotkeys.js's parseCombo (which produces the MATCH spec). Kept here so the
// registry has no import cycle with the primitive.
function parse(combo) {
  const mods = new Set();
  let key = '';
  for (const raw of combo.split('+')) {
    const p = raw.trim();
    if (!p) continue;
    const lp = p.toLowerCase();
    if (lp in MOD_CAP) mods.add(lp === 'cmd' || lp === '⌘' ? 'meta' : lp === 'option' ? 'alt' : lp === 'control' ? 'ctrl' : lp);
    else key = p;
  }
  return { mods, key };
}

// One combo → its cap tokens, e.g. 'Mod+KeyK' → ['⌘','K'], 'Alt+ArrowUp' →
// ['⌥','↑'], 'Shift+Slash' → ['?']. Returned as an array so the overlay can box
// each cap in its own <kbd>; formatCombo joins them for a plain-text title.
export function comboCaps(combo) {
  const { mods, key } = parse(combo);
  const lk = key.toLowerCase();
  // A shifted symbol subsumes its ⇧ — '?' already means "shift held".
  if (mods.has('shift') && SHIFTED_SYMBOL[lk] && mods.size === 1) return [SHIFTED_SYMBOL[lk]];
  const caps = [];
  for (const m of MOD_ORDER) if (mods.has(m)) caps.push(MOD_CAP[m]);
  if (key) caps.push(KEY_CAP[lk] ?? key.replace(/^Key/, '').toUpperCase());
  return caps;
}

// One combo → its plain-text rendering, e.g. 'Mod+KeyK' → '⌘K'. For titles.
export function formatCombo(combo) {
  return comboCaps(combo).join('');
}

// Overlay grouping. Order here is the order the overlay paints the sections.
// `routeScope` marks the two mutually-exclusive route surfaces (board vs detail)
// so the overlay can dim the one you're NOT on; global/panel/text always apply.
export const SCOPES = [
  { key: 'global', label: 'Everywhere' },
  { key: 'board', label: 'Issue board', routeScope: true },
  { key: 'detail', label: 'Issue detail', routeScope: true },
  { key: 'panel', label: 'App panel' },
  { key: 'text', label: 'Text editors' },
];

// Every Dash shortcut, once. Grouped by scope in declaration order (that's the
// overlay's order too). Combos MUST match the `useHotkey` call sites verbatim —
// `hk(id)` feeds them straight back in.
export const HOTKEYS = [
  // ── Everywhere ──────────────────────────────────────────────────────────
  { id: 'search', combos: ['Mod+KeyK'], label: 'Search issues', scope: 'global', twin: 'search icon' },
  { id: 'shortcuts', combos: ['Shift+Slash'], label: 'This shortcuts list', scope: 'global', twin: 'keyboard button' },

  // ── Issue board ─────────────────────────────────────────────────────────
  // Clusters: `keys` maps each binding to a direction name the call site uses
  // (`hk('boardCursor','up')`), so the combo is declared ONCE, here.
  { id: 'boardCursor', keys: { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' }, label: 'Move the card cursor', scope: 'board' },
  { id: 'boardJump', keys: { top: 'Alt+ArrowUp', bottom: 'Alt+ArrowDown' }, label: 'Jump to column top / bottom', scope: 'board' },
  { id: 'boardExtend', keys: { up: 'Shift+ArrowUp', down: 'Shift+ArrowDown' }, label: 'Extend selection up / down', scope: 'board' },
  { id: 'boardReorder', keys: { up: 'Mod+ArrowUp', down: 'Mod+ArrowDown' }, label: 'Reorder selected card', scope: 'board', twin: 'drag' },
  { id: 'boardOpen', combos: ['Enter'], label: 'Open card · toggle column', scope: 'board', twin: 'click' },
  { id: 'boardCopyId', combos: ['Mod+KeyS'], label: "Copy selected card's id", scope: 'board' },
  { id: 'boardDismissFlag', combos: ['Mod+Escape'], label: "Dismiss selected card's needs-input flag", scope: 'board' },
  { id: 'focusChat', combos: ['Mod+ArrowRight'], label: 'Move focus to the chat', scope: 'board' },
  { id: 'focusBoard', combos: ['Mod+ArrowLeft'], label: 'Move focus to the board', scope: 'board' },
  { id: 'viewToggle', combos: ['Mod+KeyL'], label: 'Board / list layout', scope: 'board', twin: 'view toggle' },

  // ── Issue detail ────────────────────────────────────────────────────────
  // Two keys for one action — the ⌘← chord (fires over the chat terminal) and a
  // bare Esc (yields to it). Both navigate to the list; both belong in the list.
  { id: 'detailBack', keys: { arrow: 'Mod+ArrowLeft', esc: 'Escape' }, label: 'Back to the issues list', scope: 'detail', twin: 'issues crumb' },
  { id: 'issuePrev', combos: ['Mod+ArrowUp'], label: 'Previous issue', scope: 'detail', twin: 'crumb chevron' },
  { id: 'issueNext', combos: ['Mod+ArrowDown'], label: 'Next issue', scope: 'detail', twin: 'crumb chevron' },
  { id: 'detailDismissFlag', combos: ['Mod+Escape'], label: "Dismiss this issue's needs-input flag", scope: 'detail', twin: '✕ idle button' },
  { id: 'detailCopyId', combos: ['Mod+KeyS'], label: "Copy this issue's id", scope: 'detail', twin: 'copy-id crumb' },

  // ── App panel ───────────────────────────────────────────────────────────
  { id: 'appCode', combos: ['Mod+KeyE'], label: 'Toggle App / Code', scope: 'panel', twin: 'App/Code tabs' },
  { id: 'appLink', keys: { prev: 'Mod+Alt+ArrowUp', next: 'Mod+Alt+ArrowDown' }, label: 'Previous / next app link', scope: 'panel', twin: 'address ⌃⌄ steppers' },

  // ── Text editors ────────────────────────────────────────────────────────
  // The description saves itself as you pause, so there is nothing to commit or
  // abandon — both combos mean the same thing: stop editing.
  { id: 'bodyDone', combos: ['Mod+Enter', 'Escape'], label: 'Finish editing the description', scope: 'text', twin: 'click outside' },
];

// Normalize: a cluster declares `keys` (name→combo); its `combos` (the display
// list) is derived from it, so a combo string is written exactly ONCE per entry.
for (const h of HOTKEYS) if (!h.combos) h.combos = Object.values(h.keys);

const BY_ID = new Map(HOTKEYS.map((h) => [h.id, h]));

function entry(id) {
  const e = BY_ID.get(id);
  if (!e) throw new Error(`[hotkeys] unknown shortcut id "${id}"`);
  return e;
}

// The combo to feed `useHotkey`.
//   • `hk('search')` — a single-binding entry returns its sole combo.
//   • `hk('boardCursor', 'up')` — a CLUSTER returns the combo for that direction
//     name, so each of the several call sites binds one key straight from the
//     registry (no re-typed literals, no positional coupling).
// Misuse throws (like an unknown id/name) rather than best-effort — asking a
// cluster for "the" combo would silently bind one quarter of the action.
export function hk(id, name) {
  const e = entry(id);
  if (e.keys) {
    if (name == null) throw new Error(`[hotkeys] hk("${id}") is a cluster — name a key, e.g. hk("${id}", "up").`);
    const combo = e.keys[name];
    if (!combo) throw new Error(`[hotkeys] hk("${id}", "${name}") — no such cluster key`);
    return combo;
  }
  if (name != null) throw new Error(`[hotkeys] hk("${id}", "${name}") — "${id}" is not a cluster`);
  return e.combos[0];
}

// The rendered caps for a shortcut's hover hint / overlay, e.g. '⌘K', or
// '↑ ↓ ← →' for a cluster (each combo formatted, space-separated).
export function hkCaps(id) {
  return entry(id).combos.map(formatCombo).join(' ');
}

// A ready-made title string: '<label> (<caps>)', e.g. 'Search issues (⌘K)'.
// Controls with richer tooltips compose from hkCaps instead.
export function hkTitle(id) {
  const e = entry(id);
  return `${e.label} (${hkCaps(id)})`;
}

export function hasPointerTwin(id) {
  return Boolean(entry(id).twin);
}
