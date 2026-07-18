// Which chat session each env's chat pane currently has selected. The chat
// dropdown (ChatEnvironment) owns that selection; the code pane (WorkspacePanel)
// needs it to show the same chat's LOC badge — but the two live in separate
// React trees under Shell, so this module-level store is the seam between them
// (same pattern as activity-store: state that originates in one pane and is read
// in another, no server round-trip). Keyed by env id (the issue id), value is
// the selected claude session id — the address the /api/dash/chat-status file is
// keyed by. Ephemeral, per-browser.
import { useSyncExternalStore } from 'react';

const byEnv = new Map(); // env id → selected session id (or null)
const subs = new Set();

function emit() { for (const fn of subs) fn(); }

export function setEnvSession(env, sessionId) {
  if (!env) return;
  const next = sessionId || null;
  if (byEnv.get(env) === next) return; // no-op keeps subscribers from churning
  byEnv.set(env, next);
  emit();
}

export function useEnvSession(env) {
  return useSyncExternalStore(
    (fn) => { subs.add(fn); return () => subs.delete(fn); },
    () => (env ? byEnv.get(env) ?? null : null),
  );
}
