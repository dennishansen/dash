import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

// Which board card the keyboard cursor is on, and whether that cursor currently
// lives on the board or in the chat. Lives above the router so it survives the
// board → detail → board round trip: opening an issue records its id here, and
// returning (← / Esc from the detail) lands the cursor back on that card. The
// board owns arrow movement (it knows the column/card grid); this context only
// persists the chosen id across route unmounts.
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
  selectedId: null, setSelectedId: () => {}, chatFocused: false,
  order: [], setOrder: () => {},
});

export function SelectionProvider({ children }) {
  const [selectedId, setSelectedId] = useState(null);
  const [chatFocused, setChatFocused] = useState(false);
  const [order, setOrder] = useState([]);
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
    <SelectionContext.Provider value={{ selectedId, setSelectedId, chatFocused, order, setOrder }}>
      {children}
    </SelectionContext.Provider>
  );
}

export function useSelection() { return useContext(SelectionContext); }

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
    // HashRouter: the hash is the route, updated synchronously by navigate().
    const m = window.location.hash.match(/^#\/changes\/(.+)$/);
    const cur = m ? decodeURIComponent(m[1]) : idRef.current;
    const { prevId, nextId } = neighbors(orderRef.current, cur);
    const to = dir === 'up' ? prevId : nextId;
    if (to) navigate(`/changes/${encodeURIComponent(to)}`);
  }, [navigate]);
  return { ...neighbors(order, id), go };
}
