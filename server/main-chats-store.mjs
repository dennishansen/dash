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
// issue's conversations[]. A sibling `<hash>.chat-meta.json` holds sessionId →
// { name?, ordinal? }, the same map and the same contract as the `chat_meta`
// JSONB column riding beside an issue's conversations[] — same split, same two
// files as the row's two columns, so neither list has to know the other's format.
//
// NO SEEDING — an EXPLICIT list, not an inferred one. The store is only ever the
// chats the dash itself created (mint) or that were explicitly linked; a fresh
// store is empty, and the SERVER creates the first main chat on the next open
// (terminal.js ensureMainChat, which runs /main). We deliberately do NOT scan
// ~/.claude transcripts to auto-adopt "the newest root session": which of many
// raw root sessions is "the main chat" is a guess, and
// `/clear` mutates a live session's on-disk id out from under any uuid we'd have
// stored — so an inferred seed can silently pick the wrong conversation or try to
// resume a session that is actually live elsewhere. Membership is a fact we
// record, never one we infer. LAB_MAIN_CHATS_DIR overrides the location so tests
// never touch the real store (same seam as LAB_CHAT_REGISTRY_DIR).

import os from 'os';
import fs from 'fs';
import path from 'path';
import { repoKey } from './workspace-env.mjs';
import { nextChatOrdinal } from '../src/chat-list.js';

// The machine's OWN main-chat list, and the one this process is using — two
// questions, because a supervisor that is not the machine's control plane must
// be able to tell that it is pointed at the machine's list (proc-identity's
// machineRegistryDir carries the same distinction).
export function machineStoreDir() {
  return path.join(os.homedir(), '.claude', 'dash-main-chats');
}

export function storeDir() {
  return process.env.LAB_MAIN_CHATS_DIR || machineStoreDir();
}

// One file per repo root (repoKey — sha1 of MAIN_REPO), so two clones on one
// machine keep separate main-chat lists. The same per-clone id namespaces the
// mirror-sweep lease, so both agree on what "this clone" means.
function storePath(suffix = '') {
  return path.join(storeDir(), `${repoKey()}${suffix}.json`);
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

function readMeta() {
  const m = readJson(storePath('.chat-meta'), {});
  if (!m || typeof m !== 'object' || Array.isArray(m)) return {};
  const out = {};
  for (const [k, v] of Object.entries(m)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = v;
  }
  return out;
}

// Merge `fields` over one chat's entry, dropping keys set to blank/null and the
// whole entry once nothing is left — the same contract as the row's
// patchChatMeta, so "cleared" and "never recorded" are one state in both stores.
function patchMeta(sessionId, fields) {
  const meta = { ...readMeta() };
  const next = { ...(meta[sessionId] || {}) };
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || v === '') delete next[k];
    else next[k] = v;
  }
  if (Object.keys(next).length) meta[sessionId] = next;
  else delete meta[sessionId];
  writeJson(storePath('.chat-meta'), meta);
  return meta;
}

// The custom names alone, sessionId → name — what the HTTP/UI rename path
// answers with. The numbers stay in the meta map; a name is the only part of it
// anyone edits.
function namesOf(meta) {
  const out = {};
  for (const [sid, m] of Object.entries(meta)) if (m.name) out[sid] = m.name;
  return out;
}

// The tracked main chats, newest-linked last (switcher order). Empty (or a
// missing/corrupt file) means "no main chats yet" — the next ensureMainChat
// makes one.
export function mainChatsList() {
  return readStore();
}

// Add a chat to main's list: its handle, de-duped, and the number it is born
// with. The machine-local twin of the row's addChat — one call, so a listed chat
// always has a number (there is no owner to record: every main chat runs in THIS
// repo root, so its owner is by definition the person at this machine).
// WRITE-ONCE: re-linking a chat that already has a number keeps it.
// The row does both in one column write; two files cannot, so the ORDER carries
// the guarantee instead. The number goes down FIRST, so a crash between the two
// leaves an entry no list mentions: invisible, and re-linking that same session
// picks it back up (the write-once check finds it). It does cost the numbers
// that follow one place — a later chat starts past the orphan rather than on it
// — which is the cheap half of the trade. The reverse order would leave a LISTED
// chat with no number, the state this issue exists to remove.
export function linkMainChat(handle) {
  const handles = readStore();
  const sessionId = handle.slice(handle.lastIndexOf(':') + 1);
  const meta = readMeta();
  if (!Number.isInteger(meta[sessionId] && meta[sessionId].ordinal)) {
    patchMeta(sessionId, { ordinal: nextChatOrdinal(meta, handles.filter((h) => !h.endsWith(sessionId)).length) });
  }
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

// Everything this machine records about its main chats, sessionId →
// { name?, ordinal? }. {} = nothing recorded. Twin of an issue row's chat_meta.
export function mainChatMeta() {
  return readMeta();
}

// Name (or un-name) one main chat, keyed by the FULL session uuid. A blank name
// DELETES the key rather than storing '', so "cleared" and "never named" are the
// same state — identical contract to the issue-row setter. The chat's NUMBER is
// untouched: clearing a name falls back to it, it does not erase it.
export function setMainChatName(sessionId, name) {
  if (!sessionId) return { error: 'setMainChatName requires a sessionId' };
  const meta = patchMeta(sessionId, { name: typeof name === 'string' ? name.trim() : '' });
  return { ok: true, names: namesOf(meta) };
}

// Forget a main chat entirely — name and number together, when it is UNLINKED.
// The metadata belongs to the LINK, exactly as it does on an issue row.
export function forgetMainChatMeta(sessionId) {
  if (!sessionId) return { error: 'forgetMainChatMeta requires a sessionId' };
  const meta = patchMeta(sessionId, { name: '', ordinal: null });
  return { ok: true, names: namesOf(meta) };
}

// Give every already-linked main chat the number it has been displaying, taken
// from the store's link order — the machine-local half of the one-time backfill
// (board.mjs chat-ordinals). Ports the pre-numbers `<hash>.names.json` in the
// same pass, so a machine that had custom main-chat names keeps them.
export function backfillMainChatOrdinals() {
  const legacy = storePath('.names');
  const meta = { ...readMeta() };
  for (const [sid, name] of Object.entries(readJson(legacy, {}) || {})) {
    if (typeof name === 'string' && name && !meta[sid]?.name) meta[sid] = { ...(meta[sid] || {}), name };
  }
  const taken = new Set(Object.values(meta).map((m) => m && m.ordinal).filter(Number.isInteger));
  let next = 1;
  let stamped = 0;
  for (const handle of readStore()) {
    const sid = handle.slice(handle.lastIndexOf(':') + 1);
    if (Number.isInteger(meta[sid] && meta[sid].ordinal)) continue;
    while (taken.has(next)) next += 1;
    meta[sid] = { ...(meta[sid] || {}), ordinal: next };
    taken.add(next);
    stamped += 1;
  }
  writeJson(storePath('.chat-meta'), meta);
  try { fs.unlinkSync(legacy); } catch {}
  return { ok: true, stamped };
}
