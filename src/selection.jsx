import React, { createContext, useContext, useState, useEffect } from 'react';

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
const SelectionContext = createContext({ selectedId: null, setSelectedId: () => {}, chatFocused: false });

export function SelectionProvider({ children }) {
  const [selectedId, setSelectedId] = useState(null);
  const [chatFocused, setChatFocused] = useState(false);
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
    <SelectionContext.Provider value={{ selectedId, setSelectedId, chatFocused }}>
      {children}
    </SelectionContext.Provider>
  );
}

export function useSelection() { return useContext(SelectionContext); }
