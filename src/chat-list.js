// What an environment's chats are CALLED and what ORDER they stand in. Pure —
// no React, so it is unit-testable in node (see dash/chat-order.test.mjs) and
// shared by the switcher, the trigger and the rename field, which must all agree
// about what a chat is called.
//
// The rule this module exists to hold: a chat's name is a fact about the CHAT,
// and its position is a fact about the LIST, and the two never touch. They used
// to be the same thing — the label was the row index — so every reorder renamed
// everything (i-chat-stored-names).

// What a chat is CALLED: the name the user gave it if there is one, else the
// NUMBER it was born with — stamped into the env's chat metadata when the chat
// was linked, beside the machine it lives on, and never recomputed.
//
// A chat with neither — one this env never linked, so nothing ever named or
// numbered it: an editor's conversation, a chat the sweep found in a folder —
// goes by its handle. An honest id beats a number meaning "third from the top,
// for now".
export function chatDefaultLabel(c) {
  return c.ordinal ? `chat ${c.ordinal}` : (c.sessionId || '').slice(0, 8);
}

// The same name, plus what it can't do. "(unavailable)" reports liveness, not
// identity, so naming a chat never hides that it can't resume — and it is a
// genuinely narrow state: a chat that can neither be RUN here nor READ from the
// shared copy. A chat on someone else's computer is not unavailable (you can
// read every word of it), a chat with a mirrored copy never is either, and
// neither is one whose workspace was merely collected — that one is a click
// from running here (`restorable`), which is the opposite of unavailable.
export function chatLabel(c, machine) {
  const name = c.name || chatDefaultLabel(c);
  if (c.resumable || c.restorable || c.readable || chatElsewhere(c, machine)) return name;
  return `${name} (unavailable)`;
}

// Is this chat known to live on ANOTHER computer? Null means "no" — including
// every case where we simply don't know.
//
// Deliberately narrow. It requires a RECORDED host that differs from this
// machine's; a chat that merely has no transcript here is NOT known to be
// elsewhere. It may be seconds old, with its agent yet to write one. Treating
// "no transcript" as "lives elsewhere" replaced the terminal with an empty state
// for brand-new chats and blanked the pane — so the only thing that counts is
// the stamp, and everything else keeps the existing behaviour (the pane mounts
// and the socket reports honestly).
export function chatElsewhere(c, machine) {
  if (!c || c.resumable) return null;
  if (!c.host || !machine || c.host === machine) return null;
  return { kind: 'other-machine', host: c.host, owner: c.owner };
}

// The env's chats from BOTH sources, as one list.
//
// Two questions about a chat used to be one: "is it here?" also decided "can I
// see it?". They are now separate. The LOCAL dash says which chats can RUN on
// this computer; the shared corpus says which can be READ, from anywhere. A
// chat can be either, both, or — briefly, while its first turns are still being
// written — only the first.
//
// Local entries win on the fields the local dash knows better (liveness, the
// worktree it resumes into); the mirror contributes the chats this machine has
// never seen, which is exactly a teammate's work appearing on your board.
//
// EXACTLY ONE source names each chat. A chat the local dash listed was named
// from the env's own metadata, so its `name` is the answer — including `null`,
// which means "no name", not "ask someone else". Falling back to the corpus
// title there let a cleared name come back from under the person who cleared it
// and stay: the corpus title is a copy the sweep refreshes on its own cadence,
// and a chat that never speaks again is never swept again.
//
// `meta` — the issue row's `chat_meta`, which the board already holds — names the
// entries the local list did NOT cover. On a board with no dash behind it that is
// EVERY entry, and reading the row here is what keeps a teammate seeing "chat 2"
// rather than a bare handle. Only then is the corpus title a fallback, for a chat
// this env never linked and so never named.
//
// This does NOT order the list — byRecentActivity does. What comes out is link
// order, with what only the mirror knows appended. The old first_turn_at sort
// lived here to make a chat's ROW INDEX mean something, and the index no longer
// names anything; a chat's `updated` is now the later of what the two sources
// say, because for a chat on someone else's computer only the corpus knows at
// all.
export function mergeChats(local, mirrored, meta) {
  const out = (local || []).map((c) => ({ ...c, readable: false }));
  const seen = new Map(out.map((c, i) => [c.sessionId, i]));
  for (const m of mirrored || []) {
    const said = m.last_turn_at ? Date.parse(m.last_turn_at) || 0 : 0;
    const at = seen.get(m.session_id);
    if (at != null) {
      out[at] = { ...out[at], readable: true, updated: Math.max(out[at].updated || 0, said) };
      continue;
    }
    // Having an ENTRY is what makes the env authoritative about this chat, not
    // having a name in it: an entry with no `name` is a chat whose name was
    // cleared, and the corpus title is the copy that was cleared. Only a chat the
    // env has no entry for — one it never linked — takes the corpus title.
    const stored = (meta || {})[m.session_id];
    out.push({
      sessionId: m.session_id, agent: m.agent, role: null,
      name: (stored ? stored.name : m.title) || null,
      ordinal: Number.isInteger(stored?.ordinal) ? stored.ordinal : null,
      owner: m.owner || null, host: m.host || null,
      resumable: false, live: false, readable: true, cwd: null,
      updated: said,
    });
  }
  return out;
}

// Most recently active first, and NOTHING else — what every chat list does, and
// the honest version of "the one you want is probably on top".
//
// Being LIVE is not a rank. The list used to float live chats above every
// timestamp, which is how a chat left open since yesterday outranked the one you
// spoke in a minute ago; a live chat's `updated` now reports when it last
// actually said something (server-side chatRunState), so it competes on the same
// terms as everything else.
//
// Ties — chats that have never run — break to the most recently LINKED, read off
// the stored number rather than the chat's position in the input. Position is not
// link order for a chat that arrived from the corpus: those rows come back
// ordered by `last_turn_at desc nullslast`, and among the nulls SQL promises
// nothing, so silent remote chats could swap places between fetches and take the
// auto-open with them. The number IS link order, stored, and it never moves.
//
// A TOTAL order, ending in the session id: two chats that tie on everything else
// must not be left to the input's order, which is exactly the nondeterminism
// above one layer down.
export function byRecentActivity(a, z) {
  return (z.c.updated || 0) - (a.c.updated || 0)
    || (z.c.ordinal || 0) - (a.c.ordinal || 0)
    || String(a.c.sessionId || '').localeCompare(String(z.c.sessionId || ''));
}

// The list as the switcher shows it, ordered by activity. Each chat is paired
// with its input index so callers can key rows without a second pass; nothing
// about a row reaches the label.
export function orderChats(chats) {
  return (chats || []).map((c, i) => ({ c, i })).sort(byRecentActivity);
}

// The chat-number rule: next ordinal = one past the highest in use, floored
// Both terms matter. Highest-in-use means a new chat can never collide with a
// number a peer still answers to, so unlinking chat 2 of 3 renames nobody and
// the next chat is 4. (A number whose chat is GONE can come back — nothing
// visible changes when it does, and gap-free numbering is not a promise a name
// has to keep.) The peer count covers an environment whose chats predate stored
// numbers: they read theirs off the backfill (board.mjs chat-ordinals), and a
// new chat must not land on one of theirs even where that hasn't run yet.
export function nextChatOrdinal(meta, peers) {
  const used = Object.values(meta || {}).map((m) => m && m.ordinal).filter((n) => Number.isInteger(n) && n > 0);
  return Math.max(peers || 0, ...used, 0) + 1;
}
