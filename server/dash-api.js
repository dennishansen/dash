// Dash API — read-only endpoints under /api/dash/*
//
// Serves the Dash UI sidecar at /dash/. All endpoints parse files/git in real
// time; no caching, no DB. The solver-lab orchestrator is the only writer of
// these files, so freshness comes from disk every read.

import fs from 'fs';
import path from 'path';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { gifPublicUrl, listGifs, deleteGifs, invalidateGifCache, statsHistory, loadSession } from './corpus-remote.mjs';
import { createPerTestRenderer } from './pertest-render.mjs';
import { startArchiveWatcher } from './archive-watcher.js';
import { listIssues, issueDetail, listChanges, reorderChanges, moveChange, renameChange, createChange } from './dash-issues.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..', '..');

const CORPUS_DIR = path.join(REPO, 'tests', 'solver-corpus');
const NOTES_DIR = path.join(REPO, 'docs', 'solver-lab', 'notes');
const GIFS_DIR = path.join(REPO, 'docs', 'solver-lab', 'gifs');
// The canonical corpus subdir — bucket-backed (CI renders it). Everything else
// under GIFS_DIR is experiment-branch captures that still live on disk.
const CORPUS_SUBDIR = '2026-04-20-current-state';
const HYPOTHESIS_GRAPH = path.join(REPO, 'docs', 'solver-lab', 'hypothesis-graph.yaml');
const CHAMPIONS = path.join(REPO, 'docs', 'solver-lab', 'champions.yaml');
const BASELINE = path.join(REPO, 'tests', 'solver-metrics-baseline.json');
const EXPERIMENTS_DIR = path.join(REPO, 'docs', 'solver-lab', 'experiments');

// Instant local preview render for tests created from a session (CI renders
// the canonical corpus, but can't render an uncommitted new test).
const perTest = createPerTestRenderer({ repo: REPO });

// --- helpers ---

// Run git from REPO using spawnSync — no shell, so format strings with
// special chars like '%(refname)' don't get interpreted as subshells.
// `args` is an array of git args, e.g. ['log', '--oneline', '-5'].
function git(args) {
  if (typeof args === 'string') args = args.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(s => s.replace(/^"|"$/g, '')) || [];
  try {
    const r = spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });
    if (r.status !== 0) return '';
    return r.stdout || '';
  } catch { return ''; }
}

function readJSON(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function readText(p, fallback = '') {
  try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; }
}

// Detect whether a branch has a live researcher process. Looks under
// worktrees/researchers/<branch>/researcher.pid — written by
// scripts/spawn-researcher.mjs. Returns { live, pid, worktreePath }.
// "Live" means: pid file exists AND the process is still running.
// Stale pid files (process exited) are NOT live.
function detectLiveResearcher(branch, repoPath) {
  const worktreePath = path.join(repoPath, 'worktrees', 'researchers', branch);
  const pidPath = path.join(worktreePath, 'researcher.pid');
  if (!fs.existsSync(pidPath)) return { live: false, pid: null, worktreePath: null };
  let pid;
  try { pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10); } catch { return { live: false }; }
  if (!Number.isFinite(pid) || pid <= 0) return { live: false };
  // kill(pid, 0) throws ESRCH if the process is gone; any other error
  // means it exists (EPERM means it exists but we can't signal it).
  try {
    process.kill(pid, 0);
    return { live: true, pid, worktreePath };
  } catch (e) {
    if (e.code === 'EPERM') return { live: true, pid, worktreePath };
    return { live: false, pid, worktreePath };
  }
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Tiny in-process memoization with TTL. The solver-lab orchestrator writes
// files occasionally; for list views a 10s TTL is fine. The UI can force a
// refresh by calling /api/dash/changes?nocache=1 or using the refresh
// button which sets cache-busting query params.
//
// Stored on globalThis so vite HMR reloading the module doesn't drop it.
if (!globalThis.__labCache) globalThis.__labCache = new Map();
const cache = globalThis.__labCache;
function memo(key, ttlMs, fn) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && hit.expiry > now) return hit.value;
  const value = fn();
  cache.set(key, { value, expiry: now + ttlMs });
  return value;
}
function invalidateCache() { cache.clear(); }
// Async sibling of memo() for handlers whose producer awaits I/O (e.g. the
// board-state fetch behind listChanges). Rejections are not cached — a failed
// fetch shouldn't poison the TTL window.
async function memoAsync(key, ttlMs, fn) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && hit.expiry > now) return hit.value;
  const value = await fn();
  cache.set(key, { value, expiry: now + ttlMs });
  return value;
}

// Minimal YAML parser sufficient for hypothesis-graph.yaml + champions.yaml.
// Both are hand-edited orchestrator files with predictable shape — no flow
// syntax, no anchors, only nested maps + lists + folded/literal strings.
// Keeps the Dash UI dependency-free of yaml libs.
function parseYaml(text) {
  const lines = text.split('\n');
  let i = 0;

  function indentOf(line) {
    if (!line) return 0;
    let n = 0;
    while (n < line.length && line[n] === ' ') n++;
    return n;
  }
  function isBlank(line) { return !line || /^\s*(#.*)?$/.test(line); }
  function stripComment(s) {
    // crude: remove trailing #... if it's not inside quotes
    let depth = 0; let inQ = null;
    for (let k = 0; k < s.length; k++) {
      const ch = s[k];
      if (inQ) { if (ch === inQ) inQ = null; continue; }
      if (ch === '"' || ch === "'") { inQ = ch; continue; }
      if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') depth--;
      if (ch === '#' && depth === 0) return s.slice(0, k).trimEnd();
    }
    return s.trimEnd();
  }

  function parseScalar(raw) {
    let s = raw.trim();
    if (s === '' || s === '~' || s === 'null') return null;
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (/^-?\d+$/.test(s)) return parseInt(s, 10);
    if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
    if (s.startsWith('"') && s.endsWith('"')) {
      try { return JSON.parse(s); } catch { return s.slice(1, -1); }
    }
    if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
    return s;
  }

  function parseFoldedOrLiteral(indicator, baseIndent) {
    const collected = [];
    let firstLineIndent = -1;
    while (i < lines.length) {
      const line = lines[i];
      if (line === undefined) break;
      if (isBlank(line)) { collected.push(''); i++; continue; }
      const ind = indentOf(line);
      if (ind <= baseIndent) break;
      if (firstLineIndent < 0) firstLineIndent = ind;
      collected.push(line.slice(firstLineIndent));
      i++;
    }
    if (indicator === '>') {
      const paragraphs = [];
      let buf = [];
      for (const l of collected) {
        if (l === '') {
          if (buf.length) { paragraphs.push(buf.join(' ')); buf = []; }
          paragraphs.push('');
        } else buf.push(l.trim());
      }
      if (buf.length) paragraphs.push(buf.join(' '));
      return paragraphs.join('\n').trim();
    }
    while (collected.length && collected[collected.length - 1] === '') collected.pop();
    return collected.join('\n');
  }

  function parseInlineList(s) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    const items = [];
    let depth = 0; let cur = ''; let inQ = null;
    for (const ch of inner) {
      if (inQ) { cur += ch; if (ch === inQ) inQ = null; continue; }
      if (ch === '"' || ch === "'") { inQ = ch; cur += ch; continue; }
      if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') depth--;
      if (ch === ',' && depth === 0) { items.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) items.push(cur.trim());
    return items.map(parseInlineMaybe);
  }
  function parseInlineMap(s) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return {};
    const out = {};
    let depth = 0; let cur = ''; let inQ = null;
    const parts = [];
    for (const ch of inner) {
      if (inQ) { cur += ch; if (ch === inQ) inQ = null; continue; }
      if (ch === '"' || ch === "'") { inQ = ch; cur += ch; continue; }
      if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    for (const p of parts) {
      const colon = p.indexOf(':');
      if (colon < 0) continue;
      const k = p.slice(0, colon).trim().replace(/^['"]|['"]$/g, '');
      const v = p.slice(colon + 1).trim();
      out[k] = parseInlineMaybe(v);
    }
    return out;
  }
  function parseInlineMaybe(s) {
    s = s.trim();
    if (s.startsWith('[') && s.endsWith(']')) return parseInlineList(s);
    if (s.startsWith('{') && s.endsWith('}')) return parseInlineMap(s);
    return parseScalar(s);
  }
  function parseValue(raw, baseIndent) {
    const t = raw.trim();
    if (t === '>' || t === '>-' || t === '>+') return parseFoldedOrLiteral('>', baseIndent);
    if (t === '|' || t === '|-' || t === '|+') return parseFoldedOrLiteral('|', baseIndent);
    return parseInlineMaybe(t);
  }

  function parseBlock(myIndent) {
    let result = null;
    while (i < lines.length) {
      const raw = lines[i];
      if (raw === undefined) break;
      if (isBlank(raw)) { i++; continue; }
      const ind = indentOf(raw);
      if (ind < myIndent) break;
      if (ind > myIndent) break;
      const stripped = stripComment(raw.slice(ind));
      if (stripped.startsWith('- ') || stripped === '-') {
        if (result === null) result = [];
        if (!Array.isArray(result)) break;
        const body = stripped === '-' ? '' : stripped.slice(2);
        i++;
        if (body === '') {
          result.push(parseBlock(myIndent + 2));
        } else if (body.includes(':') && !body.startsWith('"') && !body.startsWith("'") && !body.startsWith('[') && !body.startsWith('{')) {
          const colon = body.indexOf(':');
          const k = body.slice(0, colon).trim();
          const v = body.slice(colon + 1).trim();
          const obj = {};
          if (v === '') obj[k] = parseBlock(myIndent + 4);
          else obj[k] = parseValue(v, myIndent + 2);
          // collect more keys at same indent
          while (i < lines.length) {
            const r2 = lines[i];
            if (r2 === undefined) break;
            if (isBlank(r2)) { i++; continue; }
            const ind2 = indentOf(r2);
            if (ind2 < myIndent + 2) break;
            if (ind2 > myIndent + 2) break;
            const stripped2 = stripComment(r2.slice(ind2));
            if (stripped2.startsWith('- ') || stripped2 === '-') break;
            const colon2 = stripped2.indexOf(':');
            if (colon2 < 0) { i++; continue; }
            const k2 = stripped2.slice(0, colon2).trim();
            const v2 = stripped2.slice(colon2 + 1).trim();
            i++;
            if (v2 === '') obj[k2] = parseBlock(myIndent + 4);
            else obj[k2] = parseValue(v2, myIndent + 2);
          }
          result.push(obj);
        } else {
          result.push(parseScalar(body));
        }
      } else {
        if (result === null) result = {};
        if (Array.isArray(result)) break;
        const colon = stripped.indexOf(':');
        if (colon < 0) { i++; continue; }
        const k = stripped.slice(0, colon).trim();
        const v = stripped.slice(colon + 1).trim();
        i++;
        if (v === '') result[k] = parseBlock(myIndent + 2);
        else result[k] = parseValue(v, myIndent);
      }
    }
    return result === null ? {} : result;
  }
  return parseBlock(0);
}

// Markdown frontmatter — `---\n key: val\n---\n` style.
// Also handles informal frontmatter (no fence) where the first non-empty
// lines are `**Hypothesis**: ...` style.
function parseRecap(text) {
  const out = { frontmatter: {}, body: text };
  if (!text) return out;
  const fenceMatch = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (fenceMatch) {
    const yaml = fenceMatch[1];
    out.body = fenceMatch[2];
    for (const line of yaml.split('\n')) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
      if (m) out.frontmatter[m[1].toLowerCase()] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
    return out;
  }
  // Informal: scan first 30 lines for **Key**: value patterns
  const head = text.split('\n').slice(0, 30);
  for (const line of head) {
    const m = line.match(/^\*\*([A-Za-z][A-Za-z0-9 _-]*)\*\*:\s*(.*)$/);
    if (m) {
      const key = m[1].toLowerCase().replace(/\s+/g, '_');
      out.frontmatter[key] = m[2].trim();
    }
  }
  // Try to extract H-id from filename or title line
  const titleMatch = text.match(/^#\s+(H\d+\w*)\s/m);
  if (titleMatch && !out.frontmatter.hypothesis) {
    out.frontmatter.hypothesis = titleMatch[1];
  }
  return out;
}

// --- experiments enumeration ---

// Public wrapper: memoized for 60s. Internal callers (experimentDetail,
// testDetail, etc.) all hit this same cache, so repeated calls on
// one request are ~free.
function listExperiments() {
  return memo('listExperiments', 60000, listExperimentsImpl);
}

function listExperimentsImpl() {
  const items = [];
  // Single ls-remote-style query gets all branches with one git call.
  const branchOut = git(['for-each-ref', '--format=%(refname:short)|%(committerdate:iso8601)|%(objectname:short)', 'refs/heads/']);
  const allBranches = branchOut.split('\n').filter(Boolean).map(line => {
    const [name, date, sha] = line.split('|');
    return { name: (name || '').trim(), date: (date || '').trim() || null, sha: (sha || '').trim() || null };
  });

  // experiment branches: every branch except the canonical trunk + a few
  // known infrastructure branches. This is more inclusive than the earlier
  // allowlist because researchers spawned via scripts/spawn-researcher.mjs
  // create custom-named branches (phase2-h004d-via-bridge, etc.) that
  // wouldn't match a worktree-* pattern.
  const TRUNK_BRANCHES = new Set(['main', 'master']);
  const expBranches = allBranches.filter(b => !TRUNK_BRANCHES.has(b.name));

  // Decision-tag convention: an experiment's terminal state is recorded by a
  // `rejected/<branch>` tag. Merged is signalled by the branch ref no longer
  // existing — /merge deletes it after merging, and the `merged/<name>` tag
  // (surfaced below as kind:'tag') is the gravestone. So any branch still in
  // refs/heads/ is by definition outstanding (pending triage), regardless of
  // whether its tip happens to be an ancestor of main.
  const branchFull = git(['for-each-ref', '--format=%(refname:short)|%(objectname)', 'refs/heads/']);
  const fullByBranch = new Map();
  for (const line of branchFull.split('\n').filter(Boolean)) {
    const [name, sha] = line.split('|');
    fullByBranch.set((name || '').trim(), (sha || '').trim());
  }
  const rejectedByTag = new Set();
  try {
    const rejectedShas = new Set(
      git(['for-each-ref', '--format=%(objectname)', 'refs/tags/rejected/'])
        .split('\n').map(s => s.trim()).filter(Boolean)
    );
    for (const b of expBranches) {
      const full = fullByBranch.get(b.name);
      if (full && rejectedShas.has(full)) rejectedByTag.add(b.name);
    }
  } catch {}

  // Bulk: cat-file --batch-check + --batch lets us probe many tree paths in
  // one git process. Build a list of "<branch>:<file>" probes for the three
  // candidate recap locations, then batch-fetch in one process.
  const probes = []; // [{ branch, path, item }]
  const itemByBranch = new Map();
  for (const b of expBranches) {
    const id = b.name.replace(/^worktree-agent-/, '').replace(/^worktree-/, '');

    // Status classification:
    //   live      — researcher PID file exists AND process is alive
    //   rejected  — tagged rejected/<name> (the tag IS the record)
    //   pending   — anything else (branch still exists → outstanding work)
    const liveStatus = detectLiveResearcher(b.name, REPO);
    let status;
    if (liveStatus.live) status = 'live';
    else if (rejectedByTag.has(b.name)) status = 'rejected';
    else status = 'pending';
    const item = {
      id,
      branch: b.name,
      sha: b.sha,
      date_created: b.date,
      date_merged: null,
      live: liveStatus.live,
      live_pid: liveStatus.pid || null,
      worktree_path: liveStatus.worktreePath || null,
      // Subject of the latest commit on this branch that isn't on main
      // — i.e., what this branch is actually doing on top of trunk. Empty if
      // the branch hasn't diverged yet (a freshly-created worktree).
      subject: (git(['log', '-1', '--format=%s', `main..${b.name}`]) || '').trim() || null,
      status,
      kind: 'branch',
    };
    // (fallthrough — do not re-write status below)
    items.push(item);
    itemByBranch.set(b.name, item);
    probes.push({ branch: b.name, path: 'recap.md', item });
    probes.push({ branch: b.name, path: `docs/solver-lab/experiments/${id}/recap.md`, item });
    probes.push({ branch: b.name, path: '.experiment.yaml', item });
  }

  // Use git cat-file --batch to fetch all probed paths in one shot.
  // Input: "<branch>:<path>\n..." → Output: SHA + \n + <size>\n + <bytes>\n
  // (or "missing" line for absent paths).
  const batchInput = probes.map(p => `${p.branch}:${p.path}`).join('\n') + '\n';
  const batchResult = spawnSync('git', ['-C', REPO, 'cat-file', '--batch'], {
    input: batchInput,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = batchResult.stdout || Buffer.alloc(0);
  // Parse the batch output back to a map keyed by probe key.
  const recapByKey = new Map();
  let pos = 0;
  for (const probe of probes) {
    // first line: "<sha> <type> <size>" OR "<input> missing"
    const nl = out.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = out.slice(pos, nl).toString('utf8');
    pos = nl + 1;
    if (header.endsWith(' missing')) continue;
    const parts = header.split(' ');
    const size = parseInt(parts[2], 10);
    if (!Number.isFinite(size)) continue;
    const body = out.slice(pos, pos + size).toString('utf8');
    pos += size + 1; // payload + trailing \n
    recapByKey.set(`${probe.branch}:${probe.path}`, body);
  }

  // Now resolve recap for each branch: prefer post-merge canonical, then
  // recap.md root, then docs/.../recap.md, then .experiment.yaml.
  for (const item of items) {
    const mergedPath = path.join(EXPERIMENTS_DIR, item.id, 'recap.md');
    if (exists(mergedPath)) {
      const text = fs.readFileSync(mergedPath, 'utf8');
      const r = parseRecap(text);
      item.recap_path = path.relative(REPO, mergedPath);
      item.hypothesis = r.frontmatter.hypothesis || null;
      item.researcher = r.frontmatter.researcher || r.frontmatter.model || null;
      item.decision = r.frontmatter.decision || null;
      item.title = r.frontmatter.title || extractTitle(r.body);
      continue;
    }
    const rootRecap = recapByKey.get(`${item.branch}:recap.md`);
    if (rootRecap) {
      const r = parseRecap(rootRecap);
      item.recap_path = `(${item.branch}):recap.md`;
      item.hypothesis = r.frontmatter.hypothesis || null;
      item.researcher = r.frontmatter.researcher || r.frontmatter.model || null;
      item.decision = r.frontmatter.decision || null;
      item.title = r.frontmatter.title || extractTitle(r.body);
      continue;
    }
    const branchExp = recapByKey.get(`${item.branch}:docs/solver-lab/experiments/${item.id}/recap.md`);
    if (branchExp) {
      const r = parseRecap(branchExp);
      item.recap_path = `(${item.branch}):docs/solver-lab/experiments/${item.id}/recap.md`;
      item.hypothesis = r.frontmatter.hypothesis || null;
      item.researcher = r.frontmatter.researcher || r.frontmatter.model || null;
      item.decision = r.frontmatter.decision || null;
      item.title = r.frontmatter.title || extractTitle(r.body);
      continue;
    }
    const expYaml = recapByKey.get(`${item.branch}:.experiment.yaml`);
    if (expYaml) {
      const parsed = parseYaml(expYaml);
      const fm = flattenExperimentYaml(parsed);
      item.recap_path = `(${item.branch}):.experiment.yaml`;
      item.hypothesis = fm.hypothesis || null;
      item.researcher = fm.researcher || null;
      item.decision = fm.decision || null;
      // Intentionally do NOT use fm.title here: experiment.yaml describes the
      // worktree's original mission, which goes stale when a branch gets
      // reused for different work. The commit-subject fallback below reflects
      // what's actually on the branch.
    }
  }

  // Final fallback: latest commit subject. Covers non-solver-lab branches
  // (no recap.md, no experiment.yaml) and stale-mission cases where the
  // experiment.yaml description no longer matches the branch's actual work.
  for (const item of items) {
    if (!item.title && item.subject) item.title = item.subject;
  }

  // Surface decision-tags that have NO backing branch ref (the branch was
  // cleaned up post-decision). These appear as kind:'tag' items in the
  // appropriate column. legacy-* tags surface as merged for historical
  // continuity.
  const liveBranchNames = new Set(expBranches.map(b => b.name));
  const tagOut = git(['for-each-ref', '--format=%(refname:short)|%(committerdate:iso8601)|%(objectname:short)', 'refs/tags/']);
  for (const line of tagOut.split('\n').filter(Boolean)) {
    const [name, date, sha] = line.split('|');
    if (!name) continue;
    let status = null;
    let branchName = null;
    if (/^merged\//.test(name)) { status = 'merged'; branchName = name.slice('merged/'.length); }
    else if (/^rejected\//.test(name)) { status = 'rejected'; branchName = name.slice('rejected/'.length); }
    else if (/^legacy-/.test(name)) { status = 'merged'; branchName = name; }
    else continue;
    // Skip if the branch still exists — it's already in items as kind:'branch'.
    if (branchName && liveBranchNames.has(branchName)) continue;
    items.push({
      id: name,
      branch: name,
      sha: (sha || '').trim() || null,
      date_created: (date || '').trim() || null,
      date_merged: (date || '').trim() || null,
      status,
      kind: 'tag',
    });
  }

  // Annotate gif folder presence.
  for (const item of items) {
    const gifFolder = path.join(GIFS_DIR, item.id);
    item.has_gifs = exists(gifFolder);
  }

  // sort: live/pending first (still needs attention), then merged by date
  // desc, then rejected (terminal, decided-not-to-merge).
  items.sort((a, b) => {
    const order = { live: 0, pending: 1, merged: 2, rejected: 3 };
    const ao = order[a.status] ?? 4, bo = order[b.status] ?? 4;
    if (ao !== bo) return ao - bo;
    return (b.date_created || '').localeCompare(a.date_created || '');
  });

  return items;
}

// Look for a recap.md or .experiment.yaml on the branch / in canonical places.
// Orchestrator's post-merge canonical home is docs/solver-lab/experiments/<id>/recap.md;
// worker branches land a .experiment.yaml at the tree root (per solver-lab SKILL).
//
// Optimization: peek at the branch tree's root with `ls-tree` once, then
// only `show` files we know exist. Cuts blind `git show` calls roughly in half.
function findRecap(item) {
  // 1) docs/solver-lab/experiments/<id>/recap.md (post-merge canonical)
  const mergedPath = path.join(EXPERIMENTS_DIR, item.id, 'recap.md');
  if (exists(mergedPath)) {
    const text = fs.readFileSync(mergedPath, 'utf8');
    return { relPath: path.relative(REPO, mergedPath), ...parseRecap(text), text };
  }
  // Peek at the branch tree root in one call
  const rootTree = git(['ls-tree', '--name-only', item.branch]);
  const rootFiles = new Set(rootTree.split('\n').filter(Boolean).map(s => s.trim()));
  // 2) Branch tree: recap.md at root
  if (rootFiles.has('recap.md')) {
    const branchRecap = git(['show', `${item.branch}:recap.md`]);
    if (branchRecap) {
      return { relPath: `(${item.branch}):recap.md`, ...parseRecap(branchRecap), text: branchRecap };
    }
  }
  // 3) Branch tree: docs/solver-lab/experiments/<id>/recap.md
  // Only check if docs/ exists at root
  if (rootFiles.has('docs')) {
    const branchExpRecap = git(['show', `${item.branch}:docs/solver-lab/experiments/${item.id}/recap.md`]);
    if (branchExpRecap) {
      return { relPath: `(${item.branch}):docs/solver-lab/experiments/${item.id}/recap.md`, ...parseRecap(branchExpRecap), text: branchExpRecap };
    }
  }
  // 4) Branch tree: .experiment.yaml at root (worker-branch convention)
  if (rootFiles.has('.experiment.yaml')) {
    const expYaml = git(['show', `${item.branch}:.experiment.yaml`]);
    if (expYaml) {
      const parsed = parseYaml(expYaml);
      const fm = flattenExperimentYaml(parsed);
      return { relPath: `(${item.branch}):.experiment.yaml`, frontmatter: fm, body: expYaml, text: expYaml };
    }
  }
  return null;
}

// Extract the useful top-level fields from a .experiment.yaml into a flat
// frontmatter map (matches our recap frontmatter shape).
// Handles both shapes: nested {experiment: {...}, brief: {...}} and flat.
function flattenExperimentYaml(y) {
  const out = {};
  if (!y) return out;
  const exp = y.experiment || y;
  const brief = y.brief || y;
  // hypothesis id
  if (exp.id) {
    const m = String(exp.id).match(/^(H\d{3}[a-z]?|lab-[a-z0-9-]+)/);
    if (m) out.hypothesis = m[1];
  }
  if (!out.hypothesis && y.target) {
    const m = String(y.target).match(/\b(H\d{3}[a-z]?)\b/);
    if (m) out.hypothesis = m[1];
  }
  if (!out.hypothesis && (brief.direction || y.direction)) {
    const m = String(brief.direction || y.direction).match(/\b(H\d{3}[a-z]?)\b/);
    if (m) out.hypothesis = m[1];
  }
  if (exp.worker || y.worker) out.researcher = exp.worker || y.worker;
  if (exp.decision || y.decision) out.decision = exp.decision || y.decision;
  if (exp.date || y.date) out.date = exp.date || y.date;
  if (exp.slot || y.slot) out.slot = exp.slot || y.slot;
  const hypoText = brief.hypothesis || y.hypothesis;
  if (hypoText) out.title = String(hypoText).split('\n')[0].trim().slice(0, 140);
  return out;
}

function extractTitle(body) {
  if (!body) return null;
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function readBaselineForBranch(branch) {
  const text = git(['show', `${branch}:tests/solver-metrics-baseline.json`]);
  try { return JSON.parse(text); } catch { return null; }
}

function summarizeMetricsForBranch(branch) {
  const baseline = readBaselineForBranch(branch);
  if (!baseline?.gestures) return null;
  const gestures = Object.values(baseline.gestures);
  const p99s = gestures.map(g => g.metrics?.p99_solve_ms).filter(v => typeof v === 'number');
  const hardRes = gestures.map(g => g.metrics?.hard_residual_max).filter(v => typeof v === 'number');
  const trackErr = gestures.map(g => g.metrics?.tracking_max_err_px).filter(v => typeof v === 'number');
  const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  return {
    p99_solve_ms_median: median(p99s),
    hard_residual_max: hardRes.length ? Math.max(...hardRes) : null,
    tracking_max_err_px_max: trackErr.length ? Math.max(...trackErr) : null,
    gesture_count: gestures.length,
    code: baseline.code || null,
    updated: baseline.updated || null,
  };
}

// --- corpus / tests ---

async function listCorpus() {
  const items = [];
  if (!exists(CORPUS_DIR)) return items;
  const files = fs.readdirSync(CORPUS_DIR).filter(f => f.endsWith('.manifest.json'));
  const baseline = readJSON(BASELINE);
  // Gifs live in the bucket now (CI is the canonical corpus renderer); fetch
  // the listing once and prefix-match locally instead of a per-bench disk scan.
  const gifs = await listGifs();
  const hasGifFor = (name) => gifs.some(g => g.file === `${name}.gif` || g.file.startsWith(`${name}-`));
  for (const f of files) {
    const name = f.replace(/\.manifest\.json$/, '');
    const manifest = readJSON(path.join(CORPUS_DIR, f), {});
    const sessionFile = path.join(CORPUS_DIR, `${name}.json`);
    const hasSession = exists(sessionFile);
    const metrics = baseline?.gestures?.[name]?.metrics || null;
    const hasGif = hasGifFor(name);
    items.push({
      name,
      description: manifest.description || null,
      tracked: manifest.tracked || null,
      hard_gates: manifest.hard || null,
      advisory_gates: manifest.advisory || null,
      perceptual_note: manifest.perceptual_note || null,
      active: manifest.active !== false,
      has_session: hasSession,
      has_manifest: true,
      has_gif: hasGif,
      metrics,
      // In-flight local preview render (instant feedback on test create);
      // null once it's done/idle, then has_gif drives the thumbnail.
      render_status: perTest.getJobFor(name),
    });
  }
  items.sort((a, b) => {
    const am = a.name.match(/^bench-(\d+)/);
    const bm = b.name.match(/^bench-(\d+)/);
    if (am && bm) return parseInt(am[1], 10) - parseInt(bm[1], 10);
    if (am) return -1;
    if (bm) return 1;
    return a.name.localeCompare(b.name);
  });
  return items;
}

// Create a proposed (inactive) test from a recording fetched by id from the
// Supabase corpus (corpus-sessions). The session is written as-is into the
// committed corpus so replay runs the same byte-exact frames. A minimal
// manifest is generated with active:false so it lands in the Proposed section
// and isn't gated by the harness. See docs/artifact-storage.md.

// Rendering is CI-owned (docs/dashboard.md): a test created here is
// written to the corpus locally and its gif materialises after commit+push,
// when the render-corpus workflow runs. No local render path.

// Pick the [<id>.x, <id>.y] pair of the entity closest to the first
// pointerdown world coord. Falls back to all scalar keys if no
// pointerdown is found or no x/y pair matches — better to over-track
// than to track nothing and produce empty metrics.
function pickTrackedScalars(session) {
  const scalars = session.state?.scalars || {};
  const allKeys = Object.keys(scalars);
  const firstDown = session.frames?.find(f => f && f.event === 'pointerdown');
  if (!firstDown || !Array.isArray(firstDown.world)) return allKeys;
  const [wx, wy] = firstDown.world;
  let bestId = null;
  let bestDist = Infinity;
  for (const k of allKeys) {
    if (!k.endsWith('.x')) continue;
    const id = k.slice(0, -2);
    const yk = `${id}.y`;
    if (!(yk in scalars)) continue;
    const dx = scalars[k] - wx;
    const dy = scalars[yk] - wy;
    const d = dx * dx + dy * dy;
    if (d < bestDist) { bestDist = d; bestId = id; }
  }
  return bestId ? [`${bestId}.x`, `${bestId}.y`] : allKeys;
}

async function createTestFromSession({ sessionId, testName }) {
  if (!sessionId || typeof sessionId !== 'string') {
    return { error: 'sessionId required' };
  }
  const safeId = sessionId.replace(/\.json$/, '');
  // ids may carry a folder prefix (tests/<name>); allow slashes.
  if (!/^[A-Za-z0-9_\-\/]+$/.test(safeId)) {
    return { error: 'invalid sessionId — expected [A-Za-z0-9_-/]' };
  }
  const session = await loadSession(safeId);
  if (!session) {
    return { error: `session '${safeId}' not found in the Supabase corpus` };
  }
  if (!session.state || !Array.isArray(session.frames)) {
    return { error: 'session is missing state/frames — not a recording' };
  }
  // Reject sessions the harness can't replay — multiplayer/spectate
  // recordings have remote-pointer events that replay.js explicitly
  // throws on. Catch them at create time so the user gets immediate
  // feedback rather than a delayed error in the async render job.
  for (const f of session.frames) {
    if (f && typeof f.event === 'string' && f.event.startsWith('remote-')) {
      return { error: `session contains remote-pointer events (multiplayer recording); replay can't handle these. Re-record in local mode.` };
    }
  }
  // Verify the state hydrates. hydrateState throws on schema mismatches
  // or unsupported shapes — same code path the harness uses, so passing
  // here means the test will at least start replaying.
  try {
    const replayUrl = new URL('file://' + path.join(REPO, 'tests/solver-harness/replay.js')).href;
    const { hydrateState } = await import(replayUrl);
    hydrateState(session.state);
  } catch (e) {
    return { error: `session state failed to hydrate: ${e.message}` };
  }
  const rawName = (testName && String(testName).trim()) || `proposed-session-${safeId}`;
  const baseName = rawName.replace(/\.(manifest\.)?json$/, '').replace(/[^A-Za-z0-9_\-]/g, '-');
  if (!baseName) return { error: 'invalid testName' };
  // Resolve collisions by suffixing -1, -2, …
  let finalName = baseName;
  let n = 1;
  while (
    exists(path.join(CORPUS_DIR, `${finalName}.json`)) ||
    exists(path.join(CORPUS_DIR, `${finalName}.manifest.json`))
  ) {
    finalName = `${baseName}-${n++}`;
  }
  // Pick the dragged scalar (the point closest to the first pointerdown)
  // rather than tracking every scalar. The harness's tracking_*, jerk,
  // and amplification metrics aggregate over `tracked.scalars`, so a
  // grab-bag of every scalar would average over points that aren't even
  // moving. That's how every other corpus manifest is shaped.
  const trackedScalars = pickTrackedScalars(session);
  const manifest = {
    version: 1,
    description: `Created from session ${safeId} (${session.frames.length} frames).`,
    session: `${finalName}.json`,
    tracked: {
      scalars: trackedScalars,
      cursorAxis: '$mouse.x',
    },
    ignore: { prefixFrames: 0, suffixFrames: 0 },
    hard: {
      hard_residual_max: { lte: 0.01 },
      p99_solve_ms: { lte: 16 },
    },
    advisory: {
      tracking_max_err_px: { goal_lte: 1 },
      stuck_fraction: { goal_lte: 0.05 },
      jerk_max: { goal_lte: 10 },
    },
    active: false,
  };
  try {
    fs.mkdirSync(CORPUS_DIR, { recursive: true });
    fs.writeFileSync(path.join(CORPUS_DIR, `${finalName}.json`), JSON.stringify(session));
    fs.writeFileSync(
      path.join(CORPUS_DIR, `${finalName}.manifest.json`),
      JSON.stringify(manifest, null, 2) + '\n',
    );
  } catch (e) {
    return { error: `write failed: ${e.message}` };
  }
  invalidateCache();
  // Render this one bench locally for instant preview and push it to the
  // bucket (CI re-renders it canonically on the next merge). Best-effort —
  // if the local render fails, the test files are still written for CI.
  perTest.start(finalName);
  return { ok: true, name: finalName, rendering: true };
}

// Delete a corpus test: removes <name>.json + <name>.manifest.json, both
// substrate gifs, and the entry in the metrics baseline. Refuses to
// delete while a render job is in flight or queued for this name —
// otherwise files would land back on disk after we cleaned up.
async function deleteCorpusTest(name) {
  if (!name || typeof name !== 'string') return { error: 'name required' };
  if (!/^[A-Za-z0-9_\-]+$/.test(name)) return { error: 'invalid name' };
  const manifestPath = path.join(CORPUS_DIR, `${name}.manifest.json`);
  const sessionPath = path.join(CORPUS_DIR, `${name}.json`);
  if (!exists(manifestPath) && !exists(sessionPath)) {
    return { error: 'test not found' };
  }
  const removed = [];
  for (const p of [manifestPath, sessionPath]) {
    if (exists(p)) { fs.unlinkSync(p); removed.push(path.basename(p)); }
  }
  // Gifs live in the bucket now — delete them there (needs the local service
  // key). If absent, skip gracefully rather than failing the whole delete.
  try {
    removed.push(...await deleteGifs(name));
  } catch (e) {
    removed.push(`gif-delete-skipped (${e.message})`);
  }
  // Drop baseline entry so the test doesn't reappear with stale metrics.
  if (exists(BASELINE)) {
    const b = readJSON(BASELINE);
    if (b?.gestures && name in b.gestures) {
      delete b.gestures[name];
      fs.writeFileSync(BASELINE, JSON.stringify(b, null, 2) + '\n');
      removed.push('baseline-entry');
    }
  }
  invalidateCache();
  return { ok: true, removed };
}

async function corpusDetail(name) {
  const list = await listCorpus();
  const entry = list.find(e => e.name === name);
  if (!entry) return null;
  const session = readJSON(path.join(CORPUS_DIR, `${name}.json`));
  const sessionMeta = session ? {
    frame_count: session.frames?.length || session.events?.length || null,
    code_version: session.context?.codeVersion || null,
    grid_mode: session.context?.gridMode ?? null,
    solver_mode: session.context?.solverMode || null,
  } : null;
  // Gifs from the bucket: the bench's own gif plus any variants, linked by
  // their public URL so the UI fetches them straight from storage.
  const gifs = (await listGifs())
    .filter(g => g.file === `${name}.gif` || g.file.startsWith(`${name}-`))
    .map(g => ({ experiment: g.experiment, file: g.file, url: gifPublicUrl(g.experiment, g.file) }));
  // Cross-experiment history: which branches' baselines include this gesture.
  // Batch-fetch all baselines in one git cat-file call.
  const exps = listExperiments();
  const baselineByBranch = batchReadBaselines(exps.map(e => e.branch));
  const history = [];
  for (const e of exps) {
    const b = baselineByBranch.get(e.branch);
    const g = b?.gestures?.[name];
    if (g) history.push({
      experiment: e.id,
      branch: e.branch,
      status: e.status,
      metrics: g.metrics,
      trajectory_hash: g.trajectoryHash || null,
    });
  }
  return { ...entry, session_meta: sessionMeta, gifs, history };
}

// Batch fetch tests/solver-metrics-baseline.json from a list of branches in
// one git cat-file invocation. Returns Map<branch, parsedBaseline|null>.
function batchReadBaselines(branches) {
  const cached = cache.get('baselines');
  if (cached && cached.expiry > Date.now()) {
    // return a filtered subset
    const out = new Map();
    for (const b of branches) out.set(b, cached.value.get(b) || null);
    return out;
  }
  const probes = branches.map(b => `${b}:tests/solver-metrics-baseline.json`).join('\n') + '\n';
  const r = spawnSync('git', ['-C', REPO, 'cat-file', '--batch'], {
    input: probes,
    maxBuffer: 128 * 1024 * 1024,
  });
  const out = r.stdout || Buffer.alloc(0);
  const result = new Map();
  let pos = 0;
  for (const branch of branches) {
    const nl = out.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = out.slice(pos, nl).toString('utf8');
    pos = nl + 1;
    if (header.endsWith(' missing')) { result.set(branch, null); continue; }
    const parts = header.split(' ');
    const size = parseInt(parts[2], 10);
    if (!Number.isFinite(size)) { result.set(branch, null); continue; }
    const body = out.slice(pos, pos + size).toString('utf8');
    pos += size + 1;
    try { result.set(branch, JSON.parse(body)); } catch { result.set(branch, null); }
  }
  cache.set('baselines', { value: result, expiry: Date.now() + 60000 });
  return result;
}

// --- hypotheses ---

function readHypothesisGraph() {
  const text = readText(HYPOTHESIS_GRAPH);
  try {
    return parseYaml(text);
  } catch (e) {
    console.error('[dash-api] yaml parse failed:', e.message);
    return { nodes: [] };
  }
}

function listHypotheses() {
  const graph = readHypothesisGraph();
  const nodes = graph?.nodes || [];
  return nodes.map(n => {
    const linked = countLinkedNotes(n.id);
    return {
      id: n.id,
      title: n.title || null,
      class: n.class || null,
      status: n.status || 'open',
      parent: n.parent || null,
      children: n.children || [],
      problem_refs: n.problem_refs || [],
      hypothesis: n.hypothesis || null,
      result_summary: n.result_summary || null,
      commit: n.commit || null,
      created: n.created || null,
      closed: n.closed || null,
      linked_notes_count: linked.count,
      linked_notes: linked.files,
    };
  });
}

function countLinkedNotes(hid) {
  if (!hid || !exists(NOTES_DIR)) return { count: 0, files: [] };
  const files = fs.readdirSync(NOTES_DIR).filter(f => f.endsWith('.md'));
  // Match the H-id as a whole token (so H001 doesn't match H0011)
  const re = new RegExp('\\b' + hid + '\\b');
  const matched = [];
  for (const f of files) {
    const text = readText(path.join(NOTES_DIR, f));
    if (re.test(text) || re.test(f)) matched.push(f);
  }
  return { count: matched.length, files: matched };
}

function hypothesisDetail(id) {
  const list = listHypotheses();
  const node = list.find(n => n.id === id);
  if (!node) return null;
  // Linked experiments: rely on the hypothesis frontmatter that listExperiments
  // already extracted. Avoids re-fetching every branch's recap (which was
  // killing the detail endpoint at ~12s).
  const exps = listExperiments();
  const linkedExperiments = exps.filter(e => e.hypothesis === id)
    .map(e => ({ id: e.id, status: e.status, branch: e.branch, hypothesis: e.hypothesis }));
  const notes = (node.linked_notes || []).map(f => ({
    file: f,
    path: path.join('docs/solver-lab/notes', f),
    excerpt: readText(path.join(NOTES_DIR, f)).split('\n').slice(0, 30).join('\n'),
  }));
  return { ...node, linked_experiments: linkedExperiments, notes };
}

function readRecapText(item) {
  const merged = path.join(EXPERIMENTS_DIR, item.id, 'recap.md');
  if (exists(merged)) return fs.readFileSync(merged, 'utf8');
  // Tags look like '<prefix>/<name>-YYYY-MM-DD'. Try progressively
  // stripping the namespace prefix and trailing date suffix to find
  // a matching experiment dir.
  const candidates = [];
  for (const prefix of ['merged/', 'rejected/', 'archive/']) {
    if (item.id.startsWith(prefix)) {
      const stripped = item.id.slice(prefix.length);
      candidates.push(stripped);
      const dateStrip = stripped.replace(/-\d{4}-\d{2}-\d{2}$/, '');
      if (dateStrip !== stripped) candidates.push(dateStrip);
      break;
    }
  }
  for (const c of candidates) {
    const p = path.join(EXPERIMENTS_DIR, c, 'recap.md');
    if (exists(p)) return fs.readFileSync(p, 'utf8');
  }
  const branchRecap = git(['show', `${item.branch}:recap.md`]);
  if (branchRecap) return branchRecap;
  const branchExpRecap = git(['show', `${item.branch}:docs/solver-lab/experiments/${item.id}/recap.md`]);
  if (branchExpRecap) return branchExpRecap;
  // Fall back to raw .experiment.yaml — better than empty.
  const expYaml = git(['show', `${item.branch}:.experiment.yaml`]);
  if (expYaml) return '```yaml\n' + expYaml + '\n```';
  return null;
}

// Extract the gif_dir frontmatter field from a recap, if present.
// Lets an experiment explicitly declare which directory under
// docs/solver-lab/gifs/ holds its before/after captures, independent
// of the experiment-id naming.
function extractGifDirFromRecap(recapText) {
  if (!recapText) return null;
  const m = recapText.match(/^gif_dir\s*:\s*(.+)$/m);
  if (!m) return null;
  return m[1].trim().replace(/^['"]|['"]$/g, '');
}

async function experimentDetail(id) {
  const list = listExperiments();
  const item = list.find(e => e.id === id);
  if (!item) return null;
  const recapText = readRecapText(item) || '';
  const gifs = [];
  // Gif directory resolution:
  //   1. recap frontmatter `gif_dir: <name>` — explicit
  //   2. docs/solver-lab/gifs/<experiment-id>/ — by-convention
  //   3. For tagged items, also try stripping the namespace prefix
  const recapGifDir = extractGifDirFromRecap(recapText);
  const candidateDirs = [];
  if (recapGifDir) candidateDirs.push(recapGifDir);
  candidateDirs.push(id);
  for (const prefix of ['merged/', 'rejected/', 'archive/']) {
    if (id.startsWith(prefix)) {
      const stripped = id.slice(prefix.length);
      candidateDirs.push(stripped);
      const dateStrip = stripped.replace(/-\d{4}-\d{2}-\d{2}$/, '');
      if (dateStrip !== stripped) candidateDirs.push(dateStrip);
      break;
    }
  }
  for (const dirName of candidateDirs) {
    const expGifDir = path.join(GIFS_DIR, dirName);
    if (!exists(expGifDir)) continue;
    try {
      for (const f of fs.readdirSync(expGifDir)) {
        if (f.endsWith('.gif')) {
          gifs.push({
            file: f,
            url: `/dash/gifs/${encodeURIComponent(dirName)}/${encodeURIComponent(f)}`,
          });
        }
      }
    } catch {}
    break; // only use the first dir that exists
  }
  // Linked tests: corpus entries that appear in recap text or commit log
  const corpusList = await listCorpus();
  const log = git(['log', '--oneline', '-50', item.branch]);
  const blob = (recapText || '') + '\n' + log;
  const linkedTests = corpusList.filter(c => new RegExp('\\b' + escapeRegex(c.name) + '\\b').test(blob)).map(c => ({
    name: c.name,
    metrics: c.metrics,
  }));
  let hypothesisLink = null;
  if (item.hypothesis) {
    const hypos = listHypotheses();
    const h = hypos.find(n => n.id === item.hypothesis);
    if (h) hypothesisLink = { id: h.id, title: h.title, status: h.status };
  }
  const baseline = readBaselineForBranch(item.branch);
  // Trunk baseline (main's current metrics) lets the UI compute
  // per-bench deltas so Dennis sees red/green for "did this experiment
  // move the needle on this bench." Different from `baseline`, which is
  // the experiment's own snapshot at branch-creation time.
  const trunkBaseline = readJSON(BASELINE);
  const trunkBaselineGestures = trunkBaseline?.gestures || null;
  const diffStat = git(['diff', '--stat', `main...${item.branch}`]);
  const log10 = git(['log', '--oneline', '-10', item.branch]);
  // GitHub remote URL if available
  const remote = git(['config', '--get', 'remote.origin.url']).trim();
  let gitWeb = null;
  if (remote.includes('github.com')) {
    const m = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (m) {
      const [, owner, repo] = m;
      if (item.kind === 'branch') gitWeb = `https://github.com/${owner}/${repo}/tree/${item.branch}`;
      else if (item.kind === 'tag') gitWeb = `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(item.branch)}`;
    }
  }
  return {
    ...item,
    recap_text: recapText,
    gifs,
    linked_tests: linkedTests,
    corpus_names: corpusList.map(c => c.name),
    hypothesis_link: hypothesisLink,
    baseline,
    trunk_baseline_gestures: trunkBaselineGestures,
    diff_stat: diffStat.trim(),
    git_web_url: gitWeb,
    recent_commits: log10.split('\n').filter(Boolean).map(line => {
      const [sha, ...msg] = line.split(' ');
      return { sha, message: msg.join(' ') };
    }),
  };
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function topLevelState() {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const head = git(['log', '--oneline', '-1', 'HEAD']).trim();
  const baseline = readJSON(BASELINE);
  const branches = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/']).split('\n').filter(Boolean);
  // Any non-trunk branch is outstanding (see listExperimentsImpl): merged
  // branches get deleted, rejected get a tag. So branch existence alone is
  // the signal for live-or-pending.
  const TRUNK = new Set(['main', 'master']);
  let liveCount = 0;
  let pendingCount = 0;
  for (const b of branches) {
    if (TRUNK.has(b)) continue;
    const live = detectLiveResearcher(b, REPO).live;
    if (live) liveCount++;
    else pendingCount++;
  }
  return {
    branch,
    head,
    baseline_updated: baseline?.updated || null,
    baseline_code: baseline?.code || null,
    live_count: liveCount,
    pending_count: pendingCount,
    in_flight_count: liveCount + pendingCount,   // back-compat
    corpus_count: fs.existsSync(CORPUS_DIR) ? fs.readdirSync(CORPUS_DIR).filter(f => f.endsWith('.manifest.json')).length : 0,
    hypothesis_count: (listHypotheses() || []).length,
    // Board state lives in Supabase; if it's unreachable, leave the count null
    // rather than 500-ing the whole dashboard over one stat.
    change_count: await listChanges().then(c => (c || []).length).catch(() => null),
  };
}

// --- middleware factory ---

// Pinned to globalThis, NOT a module-level binding: vite restarts its dev
// server by re-evaluating this module in the same process, which would reset a
// module-level `let` to null and start a SECOND watcher while the first one's
// setInterval leaks. Those leaked timers accumulate across every restart and
// multiply git load against one .git. A process-global survives re-eval, so
// exactly one watcher runs per process no matter how many times vite restarts.
function archiveWatcher() {
  if (!globalThis.__artifactArchiveWatcher) {
    globalThis.__artifactArchiveWatcher = startArchiveWatcher({ repo: REPO });
  }
  return globalThis.__artifactArchiveWatcher;
}

export function dashApi() {
  archiveWatcher(); // auto-archive merged or rejected experiment branches
  return async (req, res, next) => {
    if (!req.url?.startsWith('/api/dash')) return next();
    res.setHeader('Cache-Control', 'no-store');
    const [pathname] = req.url.split('?');
    const segs = pathname.replace(/^\/api\/dash\/?/, '').split('/').filter(Boolean);
    const send = (data, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    try {
      // Optional cache invalidation
      if (req.url.includes('nocache=1')) invalidateCache();
      if (req.method === 'GET' && segs.length === 0) return send({ ok: true, hint: 'try /api/dash/state' });
      // Local-dev sign-in bypass: hand the browser a session minted from the
      // service token so localhost (and worktree preview links) never demand a
      // login. This route lives ONLY in the local dev middleware — it is never
      // deployed to Vercel — so production stays gated by RLS + the email
      // allow-list. The service token bypasses RLS, which is exactly what a
      // trusted local dev session wants.
      if (req.method === 'GET' && segs[0] === 'dev-session') {
        const key = process.env.DASH_SUPABASE_SERVICE_KEY;
        if (!key) return send({ error: 'no service key in env' }, 404);
        return send({
          access_token: key, refresh_token: 'dev', token_type: 'bearer',
          expires_at: 4102444800, user: { email: process.env.DASH_DEV_EMAIL || 'dev@localhost' },
        });
      }
      if (req.method === 'GET' && segs[0] === 'state') return send(await memoAsync('state', 60000, topLevelState));
      // Reorder: body { ids: [...] } → each change's rank = its index, written
      // to the issues table in Supabase (issues-store, set_ranks). Status is
      // untouched, so dragging a card within a column never changes its column
      // and the order is shared live across worktrees/machines.
      if (req.method === 'POST' && segs[0] === 'changes' && segs[1] === 'reorder') {
        let body;
        try { body = await readBody(req); } catch { return send({ error: 'invalid JSON body' }, 400); }
        const result = await reorderChanges(body?.ids);
        invalidateCache();
        return send(result, result.error ? 400 : 200);
      }
      // Move: body { status, ids } where ids is the target column's FINAL
      // ordering (dragged card inserted at the drop slot). Sets every card's
      // status to that column and renumbers ranks 0..n in one atomic bulk write
      // — the cross-column drag (issues-store, move_column).
      if (req.method === 'POST' && segs[0] === 'changes' && segs[1] === 'move') {
        let body;
        try { body = await readBody(req); } catch { return send({ error: 'invalid JSON body' }, 400); }
        const result = await moveChange(body?.status, body?.ids);
        invalidateCache();
        return send(result, result.error ? 400 : 200);
      }
      // Create: body { status, ids } where ids is the column's existing issue
      // ordering — the new blank issue is ranked ahead of it (top of column).
      // Returns { id } so the client can open the new issue's detail.
      if (req.method === 'POST' && segs[0] === 'changes' && segs[1] === 'create') {
        let body;
        try { body = await readBody(req); } catch { return send({ error: 'invalid JSON body' }, 400); }
        const result = await createChange(body?.status, body?.ids);
        invalidateCache();
        return send(result, result.error ? 400 : 200);
      }
      // Inline title rename from a card: body { id, title }.
      if (req.method === 'POST' && segs[0] === 'changes' && segs[1] === 'title') {
        let body;
        try { body = await readBody(req); } catch { return send({ error: 'invalid JSON body' }, 400); }
        const result = await renameChange(body?.id, body?.title);
        invalidateCache();
        return send(result, result.error ? 400 : 200);
      }
      // Realtime is now a browser-side Supabase subscription (dash/src/realtime.js),
      // the SAME path local and remote — there is no server SSE relay anymore.
      // ONE change management system: /api/dash/changes is the single board feed.
      // A change is a row in the Supabase issues table; live in-flight branches
      // are folded in (see listChanges). Detail dispatches by kind — an issue
      // renders its body; a branch-only change renders the experiment recap.
      if (req.method === 'GET' && segs[0] === 'changes' && segs.length === 1) return send(await memoAsync('changes', 30000, listChanges));
      if (req.method === 'GET' && segs[0] === 'changes' && segs[1]) {
        const cid = decodeURIComponent(segs.slice(1).join('/'));
        const item = (await issueDetail(cid)) || (await experimentDetail(cid));
        return item ? send(item) : send({ error: 'not found' }, 404);
      }
      // Archive watcher status — last sweep's archived/skipped branches,
      // counters, poll interval. Useful for verifying the auto-archive is
      // alive and seeing which branches got swept.
      if (req.method === 'GET' && segs[0] === 'archive-status' && segs.length === 1) {
        return send(archiveWatcher().getStatus());
      }
      // Per-commit metric snapshots — recalced + pushed to the Supabase
      // metric_runs table by CI on every merge (scripts/snapshot-metrics.mjs
      // --remote). Powers the dashboard's sparkline trend view.
      if (req.method === 'GET' && segs[0] === 'stats-history' && segs.length === 1) {
        return send({ entries: await statsHistory() });
      }
      if (req.method === 'GET' && segs[0] === 'tests' && segs.length === 1) return send(await memoAsync('tests', 2000, listCorpus));
      if (req.method === 'POST' && segs[0] === 'tests' && segs[1] === 'create-from-session') {
        let body;
        try { body = await readBody(req); } catch { return send({ error: 'invalid JSON body' }, 400); }
        const result = await createTestFromSession(body || {});
        return send(result, result.error ? 400 : 200);
      }
      if (req.method === 'DELETE' && segs[0] === 'tests' && segs[1]) {
        const result = await deleteCorpusTest(decodeURIComponent(segs[1]));
        return send(result, result.error ? 400 : 200);
      }
      if (req.method === 'GET' && segs[0] === 'tests' && segs[1] && segs[2] === 'svg') {
        // Lossless SVG export of the session's initial state. The SVG
        // carries an embedded <artifact:data> fragment, so dragging it
        // into the main app (or pasting) restores the full constraint
        // graph — not just geometry. See src/svg.js exportSVG/importSVG.
        const name = decodeURIComponent(segs[1]);
        const sessionPath = path.join(CORPUS_DIR, `${name}.json`);
        if (!exists(sessionPath)) return send({ error: 'session not found' }, 404);
        try {
          const session = readJSON(sessionPath);
          // Dynamic-import via file:// URLs so we reuse the real hydrate
          // + export paths rather than duplicating schema logic. ESM
          // import() wants a URL, not a filesystem path.
          const replayUrl = new URL('file://' + path.join(REPO, 'tests/solver-harness/replay.js')).href;
          const svgUrl    = new URL('file://' + path.join(REPO, 'src/svg.js')).href;
          const { hydrateState } = await import(replayUrl);
          const { exportSVG }    = await import(svgUrl);
          const state = hydrateState(session.state);
          const svg = exportSVG(state, { selection: new Set() });
          if (!svg) return send({ error: 'nothing exportable' }, 500);
          res.writeHead(200, {
            'Content-Type': 'image/svg+xml; charset=utf-8',
            'Content-Disposition': `attachment; filename="${name}.svg"`,
            'Cache-Control': 'public, max-age=300',
          });
          res.end(svg);
          return;
        } catch (e) {
          return send({ error: 'export failed: ' + e.message }, 500);
        }
      }
      if (req.method === 'GET' && segs[0] === 'tests' && segs[1]) {
        const item = await corpusDetail(decodeURIComponent(segs.slice(1).join('/')));
        return item ? send(item) : send({ error: 'not found' }, 404);
      }
      if (req.method === 'GET' && segs[0] === 'hypotheses' && segs.length === 1) return send(memo('hypotheses', 60000, listHypotheses));
      if (req.method === 'GET' && segs[0] === 'hypotheses' && segs[1]) {
        const item = hypothesisDetail(decodeURIComponent(segs.slice(1).join('/')));
        return item ? send(item) : send({ error: 'not found' }, 404);
      }
      if (req.method === 'GET' && segs[0] === 'note' && segs[1]) {
        const file = decodeURIComponent(segs.slice(1).join('/'));
        const full = path.join(NOTES_DIR, file);
        if (!full.startsWith(NOTES_DIR + path.sep)) return send({ error: 'forbidden' }, 403);
        if (!exists(full)) return send({ error: 'not found' }, 404);
        return send({ file, text: fs.readFileSync(full, 'utf8') });
      }
      send({ error: 'unknown endpoint' }, 404);
    } catch (e) {
      send({ error: e.message, stack: e.stack }, 500);
    }
  };
}

// Serves /dash/gifs/<exp>/<file>. The canonical corpus subdir is bucket-backed
// (CI renders it) and is served bucket-FIRST — a stale/crashed local preview
// must never shadow the canonical gif. Experiment-branch captures still live
// on disk, so those serve local-first (else redirect, for safety).
export function gifsServe() {
  return (req, res, next) => {
    if (!req.url?.startsWith('/dash/gifs/')) return next();
    const rel = decodeURIComponent(req.url.replace(/^\/dash\/gifs\//, '').split('?')[0]);
    const [experiment, ...rest] = rel.split('/');
    if (!experiment || rest.length === 0) { res.writeHead(404); res.end(); return; }
    const redirect = () => { res.writeHead(302, { Location: gifPublicUrl(experiment, rest.join('/')) }); res.end(); };
    if (experiment === CORPUS_SUBDIR) return redirect();   // canonical: bucket is truth
    const full = path.join(GIFS_DIR, rel);
    if (full.startsWith(GIFS_DIR + path.sep) && exists(full)) {
      const ext = path.extname(full).toLowerCase();
      const types = { '.gif': 'image/gif', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp4': 'video/mp4' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=300' });
      fs.createReadStream(full).pipe(res);
      return;
    }
    redirect();
  };
}
