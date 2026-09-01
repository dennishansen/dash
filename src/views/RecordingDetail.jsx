import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAsync, fmtAgo, fmtDuration, plural } from '../api.js';
import { loadRecordingSummary, recordingVideo, sessionPublicUrl } from '../../server/corpus-remote.mjs';
import { shortId, transcriptText } from '../../server/recording-summary.mjs';
import { SceneSketch } from './SceneSketch.jsx';
import { CopyButton } from './CopyButton.jsx';

// ONE recording, opened.
//
// "Open it" means WATCH it. A recording is a list of input events, so watching
// one takes a replay through the app and an ffmpeg encode — which no browser and
// no Supabase function can do. The box does it instead, on a sweep, and drops
// the mp4 in the public gif bucket (dash/server/recording-video-sweep.mjs), so
// this page just asks whether the object exists. Render in one place, watch
// anywhere: the deploy plays the same video with no backend of its own.
//
// Beside the video, the things a video cannot give you: the narration, which is
// usually the person saying what they were trying to do; the drawing they left
// behind; and the id every session tool takes, in one click.
export function RecordingDetail() {
  // A recording id may carry a slash (`tests/agent-foo`), so the route is a
  // splat and the id is everything past `/recordings/`.
  const id = useParams()['*'] || '';
  const { data: card, err, loading } = useAsync(
    id ? `recording:${id}` : null,
    () => loadRecordingSummary(id),
  );
  // Polled: a recording opened the moment it was made has no replay yet, and the
  // box will have one within a sweep or two. The page should fill in rather than
  // need a refresh.
  const { data: video, loading: videoLoading } = useAsync(
    id ? `recording-video:${id}` : null,
    () => recordingVideo(id),
    { pollMs: 30000 },
  );

  if (err) return <div className="error">{err}</div>;
  if (loading && !card) return <div className="spin">loading…</div>;
  if (!card) {
    return (
      <div className="empty">
        No recording stored under <code>{id}</code>.
        {' '}<Link to="/recordings">back to recordings</Link>
      </div>
    );
  }

  const said = transcriptText(card.voice);
  return (
    <div>
      <div className="detail-head">
        <div className="title-block">
          <div className="title-row">
            <h2>{shortId(id)}</h2>
            <CopyButton text={id} title="Copy the recording id" />
          </div>
          <div className="title-meta">
            {/* Not what a recording usually is, so said first: still being
                made, or finished by the box for a browser that never stopped
                it (the tab crashed, or was closed). */}
            {card.status === 'recording' ? <span className="pill pill-lg rec-status-live">recording now</span> : null}
            {card.status === 'interrupted' ? <span className="pill pill-lg rec-status-cut">never stopped — finished by the box</span> : null}
            <span className="pill pill-lg">{fmtAgo(card.startTime)}</span>
            <span className="pill pill-lg">{fmtDuration(card.durationMs)}</span>
            <span className="pill pill-lg">{plural(card.frameCount, 'frame')}</span>
            {card.shapes.point || card.shapes.line ? (
              <span className="pill pill-lg">
                {plural(card.shapes.point, 'point')} · {plural(card.shapes.line, 'line')}
                {card.shapes.constraint ? ` · ${plural(card.shapes.constraint, 'constraint')}` : ''}
              </span>
            ) : null}
          </div>
        </div>
        <div className="detail-pager">
          <Link to="/recordings" className="pager-btn">&larr; recordings</Link>
        </div>
      </div>

      <RecordingVideo id={id} card={card} video={video} loading={videoLoading} />

      <div className="rec-detail">
        {/* The sketch is the picture you get when there is no video. Once there
            IS one, it is the same canvas drawn worse — and for a recording made
            before the recorder kept both ends it is the canvas as it was BEFORE
            anything happened, which beside a video of the drawing reads as a
            contradiction. So it steps aside. */}
        {video ? null : (
          <div className="rec-detail-art">
            {card.scene
              ? <SceneSketch scene={card.scene} size={320} title={`drawing in ${shortId(id)}`} />
              : <span className="rec-card-blank">nothing on the canvas</span>}
            <div className="dim rec-detail-cap">the canvas when recording {card.sceneAt}</div>
          </div>
        )}

        <div className="rec-detail-said">
          <h3>Narration</h3>
          {said ? (
            <>
              {/* Said once as a sentence, then again on the clock. Not a
                  repeat: transcription cuts every ~4s, so the segments read
                  chopped and the paragraph is the only place the sentence
                  survives — while the timestamps are the only way to line a
                  complaint up with the frame it was about. */}
              <p className="rec-said-text">{said}</p>
              <div className="dim rec-said-cap">on the recording's clock</div>
              <ol className="rec-said-segments">
                {card.voice.map((seg, i) => (
                  <li key={i}>
                    <span className="rec-said-at">{fmtDuration(seg.t)}</span>
                    <span>{seg.text}</span>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p className="dim">Nothing was said during this recording.</p>
          )}
        </div>
      </div>

      <h3 style={{ marginTop: 28 }}>Take it further</h3>
      <div className="rec-cmds">
        <Cmd label="read it" cmd={`/session-read ${id}`} />
        {/* Only worth offering while there is nothing to watch. Once the sweep
            has rendered this one, telling you to render it yourself is telling
            you to redo work that is already on the page. */}
        {video ? null : (
          <Cmd label="render it now"
            cmd={`node scripts/render-session.mjs ${id} --upload recordings/${shortId(id)}.mp4 --mode full-ui --no-humanize`} />
        )}
      </div>
      <div className="toolbar" style={{ marginTop: 12 }}>
        <a className="ext-link" href={sessionPublicUrl(id)} target="_blank" rel="noreferrer">raw session json</a>
      </div>
    </div>
  );
}

// The replay, when the box has got to it.
//
// Three things this must not imply, because all three are false and a video is
// very good at looking like the truth:
//
//   NOT REAL TIME. Frames are replayed at a constant 20fps, and a recording's
//   frames are unevenly spaced — pointermoves are throttled and deduplicated, so
//   a second and a half of somebody thinking is one twentieth of a second here.
//   That is also why the transcript beside it does not seek the video: the two
//   clocks do not line up, and a scrub that landed in the wrong place would be
//   worse than no scrub at all.
//
//   NOT WHAT THEY SAW. render-session replays through whatever code is checked
//   out now — deliberately, it is what makes solver-lab before/after work — so a
//   session recorded before a fix replays fixed. When the commit it was rendered
//   at differs from the commit it ran on, the page says so rather than leaving
//   you to find out. i-faithful-recordings is the real answer.
//
//   NOT MISSING. No video means the sweep has not reached this one yet, which is
//   a queue position, not a failure.
function RecordingVideo({ card, video, loading }) {
  if (!video) {
    return (
      <div className="rec-video rec-video-pending">
        <span className="dim">{loading ? 'looking for a replay…' : 'no replay yet — the box renders these on a sweep'}</span>
      </div>
    );
  }
  const faithful = card.codeVersion && card.codeVersion === video.renderedAt;
  return (
    <div className="rec-video">
      {/* Plays itself, on a loop. A replay is a few seconds of somebody doing
          one thing, and the way you read it is by watching it several times —
          so the page behaves like the animated thing it is showing rather than
          asking for a click first. `muted` is not about sound (there is no
          audio track) — it is what browsers require before they will start a
          video unasked. Controls stay, for the times you want to stop it. */}
      <video src={video.url} poster={video.url.replace(/\.mp4$/, '.png')}
        controls loop autoPlay muted playsInline preload="auto" />
      <div className="rec-video-note dim">
        A replay at 20fps, not real time — pauses are compressed to a frame each.
        {card.codeVersion ? (
          faithful
            ? <> Rendered on the same commit it was recorded on (<code>{video.renderedAt}</code>).</>
            : <> <strong>Rendered on <code>{video.renderedAt}</code>, recorded on <code>{card.codeVersion}</code></strong> — it replays through today's code, so what you see is what this build does with those inputs, not what was on screen.</>
        ) : (
          <> Rendered on <code>{video.renderedAt}</code>; the recording does not say what it ran on.</>
        )}
      </div>
    </div>
  );
}

// A command with its own copy button — the page's whole answer to "now what",
// since the tools that consume a recording all live in a terminal.
function Cmd({ label, cmd }) {
  return (
    <div className="rec-cmd">
      <span className="label">{label}</span>
      <code>{cmd}</code>
      <CopyButton text={cmd} title={`Copy: ${cmd}`} />
    </div>
  );
}
