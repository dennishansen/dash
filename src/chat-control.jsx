import React from 'react';

// Channel between the issue detail view (a convo pill) and the chat panel, which
// are siblings under Shell. The provider (in main.jsx) supplies
// `requestChat(issueId, sessionId)`, which opens the panel and selects that chat.
// Lives in its own module so main.jsx ↔ ChangeDetail don't import each other.
export const ChatControlContext = React.createContext(null);
export function useChatControl() { return React.useContext(ChatControlContext); }
