// Copy text, and say whether it ACTUALLY landed.
// (issue i-tailnet-secure-context)
//
// WHY A RETURN VALUE. Every copy control in the dash used to flash "copied ✓"
// unconditionally — the write was fired inside a try/catch and the flash ran in
// the next statement whether or not it threw. On the box that turned a dead
// clipboard into a LIE: the button said copied, the clipboard still held
// whatever it held before, and the id you pasted into a commit message was the
// previous one. A failed copy you can SEE costs a retry. A failed copy that
// claims success costs you the paste, and you find out later.
//
// The write is not "failing" on the box, either — it is ABSENT.
// `navigator.clipboard` is undefined outside a secure context, so
// `navigator.clipboard.writeText(...)` throws a TypeError before any copy is
// attempted, and a bare `?.` swallows it into a silent no-op. Both spellings
// were in the tree; both reported success.
//
// WHY THERE IS STILL A FALLBACK. The real fix for the box is an https origin
// (scripts/box/tailnet-serve.sh): clipboard is one of several platform APIs
// behind the secure-context gate — the mic went with it, and no fallback exists
// for that one. But a copy button should also work for someone who opened the
// short http name, and `execCommand('copy')` still does. This is the
// degradation, not the fix.
export async function copyText(text) {
  const value = String(text ?? '');
  if (!value) return false;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* denied by permission, or undelegated in this frame — try the old way */ }
  return legacyCopy(value);
}

// The pre-Clipboard-API path: put the text in a real, selectable node, select
// it, and let the browser's own copy command take it.
function legacyCopy(value) {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.setAttribute('readonly', '');
  // Off-screen, but NOT `hidden` or `display:none` — an unrendered node cannot
  // hold a selection, which is how this fallback silently copies nothing when
  // it is written the obvious way.
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  const previous = document.activeElement;
  try {
    ta.select();
    ta.setSelectionRange(0, value.length);
    return document.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    ta.remove();
    if (previous && typeof previous.focus === 'function') previous.focus();
  }
}

// Why a copy would fail here, in one line a human can act on. The insecure
// origin is the answer often enough — and invisible enough — to name it.
export function copyFailureHint() {
  const insecure = typeof window !== 'undefined' && window.isSecureContext === false;
  return insecure
    ? 'Copy failed — this origin is not secure, so the browser gives the page no clipboard. Select the value by hand, or open the https URL.'
    : 'Copy failed — select the value and copy it by hand.';
}
