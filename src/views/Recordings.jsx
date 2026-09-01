import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAsync, fmtAgo, fmtDuration, plural } from '../api.js';
import { listRecordings, loadRecordingSummary } from '../../server/corpus-remote.mjs';
import { shortId } from '../../server/recording-summary.mjs';
import { SceneSketch } from './SceneSketch.jsx';

// WHAT WAS RECORDED. Debug recordings have always been retrievable by id and
// invisible without one — you either already knew the four characters or the
// recording may as well not have existed. This is the missing half: the corpus
// read back as a list, so a recording can be FOUND rather than remembered.
//
// Supabase-direct and anonymous, like the board — the corpus buckets are
// public-read, so this page works identically on a laptop with a dev server and
// on the deploy, with no /api/dash behind it (dash/src/board-store.js).
//
// Two namespaces, two different things, so they are a choice and not a filter
// over a mixed list (docs/artifact-storage.md):
//   sessions      a person pressed Shift+` and did something worth keeping
//   test fixtures a headless run's replay artifact, named after its test
// Sessions is the default because this page exists for the first kind.

const PAGE = 24;

export function Recordings() {
  const [namespace, setNamespace] = useState('session');
  const [limit, setLimit] = useState(PAGE);
  // The listing is the one cheap read — ids and when, straight off the storage
  // rows, sorted by the server. Everything else on a card lives inside the
  // recording and is fetched by the card itself, as it scrolls into view.
  const { data, err, loading, refresh } = useAsync(
    `recordings:${namespace}:${limit}`,
    () => listRecordings({ namespace, limit }),
    { pollMs: 30000 },
  );
  const rows = data || [];
  // A full page means the bucket probably has more; a short one is the end of it.
  const maybeMore = rows.length === limit;

  const setNs = (ns) => { setNamespace(ns); setLimit(PAGE); };

  return (
    <div>
      <div className="page-header">
        <h2>Recordings</h2>
        <p className="sub">
          What has been captured, newest first. Open one for its transcript and the
          id every session tool takes.
        </p>
      </div>

      <div className="toolbar">
        <span className="label">show</span>
        <span className="seg">
          <button className={namespace === 'session' ? 'is-selected' : ''}
            onClick={() => setNs('session')}>sessions</button>
          <button className={namespace === 'test' ? 'is-selected' : ''}
            onClick={() => setNs('test')}>test fixtures</button>
        </span>
        <span className="dim" style={{ marginLeft: 'auto' }}>
          {rows.length ? plural(rows.length, 'recording') : ''}
        </span>
        <button onClick={refresh} style={{ marginLeft: 12 }}>↻ refresh</button>
      </div>

      {err ? <div className="error">{err}</div> : null}
      {loading && !data ? <div className="spin">loading…</div> : null}
      {data && rows.length === 0 ? (
        <div className="empty">
          {namespace === 'session'
            ? 'Nothing recorded yet. Shift+` in the canvas starts one.'
            : 'No headless runs have stored a fixture yet.'}
        </div>
      ) : null}

      <div className="rec-grid">
        {rows.map(r => <RecordingCard key={r.id} row={r} />)}
      </div>

      {maybeMore ? (
        <div className="rec-more">
          <button onClick={() => setLimit(l => l + PAGE)}>load {PAGE} more</button>
        </div>
      ) : null}
    </div>
  );
}

// One recording, filled in when it reaches the screen.
//
// The card's facts — how long, how many frames, what was said, what was drawn —
// are all INSIDE the recording, so a card costs one object fetch (tens of KB
// typically, occasionally most of a megabyte). Fetching two dozen of those on
// page load would spend megabytes on rows nobody has scrolled to, so a card
// loads itself on arrival and then holds: the payload cache keys the summary by
// id, so scrolling back is free and a recording that has already landed can
// never change under it.
function RecordingCard({ row }) {
  const visible = useOnScreen();
  // Keyed by the WRITE, not by the id. A recording is immutable once stored, so
  // caching it forever is right — but `tests/<name>` is overwritten in place on
  // every run, and a browser recording's voice transcript is amended onto it a
  // few seconds later. Both change what the object says while its id stays put,
  // and a card keyed on the id alone would paint the previous write for as long
  // as it stayed mounted. `writtenAt` moves when the bytes move.
  const { data: card, loading, err } = useAsync(
    visible.seen ? `recording:${row.id}@${row.writtenAt}` : null,
    () => loadRecordingSummary(row.id),
  );
  const label = shortId(row.id);
  // Three states, not two. A card that has not been fetched yet and a card whose
  // recording could not be read look identical if you only ask "did the data
  // arrive" — and a row that sits on "…" forever because the object is gone is
  // the page lying about being busy.
  const pending = !visible.seen || loading;
  const unreadable = !pending && !card;

  return (
    // Encode per SEGMENT: an id in the tests namespace carries a slash, and
    // that slash is a path separator here — `/recordings/tests/agent-foo`
    // matches the splat route and the production rewrite alike.
    <Link ref={visible.ref} className="rec-card"
      to={`/recordings/${row.id.split('/').map(encodeURIComponent).join('/')}`}>
      <div className="rec-card-art">
        {card?.scene
          ? <SceneSketch scene={card.scene} size={104} title={`drawing in ${label}`} />
          : <span className="rec-card-blank">{card ? 'empty canvas' : ''}</span>}
      </div>
      <div className="rec-card-body">
        {/* The best label this recording has. What the person SAID beats the
            key every time — four hex digits are the thing you copy, not the
            thing you recognise. A headless fixture says nothing and is named
            after its test, so there the name is the recognisable thing and it
            takes the headline; the meta line below then doesn't repeat it. */}
        <div className={card?.line ? 'rec-card-said' : 'rec-card-said rec-card-said-id'}>
          {card ? (card.line || label) : <span className="dim">{pending ? '…' : label}</span>}
        </div>
        <div className="rec-card-meta">
          {!card || card.line ? <code>{label}</code> : null}
          {/* The recording's own clock once it lands; until then the storage
              row's write time, which is the same moment plus however long the
              recording ran — below the precision this label prints either way. */}
          <span>{fmtAgo(card?.startTime || row.writtenAt)}</span>
          {card ? <span>{fmtDuration(card.durationMs)}</span> : null}
          {card ? <span>{plural(card.frameCount, 'frame')}</span> : null}
          {card?.status === 'recording' ? <span className="rec-status-live">recording now</span> : null}
          {card?.status === 'interrupted' ? <span className="rec-status-cut">never stopped</span> : null}
          {unreadable ? <span className="rec-card-broken">{err || 'could not be read'}</span> : null}
        </div>
      </div>
    </Link>
  );
}

// True once the element has been on (or near) the screen, and true forever
// after — a card that has loaded stays loaded when it scrolls away.
function useOnScreen({ rootMargin = '300px' } = {}) {
  const [seen, setSeen] = useState(false);
  const node = useRef(null);
  const ref = (el) => { node.current = el; };
  useEffect(() => {
    if (seen || !node.current) return undefined;
    // No IntersectionObserver (jsdom, ancient browsers) means no way to know
    // what is on screen — load rather than show a permanently blank card.
    if (typeof IntersectionObserver === 'undefined') { setSeen(true); return undefined; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) { setSeen(true); io.disconnect(); }
    }, { rootMargin });
    io.observe(node.current);
    return () => io.disconnect();
  }, [seen, rootMargin]);
  return { ref, seen };
}
