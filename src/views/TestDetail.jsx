import React, { useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useFetch, fmt, fmtAgo, normalizeStatus } from '../api.js';
import { ZoomImg } from './ZoomImg.jsx';

export function TestDetail() {
  const { name } = useParams();
  const navigate = useNavigate();
  const { data, err, loading } = useFetch(`/api/dash/tests/${encodeURIComponent(name)}`);
  // Fetch the sorted list too, for prev/next navigation. Same server sort
  // as the tests-list page (bench-NN first, then alphabetical).
  const { data: listData } = useFetch('/api/dash/tests');

  if (loading && !data) return <div className="spin">loading…</div>;
  if (err) return <div className="error">{err}</div>;
  if (!data) return <div className="empty">not found</div>;

  const list = Array.isArray(listData) ? listData : [];
  const idx = list.findIndex(t => t.name === data.name);
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;

  return (
    <div>
      <div className="detail-head">
        <div className="title-block">
          <div className="title-row">
            <h2>{data.name}</h2>
            <CopyTitleButton text={data.name} />
            <a
              className="title-copy"
              href={`/api/dash/tests/${encodeURIComponent(data.name)}/svg`}
              download={`${data.name}.svg`}
              title="Download SVG of the initial state (drag into the app to restore the full constraint graph — lossless round-trip via embedded artifact:data)"
            >↓ svg</a>
          </div>
          <div className="title-meta">
            {data.has_gif ? <span className="pill pill-lg merged">has visuals</span> : null}
            {data.has_session ? <span className="pill pill-lg">has session</span> : null}
            {data.has_manifest ? <span className="pill pill-lg">has manifest</span> : null}
            {data.tracked?.scalars ? (
              <span style={{ color: 'var(--text-dim)' }}>tracks <code>{data.tracked.scalars.join(', ')}</code></span>
            ) : null}
          </div>
        </div>
        <div className="detail-pager">
          {prev ? (
            <Link to={`/tests/${encodeURIComponent(prev.name)}`} className="pager-btn" title={prev.name}>&larr; prev</Link>
          ) : <span className="pager-btn disabled">&larr; prev</span>}
          {list.length > 0 && idx >= 0 ? (
            <span className="pager-idx">{idx + 1} / {list.length}</span>
          ) : null}
          {next ? (
            <Link to={`/tests/${encodeURIComponent(next.name)}`} className="pager-btn" title={next.name}>next &rarr;</Link>
          ) : <span className="pager-btn disabled">next &rarr;</span>}
          <DeleteTestButton name={data.name} onDeleted={() => navigate('/tests')} />
        </div>
      </div>

      {/* HERO: current solver behavior (one GIF, large). Substrate A/B
          comparisons live on the experiments page; tests show the
          benchmark itself, not what changed. */}
      {data.gifs?.length ? (
        <div className="gif-hero">
          <CurrentStateGif gifs={data.gifs} name={data.name} />
        </div>
      ) : null}

      <p className="lede" style={{ maxWidth: '72ch' }}>{data.description || <span style={{ color: 'var(--text-mute)' }}>no description on file</span>}</p>

      <div className="detail-grid">
        <div>
          {data.history?.length ? (
            <div className="section">
              <h3>history across experiments</h3>
              <HistoryTable history={data.history} />
            </div>
          ) : (
            <div className="empty">no per-experiment history (only this branch's baseline available)</div>
          )}

          {data.perceptual_note ? (
            <div className="section">
              <h3>perceptual note</h3>
              <div style={{ background: 'var(--bg-1)', padding: 14, borderRadius: 4, fontSize: 14, color: 'var(--text-dim)', whiteSpace: 'pre-wrap', lineHeight: 1.65, borderLeft: '3px solid var(--warn)' }}>{data.perceptual_note}</div>
            </div>
          ) : null}
        </div>

        <div className="detail-side">
          <div className="meta-card">
            <div className="label">tracked scalars</div>
            <div>{data.tracked?.scalars?.join(', ') || <span style={{ color: 'var(--text-mute)' }}>—</span>}</div>
            {data.tracked?.cursorAxis ? <>
              <div className="label">cursor axis</div>
              <div><code>{data.tracked.cursorAxis}</code></div>
            </> : null}
          </div>

          {data.hard_gates ? (
            <div className="meta-card">
              <div className="label">hard gates</div>
              <table className="kv-table">
                <tbody>
                  {Object.entries(data.hard_gates).map(([k, v]) => (
                    <tr key={k}><td>{k}</td><td>{describeGate(v)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {data.advisory_gates ? (
            <div className="meta-card">
              <div className="label">advisory gates</div>
              <table className="kv-table">
                <tbody>
                  {Object.entries(data.advisory_gates).map(([k, v]) => (
                    <tr key={k}><td>{k}</td><td>{describeGate(v)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {data.session_meta ? (
            <div className="meta-card">
              <div className="label">session</div>
              <table className="kv-table">
                <tbody>
                  {data.session_meta.frame_count != null ? <tr><td>frames</td><td>{data.session_meta.frame_count}</td></tr> : null}
                  {data.session_meta.code_version ? <tr><td>code version</td><td>{data.session_meta.code_version}</td></tr> : null}
                  {data.session_meta.grid_mode != null ? <tr><td>grid mode</td><td>{String(data.session_meta.grid_mode)}</td></tr> : null}
                  {data.session_meta.solver_mode ? <tr><td>solver mode</td><td>{data.session_meta.solver_mode}</td></tr> : null}
                </tbody>
              </table>
            </div>
          ) : null}

          {data.metrics ? (
            <div className="meta-card">
              <div className="label">current baseline metrics</div>
              <table className="kv-table">
                <tbody>
                  {Object.entries(data.metrics).map(([k, v]) => (
                    <tr key={k}><td>{k}</td><td>{fmt(v)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function describeGate(g) {
  if (!g || typeof g !== 'object') return String(g ?? '—');
  const parts = [];
  if (g.lte != null) parts.push('≤ ' + g.lte);
  if (g.gte != null) parts.push('≥ ' + g.gte);
  if (g.lt != null) parts.push('< ' + g.lt);
  if (g.gt != null) parts.push('> ' + g.gt);
  if (g.eq != null) parts.push('= ' + g.eq);
  if (g.goal_lte != null) parts.push('goal ≤ ' + g.goal_lte);
  if (g.goal_gte != null) parts.push('goal ≥ ' + g.goal_gte);
  return parts.join(', ') || JSON.stringify(g);
}

function CurrentStateGif({ gifs, name }) {
  // Pick the current-state gif if present (today's solver). Old corpora
  // also have legacy/rewrite-suffixed variants from before Phase 4; those
  // remain readable as fallbacks.
  const current = gifs.find(g => g.experiment === '2026-04-20-current-state' && /\.gif$/.test(g.file) && !/-(legacy|rewrite|before|after)\.gif$/.test(g.file))
              || gifs.find(g => g.experiment === '2026-04-20-current-state' && /-rewrite\.gif$/.test(g.file))
              || gifs.find(g => g.experiment === '2026-04-20-current-state' && /-legacy\.gif$/.test(g.file))
              || gifs[0];
  return (
    <figure className="current-state-gif">
      <ZoomImg src={current.url} alt={name} />
    </figure>
  );
}

function GifGalleryByExperiment({ gifs }) {
  // Each entry { experiment, file, url } — group by experiment, detect
  // before/after pairs within each experiment.
  const byExp = {};
  for (const g of gifs) {
    byExp[g.experiment] = byExp[g.experiment] || [];
    byExp[g.experiment].push(g);
  }
  return (
    <div>
      {Object.entries(byExp).map(([exp, list]) => {
        // try to pair before/after within this experiment
        const before = list.find(g => /-before\.gif$/.test(g.file));
        const after = list.find(g => /-after\.gif$/.test(g.file));
        return (
          <div key={exp} className="ba-group">
            <div className="bench-name">
              from issue <Link to={`/changes/${encodeURIComponent(exp)}`}>{exp}</Link>
            </div>
            {before && after ? (
              <div className="ba-pair">
                <figure className="before">
                  <ZoomImg src={before.url} alt="before" />
                  <figcaption><span className="chip">BEFORE</span><span>main baseline</span></figcaption>
                </figure>
                <figure className="after">
                  <ZoomImg src={after.url} alt="after" />
                  <figcaption><span className="chip">AFTER</span><span>this experiment</span></figcaption>
                </figure>
              </div>
            ) : (
              <div className="gif-thumb-row">
                {list.map(g => (
                  <figure key={g.file} className="gif-thumb">
                    <ZoomImg src={g.url} alt={g.file} />
                    <figcaption>{g.file.replace(/\.gif$/, '')}</figcaption>
                  </figure>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function HistoryTable({ history }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>experiment</th>
          <th>status</th>
          <th className="num">track px</th>
          <th className="num">hard res</th>
          <th className="num">p99 ms</th>
          <th className="num">jump px</th>
          <th>traj hash</th>
        </tr>
      </thead>
      <tbody>
        {history.map(h => {
          const st = normalizeStatus(h.status);
          return (
            <tr key={h.branch} className="row-link" onClick={() => window.location.hash = `/changes/${encodeURIComponent(h.experiment)}`}>
              <td className="id"><Link to={`/changes/${encodeURIComponent(h.experiment)}`}>{h.experiment}</Link></td>
              <td><span className={'pill ' + st}>{st}</span></td>
              <td className="num">{fmt(h.metrics?.tracking_max_err_px)}</td>
              <td className="num">{fmt(h.metrics?.hard_residual_max)}</td>
              <td className="num">{fmt(h.metrics?.p99_solve_ms)}</td>
              <td className="num">{fmt(h.metrics?.max_scalar_jump_px)}</td>
              <td className="dim" style={{ fontSize: 13 }}><code>{h.trajectory_hash?.slice(0, 8) || '—'}</code></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// Small clipboard button that shows a ✓ for 1s after a successful copy.
// Used next to the title so you can grab the test name for paste-into-chat.
function DeleteTestButton({ name, onDeleted }) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState(null);
  async function doDelete() {
    setDeleting(true);
    setErr(null);
    try {
      const r = await fetch(`/api/dash/tests/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!r.ok || j.error) {
        setErr(j.error || `HTTP ${r.status}`);
        setDeleting(false);
      } else {
        onDeleted?.();
      }
    } catch (e) {
      setErr(e.message);
      setDeleting(false);
    }
  }
  if (confirming) {
    return (
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginLeft: 8 }}>
        <button
          onClick={doDelete}
          disabled={deleting}
          style={{ background: '#c33', color: '#fff', border: 'none', padding: '4px 10px', borderRadius: 3 }}
        >{deleting ? 'deleting…' : `confirm delete ${name}`}</button>
        <button onClick={() => { setConfirming(false); setErr(null); }}>cancel</button>
        {err ? <span className="error">{err}</span> : null}
      </span>
    );
  }
  return (
    <button
      onClick={() => setConfirming(true)}
      title="delete this test (manifest, session, gifs, baseline entry)"
      style={{ marginLeft: 8 }}
    >🗑 delete</button>
  );
}

function CopyTitleButton({ text }) {
  const [copied, setCopied] = useState(false);
  async function onClick() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1000);
    } catch {
      // Clipboard API can fail in non-secure contexts; fall back to the
      // legacy selection+execCommand path. Rare in dev; handle it anyway.
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); setCopied(true); setTimeout(() => setCopied(false), 1000); } catch {}
      document.body.removeChild(ta);
    }
  }
  return (
    <button
      className="title-copy"
      onClick={onClick}
      title={copied ? 'copied!' : 'copy title to clipboard'}
      aria-label="copy title"
    >{copied ? '✓' : '⧉'}</button>
  );
}
