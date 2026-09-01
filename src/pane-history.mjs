// The App pane's own back/forward stack.
//
// The pane is a browser chrome wrapped around a page, and — as in a real browser
// — the CHROME owns the session history, not the page. Here that is forced, not
// stylistic: `history.back()` is NOT scoped to the frame that calls it. A tab has
// ONE joint session history holding every entry from the top-level document and
// all nested frames, interleaved in the order they were created, and `back()`
// walks that. So a guest asked to "step its own history" steps whichever document
// navigated most recently — the dash itself, if you clicked around it after the
// pane last moved. No API makes traversal frame-local. (That was i-app-pane-history:
// the pane's ◂ walked the dash.)
//
// So the pane keeps the record itself, from the routes the guest reports, and
// moves the guest by telling it where to go (`artifact:go`) rather than asking it
// to step. Entries are (path, state) pairs — the same pair a browser stores — so
// going back restores the guest's route AND the state that entry carried, which
// is what keeps the guest's own router bookkeeping coherent. `state` is opaque
// here: the chrome stores it and never reads it.
//
// Pure and synchronous on purpose — the whole ordering problem lives in these
// four functions, so it can be tested without a browser (dash/pane-history.test.mjs).

// A pane that has heard nothing yet: no entries, so both arrows are dead. The
// host can't read a cross-origin frame's route, so the guest's first report is
// what seeds the stack — never the stored launch path, which is only where the
// pane was ASKED to open and not necessarily where it landed.
export const emptyPaneHistory = () => ({ entries: [], index: -1 });

export const paneEntry = (history) => history.entries[history.index] ?? null;

export function canStepPane(history, delta) {
  const next = history.index + delta;
  return history.index >= 0 && next >= 0 && next < history.entries.length;
}

// Record a route the guest reports. `kind` is HOW it got there, and that is the
// only thing that decides what the report means for the stack:
//   push    — a new step: everything ahead of here is no longer reachable.
//   replace — the same step, relabelled (a router redirect): overwrite in place,
//             so back doesn't land you on a route that redirects you forward again.
//   pop     — a traversal (the viewer's own browser Back happened to move the
//             frame): the guest is on an entry we may already hold, so match the
//             neighbours before recording a step.
// A report for the route we already believe we're on only refreshes that entry's
// state. That is what lets our own `artifact:go` echo back harmlessly — no ack,
// no nonce, no timer — and it means clicking the link you're already on doesn't
// stack a step whose Back appears to do nothing.
export function recordPaneRoute(history, { path, state = null, kind = 'push' }) {
  const at = (i) => history.entries[i];
  const replaceAt = (i) => {
    const entries = history.entries.slice();
    entries[i] = { path, state };
    return { entries, index: i };
  };
  if (history.index >= 0 && at(history.index).path === path) return replaceAt(history.index);
  if (kind === 'replace' && history.index >= 0) return replaceAt(history.index);
  if (kind === 'pop') {
    if (history.index > 0 && at(history.index - 1).path === path) return { ...history, index: history.index - 1 };
    if (canStepPane(history, 1) && at(history.index + 1).path === path) return { ...history, index: history.index + 1 };
  }
  const entries = history.entries.slice(0, history.index + 1);
  entries.push({ path, state });
  return { entries, index: entries.length - 1 };
}

// Step the pane one entry. Returns the moved history and the entry to send the
// guest, or null at either end — the ends are a real state here (the arrows grey
// out), not a silent no-op, because the chrome now knows where it is.
export function stepPaneHistory(history, delta) {
  if (!canStepPane(history, delta)) return null;
  const index = history.index + delta;
  return { history: { ...history, index }, target: history.entries[index] };
}
