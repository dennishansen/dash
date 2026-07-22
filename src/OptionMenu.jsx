// A reusable value-picker popover: a checklist over `options` with a check on the
// selected rows (toggling one leaves the menu open), plus optional `header` /
// `footer` slots and a `renderOption` override for custom row content. It carries
// the shared `.owner-menu` popover chrome, so it stands alone.
//
// Two surfaces mount it:
//   - the board's structured filters (ChangesBoard) — header = an operator
//     <select>, rows = tag / owner (avatar) / created-bucket options.
//   - the issue-detail properties bar (i-more-properties) — header = a
//     search/create input, rows = existing tags + a "Create x" option.
//
// `single` drives the ARIA off the same flag a caller uses to make the pick
// single-select, so the two can't drift: a single-select listbox is not
// multi-selectable.

import React from 'react';

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function OptionMenu({ options, selected, single, onToggle, renderOption, header, footer, className = '' }) {
  return (
    <div className={`owner-menu filter-menu${className ? ` ${className}` : ''}`}>
      {header}
      <ul className="filter-optlist" role="listbox" aria-multiselectable={!single}>
        {options.map(o => {
          const on = selected.has(o.value);
          return (
            <li key={o.value}>
              <button type="button" className={`owner-pick filter-opt${on ? ' is-current' : ''}`}
                role="option" aria-selected={on} onClick={() => onToggle(o.value)}>
                <span className="filter-check">{on ? <CheckIcon /> : null}</span>
                {renderOption ? renderOption(o) : <span className="filter-opt-label">{o.label}</span>}
              </button>
            </li>
          );
        })}
        {options.length === 0 && !footer ? <li className="owner-menu-empty dim">no values</li> : null}
      </ul>
      {footer}
    </div>
  );
}
