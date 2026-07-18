// The dash's single issue text-search. Both the board's search box and the ⌘K
// command palette match through here, so a query behaves identically in both
// places — id, title, and tags, case-insensitive substring. Forking a second
// search for the palette was the exact thing to avoid (i-dash-cmdk).

// The lowercased haystack for one issue: id + title + tags — the fields a human
// scanning the board searches by.
export function issueHaystack(issue) {
  return (issue.id + ' ' + (issue.title || '') + ' ' + (issue.tags || []).join(' ')).toLowerCase();
}

// Filter issues to those matching `query` (trimmed, case-insensitive substring).
// An empty/whitespace query matches everything — the caller decides whether to
// show that (the board shows the full board; the palette lists every issue).
export function searchIssues(issues, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return issues;
  return issues.filter(i => issueHaystack(i).includes(q));
}
