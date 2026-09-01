// Node-only env bootstrap. Imported (for side effect) by node entry points that
// write to Supabase — board.mjs and the dev middleware — BEFORE issues-store
// reads process.env. It loads DASH_SUPABASE_SERVICE_KEY (and the project URL/anon
// overrides) from .env.local so those writers authenticate as the service role
// and keep working after the `issues` RLS is tightened to authenticated-only.
//
// Why a separate module: issues-store.mjs is isomorphic and must stay free of
// fs/child_process so the browser can import it. This file owns the node-only
// bits. Importing it in the browser is a no-op-by-omission — nobody does.
//
// .env.local lives in the MAIN checkout (gitignored, absent from worktrees), so
// from a worktree we resolve it via git's common dir — deterministic, not a
// guess. Keys already present in the environment win — including present-but-
// empty, which is how a caller deliberately runs keyless (dotenv convention;
// snapshot.test.js relies on it to simulate a machine without the service key).

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const KEYS = ['DASH_SUPABASE_SERVICE_KEY', 'DASH_SUPABASE_URL', 'DASH_SUPABASE_ANON_KEY', 'GROQ_API_KEY', 'DASH_ALLOWED_HOSTS', 'DASH_ALLOWED_ORIGINS', 'DASH_TERMINAL_TOKEN', 'DASH_DEV_EMAIL', 'DASH_BIND_HOST', 'DASH_TRUSTED_PEERS', 'DASH_TRUSTED_FRONT', 'DASH_SHELL'];

// Candidate .env.local locations: cwd, then the main repo root (git common dir's
// parent — the same file every worktree shares).
function candidates() {
  const out = [path.resolve(process.cwd(), '.env.local')];
  try {
    const common = execSync('git rev-parse --path-format=absolute --git-common-dir', { encoding: 'utf8' }).trim();
    if (common) out.push(path.join(path.dirname(common), '.env.local'));
  } catch {}
  return [...new Set(out)];
}

function parse(text) {
  const env = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

if (KEYS.some(k => process.env[k] === undefined)) {
  for (const file of candidates()) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const env = parse(text);
    for (const k of KEYS) if (process.env[k] === undefined && env[k]) process.env[k] = env[k];
    break; // first readable .env.local wins
  }
}
