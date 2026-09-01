// Throw this worktree's work away. It lives behind the sync button's chevron,
// with publishing and pulling — the other things that move a branch as a whole —
// rather than in the file tree, where "reset" reads as a view control and a
// destructive button sits one slip away from a tree you were only tidying.
//
// Destructive, so it wears the board's double opt-in: a quiet menu item, then a
// confirm that says how many changes it is about to discard.
//
// Nothing is actually destroyed. The server parks the whole state (committed
// history, the working tree, untracked files, and the staged/unstaged split) on
// a `refs/dash-reset/…` ref before it touches anything, so the second half of
// this control is Undo: one click puts the worktree back exactly as it was, and
// the ref outlives the pane for anyone who needs it from a terminal later. Undo
// refuses server-side once the worktree has moved on, which is why a failure
// here is a message and not a silent no-op.
import React from 'react';
import { plural } from './api.js';
import { MAIN_ENV } from './app-env.mjs';

async function postCode(env, action, body) {
  const response = await fetch(`/api/dash/code/${encodeURIComponent(env)}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export function DiscardChanges({ env, count, onChanged, onDone }) {
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  // `{ ref, parked }` once a reset lands: `ref` is the recovery handle, to show;
  // `parked` is the server's own token, handed back verbatim and never read
  // into. The shas in there are the server's schema, not ours.
  const [undo, setUndo] = React.useState(null);
  const [error, setError] = React.useState(null);
  // NB: nothing here clears state when `env` changes — the caller mounts this
  // keyed by env, so a different worktree gets a different component instance.
  // Clearing in an effect would leave one frame in which the previous env's
  // "Undo" is on screen while `env` already points at the new one, and a click
  // in that frame would hand one worktree's parked shas to another.

  const act = async (work) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      setConfirming(false);
      await onChanged?.();
      onDone?.();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return <button type="button" className="discard-item is-error" title={error}
      onClick={() => setError(null)}>failed</button>;
  }
  if (undo) {
    return (
      <button type="button" className="discard-item is-undo" disabled={busy}
        title={`Restore everything this reset discarded (parked at ${undo.ref})`}
        onClick={() => act(async () => {
          await postCode(env, 'undo', undo.parked);
          setUndo(null);
        })}
      >{busy ? 'restoring…' : 'Undo'}</button>
    );
  }
  if (confirming) {
    return (
      <span className="discard-confirm">
        <button type="button" className="discard-yes" disabled={busy}
          title={`Discard ${plural(count, 'change')} and put this worktree back on its base branch`}
          onClick={() => act(async () => {
            const { parked, ref } = await postCode(env, 'reset');
            if (parked) setUndo({ ref, parked });
          })}
        >{busy ? 'discarding…' : `discard ${count}`}</button>
        <button type="button" className="discard-no" title="Cancel"
          onClick={() => setConfirming(false)}>cancel</button>
      </span>
    );
  }
  // The board's sync button carries the same chevron for consistency, but the
  // primary checkout is not a worktree: it holds work nobody in this UI knows
  // about, and the endpoint refuses it. Say that here rather than let the click
  // find out.
  if (env === MAIN_ENV) {
    return <button type="button" className="discard-item" disabled
      title="Only an issue worktree can be discarded — the main checkout carries work this pane doesn't know about">discard all changes…</button>;
  }
  return (
    <button type="button" className="discard-item" disabled={!count}
      title={count ? `Discard all ${plural(count, 'change')} in this worktree` : 'Nothing to discard'}
      onClick={() => setConfirming(true)}>discard all changes…</button>
  );
}
