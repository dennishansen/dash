import React from 'react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker.js?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker.js?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker.js?worker';
import TypeScriptWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker.js?worker';
import { getTheme, onThemeChange } from './theme.js';
import { touch, trim } from './lru.js';

// Monaco's local worker keeps the code surface self-contained; no CDN or
// external VS Code host is involved. One general editor worker is enough for a
// read-only review surface (tokenization stays in the editor bundle).
if (typeof self !== 'undefined') {
  self.MonacoEnvironment = {
    ...(self.MonacoEnvironment || {}),
    getWorker: (_moduleId, label) => {
      if (label === 'json') return new JsonWorker();
      if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
      if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
      if (label === 'typescript' || label === 'javascript') return new TypeScriptWorker();
      return new EditorWorker();
    },
  };
}

function useDashTheme() {
  const [theme, setTheme] = React.useState(getTheme);
  React.useEffect(() => onThemeChange(setTheme), []);
  return theme;
}

const commonOptions = {
  automaticLayout: true,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: 12,
  lineHeight: 19,
  minimap: { enabled: false },
  overviewRulerBorder: false,
  padding: { top: 12, bottom: 16 },
  readOnly: true,
  renderLineHighlight: 'none',
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  stickyScroll: { enabled: true },
  wordWrap: 'off',
};

const diffOptions = {
  ...commonOptions,
  diffAlgorithm: 'advanced',
  diffWordWrap: 'on',
  enableSplitViewResizing: false,
  hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 3, revealLineCount: 8 },
  originalEditable: false,
  renderIndicators: true,
  renderMarginRevertIcon: false,
  renderSideBySide: false,
  renderOverviewRuler: false,
  revealFirstDiff: true,
};

// A model is keyed by URI precisely so it can outlive the editor showing it, and
// this pane used to dispose both on every file or view change — so returning to a
// file you had open ten seconds ago paid for a whole new editor. They live here
// instead, past unmount, bounded, least-recently-used first.
//
// The URI carries the ENV. Two worktrees hold the same paths, and a model keyed
// on path alone would show one worktree's file inside another's tree — a hazard
// invisible until now only because nothing was ever reused.
const MODEL_CAP = 48;
const models = new Map(); // uri string → { model, text }

// Where you were in each thing you've looked at. Bounded on the same policy as
// the models, just further out — a scroll offset and a few fold ranges cost
// nothing next to a file's text, and remembering more of them is the point.
const VIEW_STATE_CAP = 400;
const viewStates = new Map(); // `${env}\0${path}\0${side}` → scroll/fold position

function remember(key, state) {
  touch(viewStates, key, state);
  trim(viewStates, VIEW_STATE_CAP);
}

function uriFor(env, file, side) {
  return monaco.Uri.from({ scheme: 'artifact', authority: env || 'main', path: `/${file}`, query: side });
}

function modelFor(env, file, side, text, language) {
  const uri = uriFor(env, file, side);
  const key = uri.toString();
  let entry = models.get(key);
  if (entry?.model.isDisposed()) { models.delete(key); entry = undefined; }
  if (!entry) {
    // Monaco keeps its own registry and throws on a duplicate URI, so adopt any
    // model already standing at this one rather than minting a second.
    const model = monaco.editor.getModel(uri) || monaco.editor.createModel(text, language, uri);
    entry = { model, text: model.getValue() };
  }
  touch(models, key, entry);
  if (entry.text !== text) { entry.model.setValue(text); entry.text = text; }
  trim(models, MODEL_CAP, {
    inUse: (held) => held.model.isAttachedToEditor(), // on screen right now — not ours to drop
    release: (held) => held.model.dispose(),
  });
  return entry.model;
}

function unsupportedMessage(reason) {
  return reason === 'binary' ? 'Binary file'
    : reason === 'large' ? 'File is too large to preview'
      : reason === 'symlink' ? 'Symlink preview is unavailable'
        : 'Preview unavailable';
}

// The editor pane: a diff viewer and a single-file viewer, both mounted for the
// life of the pane, and whatever message stands in when there's nothing to show.
// A changed file carries both sides, so `view` picks the diff (default), just the
// new file, or just the old one; an unchanged file has only one side and ignores
// it. Switching either file or view re-points an existing editor at an existing
// model — no construction, and the scroll position you left comes back with it.
export function MonacoCodeView({ env, file, view = 'diff', loading = false, error = null }) {
  const diffHostRef = React.useRef(null);
  const codeHostRef = React.useRef(null);
  const diffEditorRef = React.useRef(null);
  const codeEditorRef = React.useRef(null);
  const shownRef = React.useRef(null);
  const theme = useDashTheme();

  const shows = Boolean(file) && file.kind !== 'unsupported';
  const asDiff = shows && file.kind === 'diff' && view === 'diff';
  const message = error ? error
    : loading && !file ? 'Loading file…'
      : !file ? 'Select a file to inspect.'
        : file.kind === 'unsupported' ? unsupportedMessage(file.reason)
          : null;

  React.useEffect(() => {
    if (!shows) return;
    const previous = shownRef.current;
    if (previous) remember(previous.key, previous.editor.saveViewState());
    const old = !asDiff && file.kind === 'diff' && view === 'old';
    // The saved position is named by what is actually ON SCREEN — the diff, or
    // one named side of a file. The view must not enter the key when it is being
    // ignored: an unchanged file has a single side, so scrolling it, flipping
    // New/Old on some other file, and coming back would otherwise look up a
    // position that was never stored under that name, and the file would jump.
    // It also keeps the two editors' incompatible state shapes apart, since only
    // the diff editor ever answers to "diff".
    const side = asDiff ? 'diff'
      : file.kind === 'diff' ? (old ? 'original' : 'modified')
        : 'source';
    let editor;
    if (asDiff) {
      editor = diffEditorRef.current
        ||= monaco.editor.createDiffEditor(diffHostRef.current, diffOptions);
      editor.setModel({
        original: modelFor(env, file.oldPath || file.path, 'original', file.original, file.language),
        modified: modelFor(env, file.path, 'modified', file.modified, file.language),
      });
    } else {
      editor = codeEditorRef.current
        ||= monaco.editor.create(codeHostRef.current, commonOptions);
      const text = file.kind === 'diff' ? (old ? file.original : file.modified) : file.text;
      const path = old ? (file.oldPath || file.path) : file.path;
      // Prose wraps; code scrolls. Markdown is the one language here whose long
      // lines are meant to be read, not scrolled past. (The diff editor already
      // wraps via diffWordWrap.)
      editor.updateOptions({ wordWrap: file.language === 'markdown' ? 'on' : 'off' });
      editor.setModel(modelFor(env, path, side, text, file.language));
    }
    monaco.editor.setTheme(theme === 'light' ? 'vs' : 'vs-dark');
    const key = `${env}\0${file.path}\0${side}`;
    editor.layout(); // the idle host keeps its box, but a first reveal needs the nudge
    editor.restoreViewState(viewStates.get(key) ?? null);
    shownRef.current = { key, editor };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env, file, view, shows, asDiff]);

  // Only unmounting disposes an editor — and the models it held stay in the
  // registry, which is the whole point of keeping them there.
  React.useEffect(() => () => {
    const shown = shownRef.current;
    if (shown) remember(shown.key, shown.editor.saveViewState());
    diffEditorRef.current?.dispose();
    codeEditorRef.current?.dispose();
    diffEditorRef.current = null;
    codeEditorRef.current = null;
    shownRef.current = null;
  }, []);

  React.useEffect(() => {
    monaco.editor.setTheme(theme === 'light' ? 'vs' : 'vs-dark');
  }, [theme]);

  const host = (ref, live) => ({
    ref,
    className: `code-editor${live ? '' : ' code-editor--idle'}`,
    'aria-hidden': live ? undefined : 'true',
    ...(live ? { 'data-view': file.kind === 'diff' ? view : file.kind, 'data-path': file.path } : {}),
  });
  return (
    <>
      <div {...host(diffHostRef, shows && asDiff)} />
      <div {...host(codeHostRef, shows && !asDiff)} />
      {message ? <div className="code-editor-empty">{message}</div> : null}
    </>
  );
}
