import React, { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useFetch, normalizeStatus } from '../api.js';

const STATUSES = ['all', 'open', 'active', 'merged', 'merged-partial', 'parked', 'falsified'];

export function HypothesesList() {
  const { data, err, loading, refresh } = useFetch('/api/dash/hypotheses');
  const [statusFilter, setStatusFilter] = useState('all');
  const [classFilter, setClassFilter] = useState('all');
  const [search, setSearch] = useState('');

  const items = useMemo(() => {
    if (!data) return [];
    return data.filter(h => {
      if (statusFilter !== 'all' && normalizeStatus(h.status) !== statusFilter) return false;
      if (classFilter !== 'all' && h.class !== classFilter) return false;
      if (search && !((h.id + ' ' + (h.title || '') + ' ' + (h.hypothesis || '')).toLowerCase().includes(search.toLowerCase()))) return false;
      return true;
    });
  }, [data, statusFilter, classFilter, search]);

  const classes = useMemo(() => {
    if (!data) return [];
    const set = new Set();
    for (const h of data) if (h.class) set.add(h.class);
    return [...set].sort();
  }, [data]);

  // Group by class for visual grouping
  const grouped = useMemo(() => {
    if (!items) return [];
    const groups = new Map();
    for (const h of items) {
      const key = h.class || 'uncategorised';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(h);
    }
    return [...groups.entries()];
  }, [items]);

  const statusCounts = useMemo(() => {
    const c = {};
    for (const h of data || []) {
      const s = normalizeStatus(h.status);
      c[s] = (c[s] || 0) + 1;
    }
    return c;
  }, [data]);

  return (
    <div>
      <div className="page-header">
        <h2>Hypotheses</h2>
        <p className="sub">The research graph from <code>docs/solver-lab/hypothesis-graph.yaml</code>. Each H-node is a line of inquiry; experiments test one and its <em>result_summary</em> records what we learned.</p>
      </div>

      <div className="toolbar">
        <span className="label">status</span>
        {STATUSES.map(s => (
          <button key={s} className={statusFilter === s ? 'active' : ''} onClick={() => setStatusFilter(s)}>
            {s}{s !== 'all' && statusCounts[s] ? <span style={{ marginLeft: 6, color: 'var(--text-mute)' }}>{statusCounts[s]}</span> : null}
          </button>
        ))}
      </div>
      <div className="toolbar">
        <span className="label">class</span>
        <button className={classFilter === 'all' ? 'active' : ''} onClick={() => setClassFilter('all')}>all</button>
        {classes.map(c => (
          <button key={c} className={classFilter === c ? 'active' : ''} onClick={() => setClassFilter(c)}>{c}</button>
        ))}
        <span className="label" style={{ marginLeft: 12 }}>search</span>
        <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="H011, rail, projection…" style={{ width: 220 }} />
        <button onClick={refresh} style={{ marginLeft: 12 }}>↻ refresh</button>
      </div>

      {err ? <div className="error">{err}</div> : null}
      {loading && !data ? <div className="spin">loading…</div> : null}

      {data && items.length === 0 ? <div className="empty">no hypotheses match</div> : null}

      {classFilter === 'all' && statusFilter === 'all' && !search ? (
        grouped.map(([cls, list]) => (
          <div key={cls} className="dash-section">
            <div className="section-head">
              <h3>{cls}</h3>
              <span className="ct">{list.length}</span>
            </div>
            {list.map(h => <HypoCard key={h.id} h={h} />)}
          </div>
        ))
      ) : (
        <div>
          {items.map(h => <HypoCard key={h.id} h={h} />)}
        </div>
      )}

      {data ? <p className="lede" style={{ marginTop: 16 }}>{items.length} of {data.length} hypotheses</p> : null}
    </div>
  );
}

function HypoCard({ h }) {
  const st = normalizeStatus(h.status);
  const summary = firstLine(h.result_summary) || firstLine(h.hypothesis);
  return (
    <Link to={`/hypotheses/${encodeURIComponent(h.id)}`} className={`hypo-card status-${st}`}>
      <div className="hypo-card-head">
        <span className="hid">{h.id}</span>
        <span className="htitle">{h.title || '—'}</span>
        <span className={'pill ' + st}>{h.status}</span>
        {h.class ? <span className="classpill">{h.class}</span> : null}
        {h.linked_notes_count ? <span style={{ fontSize: 13, color: 'var(--text-mute)' }}>{h.linked_notes_count} notes</span> : null}
      </div>
      {summary ? <p className="hypo-card-summary">{summary}</p> : null}
    </Link>
  );
}

function firstLine(s) {
  if (!s) return null;
  const lines = String(s).split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const first = lines[0];
  return first.length > 240 ? first.slice(0, 237) + '…' : first;
}
