// Local-backend capability probe — the linchpin of model A.
//
// The board itself works anywhere (Supabase-direct, see board-store.js). But
// the browser terminal needs a real machine running the dev middleware with a
// repo checkout + `claude` CLI. That backend exists at /api/dash on localhost
// dev and does NOT exist on Vercel.
//
// We probe ONCE at boot: GET /api/dash returns `{ok:true}` JSON locally, but
// Vercel answers any unknown path with an HTML 404. JSON ⇒ local backend
// present (enable the terminal); HTML/404 ⇒ remote, board-only — the guarded
// UI renders "not on this machine" instead of crashing on `res.json()` of an
// HTML page.

import { useEffect, useState } from 'react';

let probe;

// Promise<boolean> — true iff a local /api/dash backend is answering.
export function hasLocalBackend() {
  if (!probe) {
    probe = fetch('/api/dash', { headers: { accept: 'application/json' } })
      .then(async (r) => {
        if (!r.ok) return false;
        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('json')) return false;
        const j = await r.json().catch(() => null);
        return !!(j && j.ok);
      })
      .catch(() => false);
  }
  return probe;
}

// React hook: null while probing, then true/false. Views gate local-only UI on
// `local === false` (show the guard) and treat null as "still deciding".
export function useLocalBackend() {
  const [local, setLocal] = useState(null);
  useEffect(() => {
    let alive = true;
    hasLocalBackend().then((v) => { if (alive) setLocal(v); });
    return () => { alive = false; };
  }, []);
  return local;
}
