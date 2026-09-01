import React from 'react';
import { PaneEmpty } from './PaneEmpty.jsx';
import { useFetch, plural } from './api.js';
import { loadW } from './dock-geometry.js';
import { MonacoCodeView } from './MonacoCodeView.jsx';
import { MAIN_ENV } from './app-env.mjs';
import { ChevronDown, File, Search } from './icons.jsx';

const STATUS = {
  added: { mark: 'A', label: 'Added' },
  modified: { mark: 'M', label: 'Modified' },
  deleted: { mark: 'D', label: 'Deleted' },
  renamed: { mark: 'R', label: 'Renamed' },
};

// The file-browser pane is a fixed, drag-resizable width (persisted px). Unset
// falls back to the CSS default column. Clamps to a readable floor on both ends.
const NAV_WIDTH_KEY = 'dash-code-nav-width';
const NAV_WIDTH_MIN = 170;
const CONTENT_MIN = 280;
// The open file (per env) and the New/Old/Diff view mode persist to the browser,
// so reopening the code pane lands on the same file and viewer instead of
// resetting. File is per-env (each worktree has its own tree); view is a single
// global preference.
const FILE_KEY = 'dash-code-file'; // `${FILE_KEY}:${env}` → path
const VIEW_KEY = 'dash-code-view'; // 'diff' | 'new' | 'old'
// Which folders you left open or closed, per env — same idiom as the board's
// `dash-filters` / `dash-hidden-cols`. Only folders you actually toggled are
// stored; everything else follows the default rule (open iff it holds changes),
// so a tree that grows a new folder still opens on the changes.
const FOLDERS_KEY = 'dash-code-folders'; // `${FOLDERS_KEY}:${env}` → { path: open }
const VIEWS = ['diff', 'new', 'old'];
const loadStr = (key, fallback = null) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const saveStr = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode: skip */ } };
const loadJSON = (key) => { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; } };

// One file's URL. The tree snapshot already told us this file's status and the
// base sha, so they ride along and the server reads just this file instead of
// re-scanning the whole repo to look up one entry. Those params are also what
// make the URL a truthful cache key: a new base or a changed status is a
// different URL, so nothing cached can outlive the tree it came from.
function fileUrl(env, path, tree, entry) {
  if (!env || !path) return null;
  const params = new URLSearchParams({ path });
  if (tree?.baseSha) {
    params.set('baseSha', tree.baseSha);
    if (entry?.status) params.set('status', entry.status);
    if (entry?.oldPath) params.set('oldPath', entry.oldPath);
    if (tree.base) params.set('base', tree.base);
  }
  return `/api/dash/code/${encodeURIComponent(env)}/file?${params.toString()}`;
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

// Roll each directory's state up the tree (post-order): how many changed files
// it holds, and the single letter it wears.
//
// The letter asks what the FOLDER is, not what its children's letters say. The
// obvious rule — "every child is added, so the folder is added" — is not exact,
// because git's rename detection pairs deletions against additions by content
// similarity ACROSS folders: fill a brand-new folder with files whose contents
// match files deleted elsewhere and every child comes back `renamed`, so the
// vote calls a new folder R. Its answer depends on what is INSIDE the files
// rather than on the shape of the change, which makes it a guess.
//
// Two structural facts are enough and cannot be inverted that way:
//   at base   — some descendant was already at this path before (null/modified/deleted)
//   exists now — some descendant is still here (anything but deleted)
// A folder nothing was at before but something is at now was ADDED; one that had
// something and now has nothing was DELETED; anything else with changes under it
// is MODIFIED. It never asks what a child's letter is, so rename detection has
// nothing to invert.
//
// Known gap, snapshot-level rather than ours: a folder emptied entirely by
// renaming its files elsewhere drops out of the tree with its oldPath rows, so
// it has no row on which to show a D.
function annotateChanged(node) {
  let count = 0;
  let atBase = false;
  let existsNow = false;
  for (const file of node.files) {
    if (file.status) count++;
    if (file.status === null || file.status === 'modified' || file.status === 'deleted') atBase = true;
    if (file.status !== 'deleted') existsNow = true;
  }
  for (const dir of node.dirs.values()) {
    count += annotateChanged(dir);
    atBase = atBase || dir.atBase;
    existsNow = existsNow || dir.existsNow;
  }
  node.changedCount = count;
  node.atBase = atBase;
  node.existsNow = existsNow;
  node.mark = !atBase && existsNow ? 'added'
    : atBase && !existsNow ? 'deleted'
      : count ? 'modified' : null;
  return count;
}

function treeFrom(files) {
  const root = { name: '', path: '', dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) {
        node.dirs.set(part, { name: part, path: node.path ? `${node.path}/${part}` : part, dirs: new Map(), files: [] });
      }
      node = node.dirs.get(part);
    }
    node.files.push(file);
  }
  annotateChanged(root);
  return root;
}

// A folder's contents, split into what shows by default (changed files and the
// subfolders that contain changes) and what "Show more" reveals (everything else).
function partition(node) {
  const allDirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const allFiles = [...node.files].sort((a, b) => a.path.localeCompare(b.path));
  const hasHidden = allFiles.some((f) => !f.status) || allDirs.some((d) => d.changedCount === 0);
  return { allDirs, allFiles, hasHidden };
}

// How many rows this pane will paint into one list before it stops and asks.
// Changed-only truncation is about relevance and you drive it; this is about
// volume — a tracked `vendor/` of twenty thousand files must not hang the pane
// because someone opened it. It is a page boundary, never a ceiling: every row
// stays reachable, one click at a time, so nothing in the tree is unreachable
// from the tree.
const ROW_PAGE = 200;

function MoreRows({ total, limit, depth, folder, onMore }) {
  return (
    <button type="button" className="code-row-more" style={{ '--tree-depth': depth }}
      data-folder={folder} onClick={onMore}>
      Show {Math.min(ROW_PAGE, total - limit)} more · {limit} of {total}
    </button>
  );
}

// The open contents of a folder: its truncation control FIRST, then the changed
// children, then everything else once `showAll` is on. The control leads because
// it is the thing you reach for after the list has grown — burying it under the
// listing means scrolling past the very rows you want to hide.
//
// A folder with no changes in it has nothing to truncate TO, so it doesn't
// truncate: it opens on its full contents and carries no toggle. Otherwise
// opening one would show a lone "Show more" over an empty body.
function FolderBody({ node, depth, showAll, setShowAll, folds, setFolderOpen, selected, onSelect }) {
  const [limit, setLimit] = React.useState(ROW_PAGE);
  const { allDirs, allFiles, hasHidden } = partition(node);
  const everything = showAll || node.changedCount === 0;
  const listedDirs = everything ? allDirs : allDirs.filter((d) => d.changedCount > 0);
  const listedFiles = everything ? allFiles : allFiles.filter((f) => f.status);
  const total = listedDirs.length + listedFiles.length;
  const dirs = listedDirs.slice(0, limit);
  const files = listedFiles.slice(0, Math.max(0, limit - dirs.length));
  return (
    <>
      {hasHidden && node.changedCount > 0 ? (
        <button type="button" className="code-show-more" style={{ '--tree-depth': depth }}
          data-folder={node.path} aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show less' : 'Show more'}
        </button>
      ) : null}
      {total > limit ? (
        <MoreRows total={total} limit={limit} depth={depth} folder={node.path}
          onMore={() => setLimit((n) => n + ROW_PAGE)} />
      ) : null}
      {dirs.map((directory) => (
        <Directory key={directory.path} node={directory} depth={depth}
          folds={folds} setFolderOpen={setFolderOpen} selected={selected} onSelect={onSelect} />
      ))}
      {files.map((file) => (
        <div key={file.path} className="code-tree-file" style={{ '--tree-depth': depth }}>
          <FileRow file={file} selected={selected === file.path} onSelect={onSelect} />
        </div>
      ))}
    </>
  );
}

// A folder row folds its subtree away and is the ONLY thing left behind when it
// does — which is why it carries a status letter: after collapsing your way out
// of a big diff, that letter is how you find the way back in. A closed folder
// shows nothing else — no children, no truncation control — so the tree stays as
// small as you made it.
//
// While open it also drops a guide line from the chevron down its contents, so
// how far a folder stretches is readable without counting indents. The line is
// drawn by the wrapper (`[data-open]`), since a fragment of rows has no element
// of its own to hang it on.
function Directory({ node, depth, folds, setFolderOpen, selected, onSelect }) {
  const [showAll, setShowAll] = React.useState(false);
  const open = folds[node.path] ?? node.changedCount > 0;
  const mark = node.mark ? STATUS[node.mark] : null;
  return (
    <div className="code-directory" style={{ '--tree-depth': depth }} data-open={open || undefined}>
      <button
        type="button"
        className="code-folder"
        style={{ '--tree-depth': depth }}
        data-folder={node.path}
        data-status={node.mark || undefined}
        aria-expanded={open}
        title={node.path}
        onClick={() => setFolderOpen(node.path, !open)}
      >
        <ChevronDown size={13} />
        <span className="code-file-name">{node.name}</span>
        {mark ? (
          <span className={`code-status code-status--${node.mark}`}
            title={`${mark.label}${node.changedCount ? ` · ${plural(node.changedCount, 'change')}` : ''}`}>{mark.mark}</span>
        ) : null}
      </button>
      {open ? (
        <FolderBody node={node} depth={depth + 1} showAll={showAll} setShowAll={setShowAll}
          folds={folds} setFolderOpen={setFolderOpen} selected={selected} onSelect={onSelect} />
      ) : null}
    </div>
  );
}

// A search's matches, paged by the same control the tree uses — the heading
// counts every match, so a broad search must not leave a heading of 400 sitting
// over a list of 200. The caller mounts this keyed by the query, so a new search
// starts at page one by construction: resetting in an effect would paint one
// frame of the new query at the old query's expanded limit.
function MatchList({ matches, selected, onSelect }) {
  const [limit, setLimit] = React.useState(ROW_PAGE);
  if (!matches.length) return <div className="code-nav-empty">No matching files</div>;
  return (
    <>
      {matches.length > limit ? (
        <MoreRows total={matches.length} limit={limit} depth={0} onMore={() => setLimit((n) => n + ROW_PAGE)} />
      ) : null}
      {matches.slice(0, limit).map((file) => (
        <FileRow key={file.path} file={file} selected={selected === file.path} onSelect={onSelect} compact />
      ))}
    </>
  );
}

function FileTree({ files, matches, query, selected, onSelect, folds, setFolderOpen }) {
  const [showAll, setShowAll] = React.useState(false);
  if (matches) return <MatchList key={query} matches={matches} selected={selected} onSelect={onSelect} />;
  const tree = treeFrom(files);
  return (
    <FolderBody node={tree} depth={0} showAll={showAll} setShowAll={setShowAll}
      folds={folds} setFolderOpen={setFolderOpen} selected={selected} onSelect={onSelect} />
  );
}

export function CodeBrowser({ env, active = true }) {
  // The url carries the env, and useFetch derives what it paints from the url
  // during render — so this is THIS env's tree or nothing, never the one next
  // door caught mid-switch.
  const { data: tree, err, loading, refresh } = useFetch(`/api/dash/code/${encodeURIComponent(env)}`, { pollMs: active ? 3000 : 0 });
  // Where the user is inside this env — the open file, the find box, and which
  // folders they left folded — is ONE piece of state stamped with the env it
  // belongs to, replaced during render when the env changes. As an effect it
  // lagged by a render, so switching worktrees fired a read for the previous
  // env's path against the new one, and painted one tree's folds over another's.
  //
  // One object rather than three that agree by convention: these answer the same
  // question ("where were you in THIS worktree") and there is no state in which
  // it is correct for them to disagree about which env that is.
  const readPlace = () => ({
    env,
    path: loadStr(`${FILE_KEY}:${env}`),
    query: '',
    folds: loadJSON(`${FOLDERS_KEY}:${env}`),
  });
  const [stored, setStored] = React.useState(readPlace);
  const place = stored.env === env ? stored : readPlace();
  if (place !== stored) setStored(place);
  const { path: selected, query, folds } = place;
  // Every setter restamps the env it was called under, so an update queued
  // across an env change can never write one env's answer onto the other's row.
  const setSelected = (path) => setStored((previous) => ({ ...previous, env, path }));
  const setQuery = (next) => setStored((previous) => ({ ...previous, env, query: next }));
  // Put the tree back the way it opens: just the changes, nothing revealed,
  // nothing paged. Folds are persisted so they must be cleared for real; the
  // reveals and page positions live per-mount, so bumping the key is what
  // forgets them — the same "start over is a fresh instance" rule the env
  // boundary already uses.
  const [viewNonce, setViewNonce] = React.useState(0);
  const resetView = () => {
    saveStr(`${FOLDERS_KEY}:${env}`, '{}');
    setStored((previous) => ({ ...previous, env, folds: {} }));
    setViewNonce((n) => n + 1);
  };
  const setFolderOpen = (folder, open) => setStored((previous) => {
    const next = { ...(previous.env === env ? previous.folds : {}), [folder]: open };
    saveStr(`${FOLDERS_KEY}:${env}`, JSON.stringify(next));
    return { ...previous, env, folds: next };
  });
  // Which side of a changed file the editor shows: the diff, the new file, or the
  // old file — a persisted preference that sticks across files and reloads.
  const [fileView, setFileView] = React.useState(() => {
    const v = loadStr(VIEW_KEY, 'diff');
    return VIEWS.includes(v) ? v : 'diff';
  });
  React.useEffect(() => { saveStr(VIEW_KEY, fileView); }, [fileView]);
  const [navW, setNavW] = React.useState(() => loadW(NAV_WIDTH_KEY, null));
  const [navResizing, setNavResizing] = React.useState(false);
  const browserRef = React.useRef(null);
  const navRef = React.useRef(null);
  // Persist the current selection so a reopen lands back on it.
  React.useEffect(() => { if (selected) saveStr(`${FILE_KEY}:${env}`, selected); }, [env, selected]);
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
  const files = tree?.files || [];
  const selectedMeta = files.find((item) => item.path === selected) || null;
  React.useEffect(() => {
    if (!files.length || selectedMeta) return;
    setSelected(files.find((file) => file.status)?.path || files[0].path);
  }, [tree, selectedMeta]); // eslint-disable-line react-hooks/exhaustive-deps
  const file = useFetch(fileUrl(env, selected, tree, selectedMeta), { pollMs: active ? 3000 : 0 });

  if (loading && !tree) return <PaneEmpty title="Loading workspace…" />;
  if (err && !tree) {
    return (
      <PaneEmpty title="No workspace">
        <p>{err}</p>
      </PaneEmpty>
    );
  }
  const changed = files.filter((item) => item.status);
  // A search replaces the tree with its matches, so the heading counts THOSE —
  // "12 files" while showing 12, not while showing 12 out of the whole repo.
  const normalized = query.trim().toLowerCase();
  const matches = normalized ? files.filter((file) => file.path.toLowerCase().includes(normalized)) : null;
  return (
    <div
      className={`code-browser${navResizing ? ' code-nav-wresizing' : ''}`}
      ref={browserRef}
      style={navW != null ? { gridTemplateColumns: `${navW}px minmax(0, 1fr)` } : undefined}
    >
      <aside className="code-nav" aria-label="Repository files" ref={navRef}>
        <div className="code-nav-wresize" title="Drag to resize" onPointerDown={startWidthResize} />
        <label className="code-search">
          <Search size={13} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find file" aria-label="Find file" />
        </label>
        <section className="code-nav-section code-nav-files">
          <div className="code-nav-heading">
            <span>{matches ? plural(matches.length, 'file') : plural(changed.length, 'change')}</span>
            {/* "Reset" here means the VIEW — put the tree back the way it opens.
                Throwing the branch's work away is a different kind of act and
                lives with the other whole-branch operations, behind the sync
                button's chevron. */}
            <button type="button" className="code-reset-btn" onClick={resetView}
              title="Collapse the tree back to just the changes">Reset view</button>
          </div>
          <div className="code-nav-list">
            {/* Keyed by env AND by the reset: "how far have I paged" and "have I
                revealed this folder's other files" are answers about one worktree
                and one visit, and neither should outlive its question. */}
            <FileTree key={`${env}:${viewNonce}`} files={files} matches={matches} query={normalized} selected={selected}
              onSelect={setSelected} folds={folds} setFolderOpen={setFolderOpen} />
          </div>
        </section>
      </aside>
      <main className="code-content">
        <header className="code-file-bar">
          <span className="code-file-path" title={selectedMeta?.oldPath ? `${selectedMeta.oldPath} → ${selected}` : selected || ''}>{selected || 'No file selected'}</span>
          {selectedMeta?.status ? <span className={`code-kind code-kind--${selectedMeta.status}`}>{STATUS[selectedMeta.status].label}</span> : null}
          <span className="code-base">{selectedMeta?.status ? `vs ${tree.base}` : 'read only'}</span>
          {file.data?.kind === 'diff' ? (
            <div className="seg" role="group" aria-label="File view">
              {[['new', 'New'], ['old', 'Old'], ['diff', 'Diff']].map(([mode, label]) => (
                <button key={mode} type="button" className={fileView === mode ? 'is-selected' : ''}
                  aria-pressed={fileView === mode} onClick={() => setFileView(mode)}>{label}</button>
              ))}
            </div>
          ) : null}
        </header>
        {/* The editor pane stays mounted through a load or an error and says so
            itself, so a cold open doesn't tear down the viewers this whole
            change exists to keep. */}
        <div className="code-editor-wrap">
          <MonacoCodeView env={env} file={file.data} view={fileView} loading={file.loading} error={file.err} />
        </div>
      </main>
    </div>
  );
}
