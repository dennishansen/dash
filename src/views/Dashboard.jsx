import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useFetch } from '../api.js';

// Dashboard — solver-health graphs over time. Orthogonal to the Changes
// board; lives at /#/ . (Extracted from the old ExperimentsList dashboard
// variant when the branch kanban was replaced by the unified Changes board.)

export function Dashboard() {
  // The dashboard is the graphs (Dennis 2026-04-22). Everything else
  // (live workers, pending triage, recent decisions, baseline/head state)
  // lives on /changes or in the sidebar state-block.
  return <SolverHealth />;
}

// Dashboard's lead panel: aggregated solver health over time. One snapshot
// per accepted experiment (commit to main), written by
// scripts/snapshot-metrics.mjs and exposed at /api/dash/stats-history.
// Each card is clickable — expands to list the benches contributing to
// that score so you can drill into the "why" behind a number.
function SolverHealth() {
  const { data } = useFetch('/api/dash/stats-history');
  const [expandedKey, setExpandedKey] = useState(null);
  const entries = data?.entries ?? [];
  if (entries.length === 0) {
    return (
      <div className="dash-section">
        <div className="section-head"><h3>Solver health</h3></div>
        <div className="empty">
          no snapshots yet. On the next merge to main, CI recalcs metrics and
          records a per-commit snapshot to the <code>metric_runs</code> table
          (<code>scripts/snapshot-metrics.mjs --remote</code>).
        </div>
      </div>
    );
  }
  const latest = entries[entries.length - 1];
  // Normalize counts to PERCENTAGE of total_benches so the corpus growing
  // (6→37 over time) doesn't distort the y-axis. Report as "% passing"
  // — higher is better for every axis so direction is consistent; the
  // sub-line shows the raw count of failures in the current-latest.
  const pct = (num, den) => (den > 0 ? (num / den) * 100 : 0);
  const seriesOf = (fn) => entries.map(fn);
  const healthySeries = seriesOf(e => pct(e.scores.total_healthy, e.scores.total_benches));
  const correctnessSeries = seriesOf(e => pct(e.scores.total_benches - e.scores.correctness_broken, e.scores.total_benches));
  const smoothnessSeries = seriesOf(e => pct(e.scores.total_benches - e.scores.smoothness_broken, e.scores.total_benches));
  const perfSeries = seriesOf(e => e.scores.perf_mean_p99_ms ?? 0);

  const totalB = latest.scores.total_benches;
  const correctnessPassing = totalB - latest.scores.correctness_broken;
  const smoothnessPassing = totalB - latest.scores.smoothness_broken;
  const latestPct = {
    healthy: pct(latest.scores.total_healthy, totalB),
    correctness: pct(correctnessPassing, totalB),
    smoothness: pct(smoothnessPassing, totalB),
  };
  const fmtPct = (v) => v.toFixed(0) + '%';
  const issuesSub = (brokenCount) => brokenCount === 0
    ? 'no issues' : `${brokenCount} bench${brokenCount === 1 ? '' : 'es'} with issues`;

  const cards = [
    { key: 'healthy', label: 'Healthy', value: fmtPct(latestPct.healthy), sub: `${latest.scores.total_healthy} of ${totalB} benches pass both`, series: healthySeries, unit: '%', higherBetter: true },
    { key: 'correctness', label: 'Correctness passing', value: fmtPct(latestPct.correctness), sub: issuesSub(latest.scores.correctness_broken), series: correctnessSeries, unit: '%', higherBetter: true },
    { key: 'smoothness', label: 'Smoothness passing', value: fmtPct(latestPct.smoothness), sub: issuesSub(latest.scores.smoothness_broken), series: smoothnessSeries, unit: '%', higherBetter: true },
    { key: 'perf', label: 'p99 solve (mean)', value: `${(latest.scores.perf_mean_p99_ms ?? 0).toFixed(2)} ms`, sub: 'mean across all benches', series: perfSeries, unit: 'ms', higherBetter: false },
  ];

  return (
    <div className="dash-section">
      <div className="section-head">
        <h3>Solver health</h3>
        <span className="ct">{entries.length} snapshot{entries.length === 1 ? '' : 's'} · latest {latest.sha_short}{latest.dirty ? '*' : ''}</span>
      </div>
      <div className="health-grid">
        {cards.map(c => (
          <HealthCard key={c.key} {...c}
            expanded={expandedKey === c.key}
            onClick={() => setExpandedKey(expandedKey === c.key ? null : c.key)}
          />
        ))}
      </div>
      {expandedKey ? (
        <HealthDrilldown
          key={expandedKey}
          category={expandedKey}
          entries={entries}
          card={cards.find(c => c.key === expandedKey)}
        />
      ) : null}
    </div>
  );
}

function HealthCard({ label, value, sub, series, unit, higherBetter, expanded, onClick }) {
  const last = series[series.length - 1];
  const prev = series.length > 1 ? series[series.length - 2] : last;
  const delta = last - prev;
  const improved = higherBetter ? delta > 0 : delta < 0;
  const worsened = higherBetter ? delta < 0 : delta > 0;
  const deltaClass = improved ? 'delta-good' : worsened ? 'delta-bad' : 'delta-flat';
  const deltaSign = delta > 0 ? '+' : '';
  const deltaFmt = Math.abs(delta) < 0.01 ? '—' : `${deltaSign}${delta.toFixed(Math.abs(delta) < 1 ? 2 : 0)}${unit ?? ''}`;

  // Chart viewBox is 600×140 so `preserveAspectRatio="none"` stretching
  // to most card widths shrinks (not enlarges) the x-axis — avoids the
  // visually-stretched look at any card width up to ~600px. Height
  // stays fixed in CSS; width flexes to container.
  const w = 600, h = 140, padX = 4, padY = 8;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const pad = (max - min) * 0.08 || (max === 0 ? 1 : max * 0.1);
  const yMin = min - pad, yMax = max + pad;
  const range = yMax - yMin || 1;
  const plotW = w - 2 * padX;
  const plotH = h - 2 * padY;
  const step = series.length > 1 ? plotW / (series.length - 1) : 0;
  const pts = series.map((v, i) => {
    const x = padX + i * step;
    const y = padY + plotH - ((v - yMin) / range) * plotH;
    return [x, y];
  });
  const pathD = pts.map(([x, y], i) => (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1)).join(' ');
  const areaD = pathD + ` L${pts[pts.length - 1][0].toFixed(1)},${(h - padY).toFixed(1)} L${pts[0][0].toFixed(1)},${(h - padY).toFixed(1)} Z`;
  const lastPt = pts[pts.length - 1];

  // Gradient ids must be CSS-ident safe — raw labels ("P99 SOLVE (MEAN)")
  // contain spaces/parens, which silently break url(#...) and render the
  // area fill black.
  const gradId = 'grad-' + label.replace(/[^A-Za-z0-9_-]+/g, '-');

  const fmtAxis = (v) => {
    if (unit === '%') return v.toFixed(0) + '%';
    if (unit === 'ms') return v.toFixed(1) + 'ms';
    return v.toFixed(0);
  };

  return (
    <div className={`health-card${expanded ? ' expanded' : ''}`} role="link" tabIndex={0}
         onClick={onClick} onKeyDown={(ev) => { if (ev.key === 'Enter') onClick(); }}>
      <div className="health-card-head">
        <div>
          <div className="health-label">{label}</div>
          <div className="health-sub">{sub}</div>
        </div>
        <div className="health-value-col">
          <span className="health-value">{value}</span>
          <span className={`health-delta ${deltaClass}`}>{deltaFmt}</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="health-spark">
        <defs>
          <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.25" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={areaD} fill={`url(#${gradId})`} stroke="none" />
        <path d={pathD} fill="none" stroke="currentColor" strokeWidth="1.5" />
        {pts.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={i === pts.length - 1 ? 3 : 1.5} fill="currentColor" />
        ))}
        {/* y-axis min/max labels */}
        <text x={w - 2} y={padY + 8} fontSize="9" textAnchor="end" fill="var(--text-mute)">{fmtAxis(yMax)}</text>
        <text x={w - 2} y={h - 2} fontSize="9" textAnchor="end" fill="var(--text-mute)">{fmtAxis(yMin)}</text>
      </svg>
    </div>
  );
}

// Drilldown shows this metric's value for EVERY snapshot (≈ every
// accepted experiment), most recent first, so Dennis can see how the
// score has changed across the history. The last row also shows the
// contributing benches for the LATEST snapshot so the "why" of the
// current value is visible without a second click.
function HealthDrilldown({ category, entries, card }) {
  const headings = {
    healthy: 'Healthy % by experiment',
    correctness: 'Correctness-passing % by experiment',
    smoothness: 'Smoothness-passing % by experiment',
    perf: 'p99 solve (mean) by experiment',
  };
  const pct = (num, den) => (den > 0 ? (num / den) * 100 : 0);
  const fmtPct = (v) => v.toFixed(0) + '%';

  // Compute this metric's value at each snapshot.
  function metricAt(e) {
    const s = e.scores;
    if (category === 'healthy') return pct(s.total_healthy, s.total_benches);
    if (category === 'correctness') return pct(s.total_benches - s.correctness_broken, s.total_benches);
    if (category === 'smoothness') return pct(s.total_benches - s.smoothness_broken, s.total_benches);
    if (category === 'perf') return s.perf_mean_p99_ms ?? 0;
    return 0;
  }
  const fmtVal = (v) => category === 'perf' ? `${v.toFixed(2)} ms` : fmtPct(v);
  const higherBetter = category !== 'perf';

  const reversed = [...entries].reverse(); // newest first
  const latest = entries[entries.length - 1];

  // Per-bench contributors for the latest snapshot — surfaced at the top
  // as "what's broken right now" context for the current value.
  function contributingBenches() {
    if (category === 'healthy') return Object.entries(latest.benches).filter(([, b]) => b.correctness_broken || b.smoothness_broken);
    if (category === 'correctness') return Object.entries(latest.benches).filter(([, b]) => b.correctness_broken);
    if (category === 'smoothness') return Object.entries(latest.benches).filter(([, b]) => b.smoothness_broken);
    if (category === 'perf') return Object.entries(latest.benches)
      .filter(([, b]) => typeof b.p99_solve_ms === 'number')
      .sort((a, z) => z[1].p99_solve_ms - a[1].p99_solve_ms).slice(0, 5);
    return [];
  }
  const contributors = contributingBenches();
  const contribLabel = category === 'perf'
    ? `Slowest ${contributors.length} benches in latest snapshot`
    : category === 'healthy'
      ? `Benches currently breaking in latest snapshot (${contributors.length})`
      : `Benches currently failing ${category} in latest snapshot (${contributors.length})`;

  return (
    <div className="health-drill">
      <div className="health-drill-head">{headings[category] ?? category}</div>

      <div className="drill-timeline">
        {reversed.map((e, i) => {
          const v = metricAt(e);
          const prev = i + 1 < reversed.length ? metricAt(reversed[i + 1]) : v;
          const delta = v - prev;
          const improved = higherBetter ? delta > 0 : delta < 0;
          const worsened = higherBetter ? delta < 0 : delta > 0;
          const deltaClass = improved ? 'delta-good' : worsened ? 'delta-bad' : 'delta-flat';
          const deltaStr = Math.abs(delta) < 0.01 ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(category === 'perf' ? 2 : 0)}${category === 'perf' ? '' : '%'}`;
          return (
            <div key={e.sha} className={`timeline-row${i === 0 ? ' is-current' : ''}`}>
              <span className="timeline-date">{e.date.slice(0, 10)}</span>
              <span className="timeline-sha"><code>{e.sha_short}</code></span>
              <span className="timeline-subject" title={e.subject}>{e.subject}</span>
              <span className="timeline-value">{fmtVal(v)}</span>
              <span className={`timeline-delta ${deltaClass}`}>{deltaStr}</span>
            </div>
          );
        })}
      </div>

      {contributors.length > 0 ? (
        <>
          <div className="health-drill-head" style={{ marginTop: 16 }}>{contribLabel}</div>
          <div className="health-drill-list">
            {contributors.map(([name, b]) => {
              const parts = [];
              if (category === 'correctness' || category === 'healthy') {
                for (const c of b.correctness_contributing ?? []) parts.push(<span key={'c-' + c.key} className="drill-reason">{c.key}: <b>{c.value.toFixed(2)}</b> (&gt; {c.limit})</span>);
              }
              if (category === 'smoothness' || category === 'healthy') {
                for (const c of b.smoothness_contributing ?? []) parts.push(<span key={'s-' + c.key} className="drill-reason">{c.key}: <b>{c.value.toFixed(2)}</b> (&gt; {c.limit})</span>);
              }
              if (category === 'perf') parts.push(<span key="p" className="drill-reason">p99: <b>{b.p99_solve_ms?.toFixed(2)} ms</b></span>);
              return (
                <Link key={name} to={`/tests/${encodeURIComponent(name)}`} className="drill-row">
                  <span className="drill-name">{name}</span>
                  <span className="drill-reasons">{parts}</span>
                </Link>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}
