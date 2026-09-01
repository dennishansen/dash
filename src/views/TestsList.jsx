import React, { useState, useMemo, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useFetch } from '../api.js';

// Tests are the corpus — recorded benchmarks the solver gates against.
// This page is a pure gallery: each card is the test name + the full
// gif of what the current solver does on that benchmark.
//
// Proposed (inactive) tests live below the active set. They're not
// gated by the harness; Dennis promotes them to active by flipping
// `"active": true` in the manifest.

export function TestsList() {
  const { data, err, loading, refresh } = useFetch('/api/dash/tests');
  const [search, setSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [testName, setTestName] = useState('');
  const [addErr, setAddErr] = useState(null);
  const [adding, setAdding] = useState(false);

  async function submitAdd() {
    setAdding(true);
    setAddErr(null);
    try {
      const r = await fetch('/api/dash/tests/create-from-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId.trim(), testName: testName.trim() || undefined }),
      });
      const j = await r.json();
      if (!r.ok || j.error) {
        setAddErr(j.error || `HTTP ${r.status}`);
      } else {
        setAddOpen(false);
        setSessionId('');
        setTestName('');
        refresh();
      }
    } catch (e) {
      setAddErr(e.message);
    } finally {
      setAdding(false);
    }
  }

  // Poll the tests list while any card is still rendering. 2s matches
  // the server-side tests memo TTL so we always get fresh data.
  const anyRendering = useMemo(() => (data || []).some(t => {
    const s = t.render_status;
    return s && (s.phase === 'rendering' || s.phase === 'uploading');
  }), [data]);
  useEffect(() => {
    if (!anyRendering) return;
    const id = setInterval(() => refresh(), 2000);
    return () => clearInterval(id);
  }, [anyRendering, refresh]);

  const { active, proposed } = useMemo(() => {
    if (!data) return { active: [], proposed: [] };
    const matchSearch = t => !search || (t.name).toLowerCase().includes(search.toLowerCase());
    const active = data.filter(t => t.active !== false && matchSearch(t));
    const proposed = data.filter(t => t.active === false && matchSearch(t));
    return { active, proposed };
  }, [data, search]);

  const totalActive = data ? data.filter(t => t.active !== false).length : 0;
  const totalProposed = data ? data.filter(t => t.active === false).length : 0;

  return (
    <div>
      <div className="page-header">
        <h2>Tests</h2>
        <p className="sub">
          {totalActive} active · {totalProposed} proposed. Each card is what the current default solver does on that benchmark.
        </p>
      </div>

      <div className="toolbar">
        <span className="label">search</span>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="bench-23, rail, drag…"
          style={{ width: 240 }}
        />
        <span className="dim" style={{ marginLeft: 'auto' }}>{active.length + proposed.length} of {totalActive + totalProposed} tests</span>
        <button onClick={() => setAddOpen(v => !v)} style={{ marginLeft: 12 }}>+ add test from session</button>
        <button onClick={refresh} style={{ marginLeft: 12 }}>↻ refresh</button>
      </div>

      {addOpen && (
        <div className="toolbar" style={{ marginTop: 8, padding: '8px 12px', background: 'var(--bg-1)', borderRadius: 4, flexWrap: 'wrap', gap: 8 }}>
          <span className="label">session id</span>
          <input
            type="text"
            value={sessionId}
            onChange={e => setSessionId(e.target.value)}
            placeholder="e.g. 1b2c (recorded session id)"
            style={{ width: 280 }}
            autoFocus
          />
          <span className="label">name (optional)</span>
          <input
            type="text"
            value={testName}
            onChange={e => setTestName(e.target.value)}
            placeholder="proposed-session-<id>"
            style={{ width: 240 }}
          />
          <button onClick={submitAdd} disabled={adding || !sessionId.trim()}>
            {adding ? 'creating…' : 'create'}
          </button>
          <button onClick={() => { setAddOpen(false); setAddErr(null); }}>cancel</button>
          {addErr ? <span className="error" style={{ marginLeft: 8 }}>{addErr}</span> : null}
          <span className="dim" style={{ flexBasis: '100%', marginTop: 4 }}>
            Fetches the recording by id from the Supabase corpus and writes it into the corpus as a proposed (inactive) test.
          </span>
        </div>
      )}

      {err ? <div className="error">{err}</div> : null}
      {loading && !data ? <div className="spin">loading…</div> : null}

      {data && active.length === 0 && proposed.length === 0 ? (
        <div className="dim" style={{ padding: 32, textAlign: 'center' }}>no tests match "{search}"</div>
      ) : null}

      {active.length > 0 && (
        <>
          <h3 style={{ marginTop: 24, marginBottom: 8 }}>
            Active <span className="dim" style={{ fontWeight: 'normal' }}>({active.length}) — gated by harness</span>
          </h3>
          <div className="tests-grid">
            {active.map(t => <TestCard key={t.name} t={t} />)}
          </div>
        </>
      )}

      {proposed.length > 0 && (
        <>
          <h3 style={{ marginTop: 32, marginBottom: 8 }}>
            Proposed <span className="dim" style={{ fontWeight: 'normal' }}>({proposed.length}) — inactive, not gated. Promote by setting <code>"active": true</code> in the manifest.</span>
          </h3>
          <div className="tests-grid">
            {proposed.map(t => <TestCard key={t.name} t={t} proposed />)}
          </div>
        </>
      )}
    </div>
  );
}

function TestCard({ t, proposed }) {
  // Current-state gif is the snap-off render through the current solver.
  const primary = t.has_gif
    ? `/dash/gifs/2026-04-20-current-state/${t.name}.gif`
    : null;

  return (
    <Link to={`/tests/${encodeURIComponent(t.name)}`} className={`test-card${proposed ? ' test-card-proposed' : ''}`}>
      <div className="test-card-media">
        {primary ? (
          <img
            src={primary}
            alt={t.name}
            loading="lazy"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
              const sib = e.currentTarget.nextElementSibling;
              if (sib) sib.style.display = 'flex';
            }}
          />
        ) : null}
        <div className="no-gif" style={{ display: primary ? 'none' : 'flex' }}>
          <span className="dim">{renderStatusLabel(t) || (proposed ? 'gif pending regen' : 'no capture')}</span>
        </div>
      </div>
      <div className="test-card-name">
        {t.name}
        {t.render_status && t.render_status.phase !== 'done' ? (
          <span className="dim" style={{ marginLeft: 8, fontWeight: 'normal' }}>· {renderStatusLabel(t)}</span>
        ) : null}
      </div>
    </Link>
  );
}

function renderStatusLabel(t) {
  const s = t.render_status;
  if (!s) return null;
  const secs = Math.round((s.elapsedMs || 0) / 1000);
  if (s.phase === 'rendering') return `rendering gif… ${secs}s`;
  if (s.phase === 'uploading') return `uploading… ${secs}s`;
  if (s.phase === 'error') return `error: ${s.error || 'unknown'}`;
  return null;
}
