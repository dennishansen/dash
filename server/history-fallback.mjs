// Dash history fallback for dev and preview servers.
//
// BrowserRouter uses real /dash/* paths, while Vite's generic SPA fallback
// serves the canvas entry for an unknown document. Rewrite only the declared
// Dash document routes to its entry before that fallback runs; source modules,
// release assets, gifs, and every other neighbour under /dash/ keep their own
// handlers.

import { DASH_BASENAME, isDashDocumentPath } from '../src/routes.mjs';

export function dashHistoryFallback({
  basename = DASH_BASENAME,
  isDocumentPath = isDashDocumentPath,
  error = null,
} = {}) {
  const rewrite = (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return;
    const q = (req.url || '/').indexOf('?');
    const pathname = q === -1 ? (req.url || '/') : req.url.slice(0, q);
    const search = q === -1 ? '' : req.url.slice(q);
    if (pathname !== `${basename}/` && isDocumentPath(pathname)) {
      req.url = `${basename}/index.html${search}`;
    }
  };
  // A returned configureServer value is a post-hook; keep this body braced so
  // Connect's return value never moves the rewrite behind Vite's SPA fallback.
  const use = (server) => {
    server.middlewares.use((req, res, next) => {
      const q = (req.url || '/').indexOf('?');
      const pathname = q === -1 ? (req.url || '/') : req.url.slice(0, q);
      if (error
        && (req.method === 'GET' || req.method === 'HEAD')
        && (pathname === basename || pathname.startsWith(`${basename}/`))) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(error);
        return;
      }
      rewrite(req);
      next();
    });
  };
  return {
    name: 'dash-history-fallback',
    configureServer: use,
    configurePreviewServer: use,
  };
}
