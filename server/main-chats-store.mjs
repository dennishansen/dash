// The MAIN chat's tracked chat list — the machine-local analog of an issue's
// Supabase `conversations[]`.
//
// WHY LOCAL, NOT SUPABASE. An issue is a shared concept, so its chats live in
// the shared board row. The main chat is not: it is the thread(s) running in
// THIS checkout's repo root, whose transcripts live on THIS machine's disk. Two
// clones on two machines have genuinely different main-root sessions, so a
// shared row would just cross-pollinate each machine with the other's
// unresumable ids. The list therefore lives on disk, namespaced per repo root
// (sha1 of MAIN_REPO) so two checkouts on one machine don't collide.
//
// SHAPE. One JSON file per repo root: `<dir>/<hash>.json` = an array of chat
// HANDLES, exactly the conversations[] format (bare uuid = claude,
// `codex:<uuid>` = codex — see agents.mjs parseHandle/formatHandle). The store
// itself is agent-agnostic: it stores and returns opaque handle strings, and
// terminal.js parses/formats them at the boundary, just as it does for an
// issue's conversations[]. A sibling `<hash>.names.json` holds the custom chat
// NAMES as sessionId → name, mirroring the `chat_names` JSONB column that rides
// beside an issue's conversations[] — same split, same two files as the row's
// two columns, so neither list has to know the other's format.
//
// NO SEEDING — an EXPLICIT list, not an inferred one. The store is only ever the
// chats the dash itself created (mint) or that were explicitly linked; a fresh
// store is empty and the client mints the first main chat (which runs /main). We
// deliberately do NOT scan ~/.claude transcripts to auto-adopt "the newest root
// session": which of many raw root sessions is "the main chat" is a guess, and
// `/clear` mutates a live session's on-disk id out from under any uuid we'd have
// stored — so an inferred seed can silently pick the wrong conversation or try to
// resume a session that is actually live elsewhere. Membership is a fact we
// record, never one we infer. LAB_MAIN_CHATS_DIR overrides the location so tests
// never touch the real store (same seam as LAB_CHAT_REGISTRY_DIR).

import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { MAIN_REPO } from './workspace-env.mjs';

function storeDir() {
  return process.env.LAB_MAIN_CHATS_DIR || path.join(os.homedir(), '.claude', 'dash-main-chats');
}

// One file per repo root — the same per-checkout namespacing the live-chat
// registry uses for its `main-<hash>` key, so two clones on one machine keep
// separate main-chat lists.
function storePath(suffix = '') {
  const hash = crypto.createHash('sha1').update(MAIN_REPO).digest('hex').slice(0, 12);
  return path.join(storeDir(), `${hash}${suffix}.json`);
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

// Atomic replace (write-temp + rename) so a crash mid-write can never leave a
// half-file that reads as "no chats".
function writeJson(p, value) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  try { fs.renameSync(tmp, p); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}

function readStore() {
  const arr = readJson(storePath(), []);
  return Array.isArray(arr) ? arr.filter((h) => typeof h === 'string') : [];
}

function writeStore(handles) { writeJson(storePath(), handles); }

function readNames() {
  const m = readJson(storePath('.names'), {});
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}

// The tracked main chats, newest-linked last (switcher order). Empty (or a
// missing/corrupt file) means "no main chats yet" — the client mints the first.
export function mainChatsList() {
  return readStore();
}

// Append a chat handle to the main list, de-duped (mirrors appendToArray).
export function linkMainChat(handle) {
  const handles = readStore();
  if (!handles.includes(handle)) writeStore([...handles, handle]);
  return { ok: true };
}

// Drop a chat handle from the main list (the transcript on disk is untouched —
// this only forgets the association, exactly like unlinking an issue chat).
export function unlinkMainChat(handle) {
  const handles = readStore();
  const kept = handles.filter((h) => h !== handle);
  if (kept.length !== handles.length) writeStore(kept);
  return { ok: true };
}

// The custom chat names, sessionId → name. {} = every main chat shows its
// derived default. Twin of an issue row's chat_names.
export function mainChatNames() {
  return readNames();
}

// Name (or un-name) one main chat, keyed by the FULL session uuid. A blank name
// DELETES the key rather than storing '', so "cleared" and "never named" are the
// same state — identical contract to the issue-row setter.
export function setMainChatName(sessionId, name) {
  if (!sessionId) return { error: 'setMainChatName requires a sessionId' };
  const names = { ...readNames() };
  const clean = typeof name === 'string' ? name.trim() : '';
  if (clean) names[sessionId] = clean;
  else delete names[sessionId];
  writeJson(storePath('.names'), names);
  return { ok: true, names };
}
