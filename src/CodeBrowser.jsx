import React from 'react';
import { useFetch } from './api.js';
import { loadW } from './dock.jsx';
import { MonacoCodeView } from './MonacoCodeView.jsx';
import { ChevronDown, ChevronRight, File, Folder, Search } from './icons.jsx';

const STATUS = {
  added: { mark: 'A', label: 'Added' },
  modified: { mark: 'M', label: 'Modified' },
  deleted: { mark: 'D', label: 'Deleted' },
  renamed: { mark: 'R', label: 'Renamed' },
};

// The Changes/Files split. Its height (px, of the Changes section) is a persisted,
// drag-controlled value; unset falls back to the CSS default ratio. Each section
// keeps its heading plus a few rows — the drag clamps both ends to this floor.
const CHANGES_KEY = 'dash-code-changes-height';
const NAV_SECTION_MIN = 96;
// The file-browser pane is a fixed, drag-resizable width (persisted px). Unset
// falls back to the CSS default column. Clamps to a readable floor on both ends.
const NAV_WIDTH_KEY = 'dash-code-nav-width';
const NAV_WIDTH_MIN = 170;
const CONTENT_MIN = 280;

function useRepositoryFile(env, file, active, meta) {
  // The tree poll already handed us this file's status + the base sha; pass them
  // so the server reads just this file instead of re-snapshotting the whole repo
  // (the reason opens felt slow). Primitives, not the object, so the effect only
  // re-fires when they actually change.
  const status = meta?.status || '';
  const oldPath = meta?.oldPath || '';
  const baseSha = meta?.baseSha || '';
  const baseLabel = meta?.base || '';
  const [state, setState] = React.useState({ data: null, error: null, loading: false });
  React.useEffect(() => {
    if (!env || !file) {
      setState({ data: null, error: null, loading: false });
      return undefined;
    }
    if (!active) return undefined;
    let mounted = true;
    let timer;
    const load = async () => {
      try {
        const params = new URLSearchParams({ path: file });
        if (baseSha) {
          params.set('baseSha', baseSha);
          if (status) params.set('status', status);
          if (oldPath) params.set('oldPath', oldPath);
          if (baseLabel) params.set('base', baseLabel);
        }
        const response = await fetch(`/api/dash/code/${encodeURIComponent(env)}/file?${params.toString()}`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        if (mounted) {
          setState((previous) => {
            const before = previous.data;
            const unchanged = before
              && before.kind === data.kind
              && before.path === data.path
              && before.status === data.status
              && before.original === data.original
              && before.modified === data.modified
              && before.text === data.text
              && before.reason === data.reason;
            return unchanged ? previous : { data, error: null, loading: false };
          });
        }
      } catch (error) {
        if (mounted) setState({ data: null, error: error.message, loading: false });
      }
    };
    setState((previous) => previous.data ? previous : { data: null, error: null, loading: true });
    load();
    timer = setInterval(load, 3000);
    return () => { mounted = false; clearInterval(timer); };
  }, [env, file, active, status, oldPath, baseSha, baseLabel]);
  return state;
}

function fileName(file) {
  return file.path.split('/').pop();
}

function FileRow({ file, selected, onSelect, compact = false }) {
  const meta = file.status ? STATUS[file.status] : null;
  const title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  return (
    <button
      type="button"
      className={`code-file${selected ? ' is-selected' : ''}${compact ? ' is-compact' : ''}`}
      data-path={file.path}
      data-status={file.status || undefined}
      title={title}
      onClick={() => onSelect(file.path)}
    >
      <File size={13} />
      <span className="code-file-name">{compact ? file.path : fileName(file)}</span>
      {meta ? <span className={`code-status code-status--${file.status}`} title={meta.label}>{meta.mark}</span> : null}
    </button>
  );
}

function treeFrom(files) {
  const root = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { name: part, dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push(file);
  }
  return root;
}

function Directory({ node, depth, selected, onSelect }) {
  const [open, setOpen] = React.useState(depth === 0);
  const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = [...node.files].sort((a, b) => a.path.localeCompare(b.path));
  return (
    <div className="code-directory">
      <button type="button" className="code-folder" style={{ '--tree-depth': depth }} onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Folder size={13} />
        <span>{node.name}</span>
      </button>
      {open ? (
        <div>
          {dirs.map((directory) => (
            <Directory key={directory.name} node={directory} depth={depth + 1} selected={selected} onSelect={onSelect} />
          ))}
          {files.map((file) => (
            <div key={file.path} className="code-tree-file" style={{ '--tree-depth': depth + 1 }}>
              <FileRow file={file} selected={selected === file.path} onSelect={onSelect} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FileTree({ files, selected, onSelect, query }) {
  const normalized = query.trim().toLowerCase();
  if (normalized) {
    const matches = files.filter((file) => file.path.toLowerCase().includes(normalized)).slice(0, 200);
    return matches.length ? matches.map((file) => (
      <FileRow key={file.path} file={file} selected={selected === file.path} onSelect={onSelect} compact />
    )) : <div className="code-nav-empty">No matching files</div>;
  }
  const tree = treeFrom(files);
  const dirs = [...tree.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      {dirs.map((directory) => (
        <Directory key={directory.name} node={directory} depth={0} selected={selected} onSelect={onSelect} />
      ))}
      {tree.files.sort((a, b) => a.path.localeCompare(b.path)).map((file) => (
        <FileRow key={file.path} file={file} selected={selected === file.path} onSelect={onSelect} />
      ))}
    </>
  );
}

export function CodeBrowser({ env, active = true }) {
  const { data: snapshot, err, loading } = useFetch(`/api/dash/code/${encodeURIComponent(env)}`, { pollMs: active ? 3000 : 0 });
  const [selected, setSelected] = React.useState(null);
  const [query, setQuery] = React.useState('');
  const [changesH, setChangesH] = React.useState(() => loadW(CHANGES_KEY, null));
  const [navW, setNavW] = React.useState(() => loadW(NAV_WIDTH_KEY, null));
  const [resizing, setResizing] = React.useState(false);
  const [navResizing, setNavResizing] = React.useState(false);
  const browserRef = React.useRef(null);
  const navRef = React.useRef(null);
  const changesRef = React.useRef(null);
  React.useEffect(() => { setSelected(null); setQuery(''); }, [env]);
  // Horizontal drag on the nav/content divider. Tracks the nav width live and
  // persists on release; clamps so neither the pane nor the editor gets too thin.
  const startWidthResize = (e) => {
    e.preventDefault();
    const browser = browserRef.current;
    if (!browser) return;
    const rect = browser.getBoundingClientRect();
    const max = rect.width - CONTENT_MIN;
    setNavResizing(true);
    let w = navRef.current.getBoundingClientRect().width;
    let moved = false;
    const move = (ev) => {
      moved = true;
      w = Math.min(Math.max(ev.clientX - rect.left, NAV_WIDTH_MIN), Math.max(max, NAV_WIDTH_MIN));
      setNavW(w);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setNavResizing(false);
      if (moved) localStorage.setItem(NAV_WIDTH_KEY, String(Math.round(w)));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  // Vertical drag on the Changes/Files divider. Tracks the Changes height live and
  // persists on release; clamps so neither section drops below its heading + rows.
  const startSplitResize = (e) => {
    e.preventDefault();
    const nav = navRef.current;
    const changes = changesRef.current;
    if (!nav || !changes) return;
    const top = changes.getBoundingClientRect().top;
    const max = nav.getBoundingClientRect().bottom - top - NAV_SECTION_MIN;
    setResizing(true);
    let h = changes.getBoundingClientRect().height;
    let moved = false;
    const move = (ev) => {
      moved = true;
      h = Math.min(Math.max(ev.clientY - top, NAV_SECTION_MIN), max);
      setChangesH(h);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setResizing(false);
      if (moved) localStorage.setItem(CHANGES_KEY, String(Math.round(h)));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  React.useEffect(() => {
    if (!snapshot?.files?.length) return;
    if (selected && snapshot.files.some((file) => file.path === selected)) return;
    setSelected(snapshot.files.find((file) => file.status)?.path || snapshot.files[0].path);
  }, [snapshot, selected]);
  const selMeta = snapshot?.files?.find((item) => item.path === selected) || null;
  const file = useRepositoryFile(env, selected, active,
    selMeta && snapshot ? { status: selMeta.status, oldPath: selMeta.oldPath, baseSha: snapshot.baseSha, base: snapshot.base } : null);

  if (loading && !snapshot) return <div className="code-empty"><p>Loading workspace…</p></div>;
  if (err && !snapshot) {
    return (
      <div className="code-empty">
        <p className="code-empty-title">No workspace</p>
        <p>{err}</p>
      </div>
    );
  }
  const files = snapshot?.files || [];
  const changed = files.filter((item) => item.status);
  const selectedMeta = files.find((item) => item.path === selected);
  return (
    <div
      className={`code-browser${resizing ? ' code-nav-resizing' : ''}${navResizing ? ' code-nav-wresizing' : ''}`}
      ref={browserRef}
      style={navW != null ? { gridTemplateColumns: `${navW}px minmax(0, 1fr)` } : undefined}
    >
      <aside className="code-nav" aria-label="Repository files" ref={navRef}>
        <div className="code-nav-wresize" title="Drag to resize" onPointerDown={startWidthResize} />
        <label className="code-search">
          <Search size={13} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find file" aria-label="Find file" />
        </label>
        {!query ? (
          <section className="code-nav-section" ref={changesRef} style={changesH != null ? { flexBasis: `${changesH}px` } : undefined}>
            <div className="code-nav-heading"><span>Changes</span><span>{changed.length}</span></div>
            <div className="code-nav-list">
              {changed.length ? changed.map((item) => (
                <FileRow key={item.path} file={item} selected={selected === item.path} onSelect={setSelected} compact />
              )) : <div className="code-nav-empty">No changes</div>}
            </div>
          </section>
        ) : null}
        <section className="code-nav-section code-nav-files">
          {!query ? <div className="code-nav-resize" title="Drag to resize" onPointerDown={startSplitResize} /> : null}
          <div className="code-nav-heading"><span>Files</span><span>{files.length}</span></div>
          <div className="code-nav-list"><FileTree files={files} selected={selected} onSelect={setSelected} query={query} /></div>
        </section>
      </aside>
      <main className="code-content">
        <header className="code-file-bar">
          <span className="code-file-path" title={selectedMeta?.oldPath ? `${selectedMeta.oldPath} → ${selected}` : selected || ''}>{selected || 'No file selected'}</span>
          {selectedMeta?.status ? <span className={`code-kind code-kind--${selectedMeta.status}`}>{STATUS[selectedMeta.status].label}</span> : null}
          <span className="code-base">{selectedMeta?.status ? `vs ${snapshot.base}` : 'read only'}</span>
        </header>
        <div className="code-editor-wrap">
          {file.loading ? <div className="code-editor-empty">Loading file…</div>
            : file.error ? <div className="code-editor-empty">{file.error}</div>
              : <MonacoCodeView file={file.data} />}
        </div>
      </main>
    </div>
  );
}
