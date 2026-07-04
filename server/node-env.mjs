// Node-only env bootstrap. Imported (for side effect) by node entry points that
// talk to Supabase — the CLI (bin/dash.mjs) and the Vite dev middleware — BEFORE
// dash-config reads process.env. It loads the DASH_SUPABASE_* keys from a local
// .env / .env.local so server-side writers authenticate as the service role and
// keep working under the tightened `issues` RLS.
//
// Why a separate module: dash-config.mjs (and issues-store.mjs) are isomorphic
// and must stay free of fs/child_process so the browser can import them. This
// file owns the node-only bits. Importing it in the browser never happens.
//
// Precedence: keys already present in the real environment win (never clobber an
// explicitly-set env var). Otherwise the first readable .env.local, then .env,
// in the current working directory, supplies them.

import fs from 'fs';
import path from 'path';

const KEYS = ['DASH_SUPABASE_URL', 'DASH_SUPABASE_ANON_KEY', 'DASH_SUPABASE_SERVICE_KEY'];

// Candidate env files, highest precedence first: .env.local then .env, resolved
// against the process cwd (where the user runs `dash` / `npm run dev`).
function candidates() {
  return [
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(process.cwd(), '.env'),
  ];
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

if (KEYS.some(k => !process.env[k])) {
  for (const file of candidates()) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const env = parse(text);
    for (const k of KEYS) if (!process.env[k] && env[k]) process.env[k] = env[k];
    // Don't break: let .env fill any key .env.local left unset.
  }
}
