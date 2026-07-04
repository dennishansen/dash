import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useFetch, fmtDate, normalizeStatus } from '../api.js';
import { Markdown } from './Markdown.jsx';

export function HypothesisDetail() {
  const { id } = useParams();
  const { data, err, loading } = useFetch(`/api/dash/hypotheses/${encodeURIComponent(id)}`);

  if (loading && !data) return <div className="spin">loading…</div>;
  if (err) return <div className="error">{err}</div>;
  if (!data) return <div className="empty">not found</div>;

  const st = normalizeStatus(data.status);

  return (
    <div>
      <div className="detail-head">
        <div className="title-block">
          <h2>{data.id} — {data.title}</h2>
          <div className="title-meta">
            <span className={'pill pill-lg ' + st}>{data.status}</span>
            {data.class ? <span className="classpill">{data.class}</span> : null}
            {data.parent ? <>
              <span style={{ color: 'var(--text-faint)' }}>·</span>
              <span>child of <Link to={`/hypotheses/${encodeURIComponent(data.parent)}`} className="hlink">{data.parent}</Link></span>
            </> : null}
            {data.created ? <>
              <span style={{ color: 'var(--text-faint)' }}>·</span>
              <span>opened {fmtDate(data.created)}</span>
            </> : null}
            {data.closed ? <>
              <span style={{ color: 'var(--text-faint)' }}>·</span>
              <span>closed {fmtDate(data.closed)}</span>
            </> : null}
          </div>
        </div>
      </div>

      {data.result_summary ? (
        <div className={'result-callout ' + resultTone(st)}>
          <div className="tag">result summary</div>
          {data.result_summary}
        </div>
      ) : null}

      <div className="detail-grid">
        <div>
          {data.hypothesis ? (
            <div className="section">
              <h3>hypothesis</h3>
              <div style={{ whiteSpace: 'pre-wrap', color: 'var(--text-soft)', fontSize: 15, lineHeight: 1.65 }}>{data.hypothesis}</div>
            </div>
          ) : null}

          {data.notes?.length ? (
            <div className="section">
              <h3>research notes ({data.notes.length})</h3>
              {data.notes.map(n => (
                <details key={n.file} className="note-collapse">
                  <summary>{n.file}</summary>
                  <div style={{ marginTop: 10 }}>
                    <NoteFull file={n.file} />
                  </div>
                </details>
              ))}
            </div>
          ) : null}
        </div>

        <div className="detail-side">
          <div className="meta-card">
            {data.parent ? <>
              <div className="label">parent</div>
              <div><Link to={`/hypotheses/${encodeURIComponent(data.parent)}`} className="hlink">{data.parent}</Link></div>
            </> : null}

            {data.children?.length ? <>
              <div className="label">children ({data.children.length})</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {data.children.map(c => (
                  <Link key={c} to={`/hypotheses/${encodeURIComponent(c)}`} className="hlink">{c}</Link>
                ))}
              </div>
            </> : null}

            {data.commit ? <>
              <div className="label">commit</div>
              <div><code>{data.commit}</code></div>
            </> : null}

            <div className="label">created / closed</div>
            <div>{fmtDate(data.created)} {data.closed ? <> → {fmtDate(data.closed)}</> : <span style={{ color: 'var(--text-mute)' }}> (open)</span>}</div>
          </div>

          {data.linked_experiments?.length ? (
            <div className="meta-card">
              <div className="label">experiments testing this ({data.linked_experiments.length})</div>
              <ul>
                {data.linked_experiments.map(e => (
                  <li key={e.id}>
                    <Link to={`/changes/${encodeURIComponent(e.id)}`}>{e.id}</Link>
                    <span className={'pill ' + normalizeStatus(e.status)} style={{ marginLeft: 6, fontSize: 10 }}>{e.status}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {data.problem_refs?.length ? (
            <div className="meta-card">
              <div className="label">problem refs</div>
              <ul style={{ fontSize: 13 }}>
                {data.problem_refs.map((p, i) => <li key={i} className="inline-code">{p}</li>)}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function resultTone(status) {
  if (status === 'merged' || status === 'active') return 'ok';
  if (status === 'merged-partial') return 'ok';
  if (status === 'parked') return 'warn';
  if (status === 'falsified') return 'bad';
  return '';
}

function NoteFull({ file }) {
  const { data, err, loading } = useFetch(`/api/dash/note/${encodeURIComponent(file)}`);
  if (loading) return <div className="spin">loading…</div>;
  if (err) return <div className="error">{err}</div>;
  if (!data?.text) return null;
  return <Markdown text={data.text} />;
}
