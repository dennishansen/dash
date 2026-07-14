import React from 'react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker.js?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker.js?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker.js?worker';
import TypeScriptWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker.js?worker';
import { getTheme, onThemeChange } from './theme.js';

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

function uriFor(file, side) {
  return monaco.Uri.from({ scheme: 'artifact', path: `/${file}`, query: side });
}

export function MonacoCodeView({ file }) {
  const hostRef = React.useRef(null);
  const theme = useDashTheme();

  React.useEffect(() => {
    if (!hostRef.current || !file || file.kind === 'unsupported') return undefined;
    const models = [];
    let editor;
    if (file.kind === 'diff') {
      const original = monaco.editor.createModel(file.original, file.language, uriFor(file.oldPath || file.path, 'original'));
      const modified = monaco.editor.createModel(file.modified, file.language, uriFor(file.path, 'modified'));
      models.push(original, modified);
      editor = monaco.editor.createDiffEditor(hostRef.current, {
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
      });
      editor.setModel({ original, modified });
    } else {
      const model = monaco.editor.createModel(file.text, file.language, uriFor(file.path, 'source'));
      models.push(model);
      editor = monaco.editor.create(hostRef.current, { ...commonOptions, model });
    }
    monaco.editor.setTheme(theme === 'light' ? 'vs' : 'vs-dark');
    return () => {
      editor?.dispose();
      models.forEach((model) => model.dispose());
    };
  }, [file]);

  React.useEffect(() => {
    monaco.editor.setTheme(theme === 'light' ? 'vs' : 'vs-dark');
  }, [theme]);

  if (!file) return <div className="code-editor-empty">Select a file to inspect.</div>;
  if (file.kind === 'unsupported') {
    const message = file.reason === 'binary' ? 'Binary file'
      : file.reason === 'large' ? 'File is too large to preview'
        : file.reason === 'symlink' ? 'Symlink preview is unavailable'
          : 'Preview unavailable';
    return <div className="code-editor-empty">{message}</div>;
  }
  return (
    <div
      ref={hostRef}
      className="code-editor"
      data-view={file.kind}
      data-path={file.path}
    />
  );
}
