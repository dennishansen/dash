import { useEffect, useRef, useState } from 'react';
import { mirroredChat, mirroredTurns } from '../../server/chat-mirror.mjs';
import { Markdown } from './Markdown.jsx';
import { PaneEmpty } from '../PaneEmpty.jsx';
import { useProfiles, displayName, normalizeEmail } from '../profiles.jsx';

// Reading a chat you cannot run.
//
// A chat's agent is pinned to the machine that started it — its folder, its
// branch, its credentials — so the TERMINAL can only ever open where the chat
// lives. What travels is the record of what was said, mirrored into shared
// storage by the owner's own dash (see server/chat-mirror.mjs). This is the
// other end of that: the reader every non-owner gets.
//
// It reads the corpus DIRECTLY, not through the local dash — which is what lets
// it work on a machine with no backend at all (the deployed board), and means
// there is ONE read path rather than a local one and a remote one that drift.
//
// Read-only is not a rule this component follows; it is the only thing it can
// do. There is no write policy on the corpus for a signed-in reader, so the
// absence of an input box here is a description of the system, not a decision
// the UI is enforcing.

const POLL_MS = 4000;

// Poll a mirrored chat, appending only what has arrived since the last read.
// The chat may be LIVE on its owner's machine, so a reader watches it grow —
// a few seconds behind, which is the honest cost of not connecting to anybody's
// computer. Fetching incrementally (by last idx) rather than refetching whole
// is what keeps a long transcript cheap to watch.
function useMirroredChat(sessionId) {
  const [state, setState] = useState({ loading: true, chat: null, turns: [] });
  const lastIdx = useRef(-1);
  const haveChat = useRef(false);

  useEffect(() => {
    let cancelled = false;
    lastIdx.current = -1;
    haveChat.current = false;
    setState({ loading: true, chat: null, turns: [] });
    if (!sessionId) return undefined;

    const tick = async () => {
      try {
        // The header is fetched until it EXISTS, not just once: a chat opened
        // seconds after it was created has not synced yet, and the reader should
        // fill in when it does rather than sit on "not synced" forever.
        const [chat, fresh] = await Promise.all([
          haveChat.current ? Promise.resolve(undefined) : mirroredChat(sessionId),
          mirroredTurns(sessionId, lastIdx.current),
        ]);
        if (cancelled) return;
        if (chat) haveChat.current = true;
        if (fresh.length) lastIdx.current = fresh[fresh.length - 1].idx;
        setState(s => ({
          loading: false,
          chat: chat === undefined ? s.chat : (chat || s.chat),
          turns: fresh.length ? [...s.turns, ...fresh] : s.turns,
        }));
      } catch (e) {
        if (!cancelled) setState(s => ({ ...s, loading: false, error: String(e) }));
      }
    };
    tick();
    const iv = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(iv); };
  }, [sessionId]);

  return state;
}

// Who said it. Deliberately two words, not an avatar per line: a transcript is
// read as prose, and a column of pictures down the left turns it into a chat
// app. The person's own name appears once, in the header.
function Turn({ turn, who, highlighted, refFn }) {
  return (
    <div ref={refFn} className={`chat-turn chat-turn-${turn.role}${highlighted ? ' is-hit' : ''}`}>
      <div className="chat-turn-who">{turn.role === 'user' ? who : 'agent'}</div>
      <div className="chat-turn-body"><Markdown text={turn.text} /></div>
    </div>
  );
}

// The chat's transcript. No header saying "you are reading, not typing" — the
// pane's own shape carries that: prose turns instead of a terminal grid, with
// whose chat it is already shown by the avatar in the switcher above. A banner
// restating it was noise. `focusIdx` scrolls to and marks one turn, which is how
// a search result opens the chat at the thing you searched for.
export function ChatTranscript({ sessionId, focusIdx = null }) {
  const { loading, chat, turns, error } = useMirroredChat(sessionId);
  const profiles = useProfiles();
  const scrollRef = useRef(null);
  const hitRef = useRef(null);
  const stuck = useRef(true); // was the reader at the bottom before this update?

  const owner = chat?.owner || null;
  const who = owner ? displayName(profiles[normalizeEmail(owner)] || null, owner) : 'human';

  // Follow a live chat only while the reader is already at the bottom — the
  // usual terminal rule. Scrolling up to read something is a deliberate act and
  // an arriving turn must not yank you away from it.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (focusIdx != null) { hitRef.current?.scrollIntoView({ block: 'center' }); return; }
    if (stuck.current) el.scrollTop = el.scrollHeight;
  }, [turns.length, focusIdx]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  if (loading) {
    return <div className="issue-terminal issue-terminal-msg"><p className="dim">loading…</p></div>;
  }
  if (error) {
    return (
      <div className="issue-terminal">
        <PaneEmpty title="The shared copy is unavailable"><p>{error}</p></PaneEmpty>
      </div>
    );
  }
  // A chat with no mirrored copy at all — brand new, or its owner's dash has not
  // run since it was created. Say which, rather than showing a blank pane.
  if (!chat) {
    return (
      <div className="issue-terminal">
        <PaneEmpty title="Not synced yet">
          <p>
            Nothing of this chat has reached the shared copy. It syncs from the
            computer it runs on, so it appears here once that dash is running.
          </p>
        </PaneEmpty>
      </div>
    );
  }

  return (
    <div className="chat-transcript">
      <div className="chat-transcript-scroll" ref={scrollRef} onScroll={onScroll}>
        {turns.length === 0 ? (
          <p className="dim chat-transcript-quiet">Nothing said yet.</p>
        ) : turns.map(t => (
          <Turn key={t.idx} turn={t} who={who}
            highlighted={focusIdx === t.idx}
            refFn={focusIdx === t.idx ? hitRef : undefined} />
        ))}
      </div>
    </div>
  );
}
