// The empty state a dock pane shows when it has nothing to render — and, when
// there is something the person can do about it, the place that offers it.
//
// One component because there is one pattern: a headline naming the state, a
// sentence or two of plain explanation, and (optionally) the action that leaves
// the state. The chat pane established it ("No dev environment yet" → pick an
// agent → worktree + chat exist); the app pane, the code pane and the
// agent-not-installed guidance all read as the same thing, so they are the same
// thing rather than three look-alikes drifting apart.
//
// An empty state that CAN'T be acted on (a chat that lives on someone else's
// computer) uses the identical shape with no actions — the point is that the
// person always learns what is true and what, if anything, to do next, never a
// bare dead-end or a raw error.

import React from 'react';

export function PaneEmpty({ title, children, actions = null, error = null, className = '' }) {
  return (
    <div className={`pane-empty ${className}`.trim()}>
      <div className="pane-empty-inner">
        <p className="pane-empty-title">{title}</p>
        {children ? <div className="pane-empty-body">{children}</div> : null}
        {actions ? <div className="pane-empty-actions">{actions}</div> : null}
        {error ? <p className="pane-empty-err">{error}</p> : null}
      </div>
    </div>
  );
}

// The primary action inside a PaneEmpty. `tone="plain"` is the bordered variant
// the agent picker uses (several side-by-side choices, none of them "the" one);
// the default accent fill is for a single obvious next step.
export function PaneEmptyButton({ onClick, disabled, tone = 'accent', title, children }) {
  return (
    <button
      type="button"
      className={`pane-empty-btn pane-empty-btn--${tone}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}
