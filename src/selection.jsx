import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

// Which board card the keyboard cursor is on, and whether that cursor currently
// lives on the board or in the chat. Lives above the router so it survives the
// board → detail → board round trip: opening an issue records its id here, and
// returning (← / Esc from the detail) lands the cursor back on that card. The
// board owns arrow movement (it knows the column/card grid); this context only
// persists the chosen id across route unmounts.
//
// Selection has TWO ends, file-list style: `selectedId` is the focus (the moving
// cursor — the card the detail opens, ⌘S copies, arrows walk) and `anchorId` is
// the fixed end of a Shift-extended range. A single selection is the invariant
// `anchorId === selectedId`; a Shift+Arrow run keeps the anchor while the focus
// moves, so the contiguous cards between them are selected. The board (which
// knows the column/card structure) derives the actual highlighted set from the
// two ends; this context just persists them. `setSelection(focus, anchor=focus)`
// is the one writer — a plain move passes only the focus (anchor collapses → one
// card); an extend passes the kept anchor.
//
// chatFocused mirrors the Shell's ⌘→/⌘← focus toggle (the same dash:focus-chat /
// dash:focus-board events the chat pane listens to): ⌘→ moves the cursor into
// the chat, ⌘← brings it back to the board. The card outline is suppressed while
// the chat holds the cursor, so the selection silently reappears on its last
// card the moment focus returns to the board.
// `order` is the board's flat visible card order (visible columns in board
// order, each in its displayed sort) — published by ChangesBoard whenever it
// changes. It's the rail the detail view's prev/next navigation (⌘↑/⌘↓ and the
// breadcrumb chevrons) moves along, so detail nav walks exactly what the board
// shows: same filters, same hidden columns, same drag order.
const SelectionContext = createContext({
  selectedId: null, anchorId: null, setSelection: () => {}, chatFocused: false,
  order: [], setOrder: () => {},
});

export function SelectionProvider({ children }) {
  const [selectedId, setSelectedId] = useState(null);
  const [anchorId, setAnchorId] = useState(null);
  const [chatFocused, setChatFocused] = useState(false);
  const [order, setOrder] = useState([]);
  // The single writer. Passing one id collapses the anchor onto the focus (a
  // single selection); passing a second id keeps that anchor (a Shift range).
  const setSelection = useCallback((focus, anchor = focus) => {
    setSelectedId(focus);
    setAnchorId(anchor);
  }, []);
  useEffect(() => {
    const toChat = () => setChatFocused(true);
    const toBoard = () => setChatFocused(false);
    window.addEventListener('dash:focus-chat', toChat);
    window.addEventListener('dash:focus-board', toBoard);
    return () => {
      window.removeEventListener('dash:focus-chat', toChat);
      window.removeEventListener('dash:focus-board', toBoard);
    };
  }, []);
  return (
    <SelectionContext.Provider value={{ selectedId, anchorId, setSelection, chatFocused, order, setOrder }}>
      {children}
    </SelectionContext.Provider>
  );
}

export function useSelection() { return useContext(SelectionContext); }

// Event-time route predicates (HashRouter). Keyboard scopes use these to check
// the CURRENT route at keydown rather than React's post-render `visible`/mount
// state, which lags a frame behind navigation. That frame is the race: the board
// stays mounted (its listeners still attached) and the detail is mid-unmount just
// after an Enter/⌘← navigation, so a fast second chord would otherwise fire in
// the wrong scope — the board reordering a card you just left, or the detail
// re-navigating from the board. We match the hash PATHNAME only — stripping the
// query the same way the router derives `pathname` — so a filtered board route
// like `#/changes?tag=x` (a TagPill link) still counts as the board, and
// `#/changes/?tag=x` (trailing slash, no id) is the board, not a detail.
const hashPath = () => (window.location.hash || '').replace(/^#/, '').split('?')[0];
export const isBoardRoute = () => /^\/changes\/?$/.test(hashPath());
// The open issue id from the hash — tolerant of a trailing slash
// (`/changes/<id>/`, which the router treats as the same route) and, via
// hashPath, a query. This is the ONE detail-route parser: isDetailRoute and
// useIssueNav.go both read it, so "is this a detail route" and "which id" can't
// disagree (they did when go() kept the trailing slash and fell off the rail).
export const detailId = () => {
  const m = hashPath().match(/^\/changes\/(.+?)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
};
export const isDetailRoute = () => detailId() != null;

const neighbors = (order, id) => {
  const i = id == null ? -1 : order.indexOf(id);
  return {
    prevId: i > 0 ? order[i - 1] : null,
    nextId: i >= 0 && i < order.length - 1 ? order[i + 1] : null,
  };
};

// Prev/next issue navigation on the published rail, shared by the detail
// view's ⌘↑/⌘↓ and the breadcrumb chevrons. `prevId`/`nextId` are render-time
// neighbors of `id` — for disabled states. `go(dir)` is the navigation itself,
// and it recomputes the target from the LIVE location at call time: navigate()
// moves the hash synchronously but React re-renders (and hands the surfaces
// fresh neighbors) later, so a fast second chord or click would otherwise fire
// against stale neighbors and re-aim at the issue it's already on, losing the
// step. Clamps at either end (no wrap — same contract as the board cursor) and
// goes inert when the current issue isn't on the rail (filtered out / hidden
// column).
export function useIssueNav(id) {
  const { order } = useSelection();
  const navigate = useNavigate();
  const orderRef = useRef(order);
  orderRef.current = order;
  const idRef = useRef(id);
  idRef.current = id;
  const go = useCallback((dir) => {
    // HashRouter: the hash is the route, updated synchronously by navigate(). Read
    // the id through the shared detailId() parser (query- and trailing-slash-safe)
    // so `#/changes/<id>?x=1` and `#/changes/<id>/` both yield <id> — not a value
    // with the query/slash attached, which would fall off the rail (prev/next inert).
    const cur = detailId() ?? idRef.current;
    const { prevId, nextId } = neighbors(orderRef.current, cur);
    const to = dir === 'up' ? prevId : nextId;
    if (to) navigate(`/changes/${encodeURIComponent(to)}`);
  }, [navigate]);
  return { ...neighbors(order, id), go };
}
