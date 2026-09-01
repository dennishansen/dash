// How our app behaves when it's embedded as a guest inside the Dash App pane
// (the right-hand iframe). Shared by every entry point that can be the guest,
// because the issue's stored app_path decides which one is (`/` = canvas,
// `/dash/` = dash).
//
// The pane is a browser chrome around a page, and the chrome owns the history —
// so this side is only ever a PAGE. It does two things and no more: it says
// where it is, and it goes where it is told.
//
// It used to also "step its own history" on the host's request, which is the bug
// i-app-pane-history reported. `history.back()` is not scoped to the frame that
// calls it: a tab has ONE joint session history holding the top-level document's
// entries and every frame's, interleaved by when they were created, and back()
// walks that. Whoever navigated most recently is who moves — so pressing the
// pane's ◂ after clicking around the dash stepped the DASH. Cross-origin doesn't
// protect against it (it only stops the host READING our URL, which is why these
// messages exist at all), and nothing makes traversal frame-local. So the host
// keeps the stack (dash/src/pane-history.mjs) and sends us a destination.
//
// Why postMessage at all: the pane is cross-origin (the worktree's dev-server
// port ≠ the dash's origin), so the host can neither read our live URL nor call
// reload()/pushState on us — all throw a SecurityError. We act on ourselves
// same-origin instead, which preserves whatever route we navigated to (a
// remount-to-src would snap back to the stored app_path).
//
// We accept the ping only from our DIRECT embedder (`event.source === parent`) —
// the host frame that embeds us is always the immediate parent, and we can't
// know its origin ahead of time (a different port). That's deterministic and
// walls out any sibling/opener/other window; these messages carry no payload and
// can only ever act on our own route, so the parent gate is defense-in-depth,
// not a secret to protect. What we SEND is just our own route, which the host
// could read outright if we shared an origin — nothing to protect there either.
const routeHere = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;

export function installGuestNav() {
  if (typeof window === 'undefined' || window.self === window.top) return;

  // `kind` is how we got here — push / replace / pop. The host's stack needs it
  // to tell a new step from a redirect relabelling the step we're on; see
  // recordPaneRoute. history.state is structured-cloneable by construction (the
  // browser cloned it to store it), so it rides along untouched and comes back
  // with the entry, keeping our own router's bookkeeping intact.
  const report = (kind) => {
    window.parent.postMessage({ type: 'artifact:route', path: routeHere(), state: window.history.state, kind }, '*');
  };

  // Patching is the only way to see a same-document navigation: pushState and
  // replaceState fire no event, by design. We call through first, so what we
  // report is always what the URL already says.
  for (const name of ['pushState', 'replaceState']) {
    const original = window.history[name];
    window.history[name] = function patched(...args) {
      const result = original.apply(this, args);
      report(name === 'pushState' ? 'push' : 'replace');
      return result;
    };
  }
  window.addEventListener('popstate', () => report('pop'));
  // The entry we loaded on IS the pane's current one, not a step away from it.
  report('replace');

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || !event.data) return;
    if (event.data.type === 'artifact:reload') window.location.reload();
    else if (event.data.type === 'artifact:go' && typeof event.data.path === 'string') {
      // Restore the entry the chrome asked for the way a browser would — its URL
      // and the state it carried. pushState is silent by design, so routers hear
      // it through the popstate we raise; that is the one event every history
      // router listens to, which keeps this free of any router's specifics.
      window.history.pushState(event.data.state ?? null, '', event.data.path);
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
    }
  });
}
