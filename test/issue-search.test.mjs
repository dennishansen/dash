// Tests for the one issue matcher (src/issue-search.js), shared by the board
// search box and the ⌘K command palette. Run: `npm test`.
//
// Pure logic — no browser, no store — so it pins the contract both callers
// depend on: id, title, and tag substring matching, case-insensitive, trimmed,
// with an empty query meaning "everything".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchIssues, issueHaystack } from '../src/issue-search.js';

const ISSUES = [
  { id: 'i-dash-cmdk', title: 'dash cmd-k search', tags: ['ux'] },
  { id: 'i-solver-jitter', title: 'Solver jitter on drag', tags: ['solver', 'render'] },
  { id: 'i-9f3a', title: 'Fix the RAIL snapping', tags: [] },
  { id: 'i-empty', title: '' },
];
const ids = (rows) => rows.map(r => r.id).join(',');

test('empty / whitespace / undefined query returns everything', () => {
  assert.equal(ids(searchIssues(ISSUES, '')), ids(ISSUES));
  assert.equal(ids(searchIssues(ISSUES, '   ')), ids(ISSUES));
  assert.equal(ids(searchIssues(ISSUES, undefined)), ids(ISSUES));
});

test('matches title substring, case-insensitively', () => {
  assert.equal(ids(searchIssues(ISSUES, 'jitter')), 'i-solver-jitter');
  assert.equal(ids(searchIssues(ISSUES, 'RAIL')), 'i-9f3a');
  assert.equal(ids(searchIssues(ISSUES, 'rail')), 'i-9f3a');
});

test('matches by id — substring and prefix', () => {
  assert.equal(ids(searchIssues(ISSUES, 'cmdk')), 'i-dash-cmdk');
  assert.equal(ids(searchIssues(ISSUES, 'i-solver')), 'i-solver-jitter');
});

test('matches by tag', () => {
  assert.equal(ids(searchIssues(ISSUES, 'solver')), 'i-solver-jitter');
});

test('trims surrounding whitespace before matching', () => {
  assert.equal(ids(searchIssues(ISSUES, '  jitter  ')), 'i-solver-jitter');
});

test('no match returns an empty list', () => {
  assert.equal(searchIssues(ISSUES, 'zzzz-nope').length, 0);
});

test('haystack tolerates an empty title and a missing tags array', () => {
  assert.equal(issueHaystack({ id: 'x', title: '' }), 'x  ');
  assert.equal(issueHaystack({ id: 'x', title: 'y' }), 'x y ');
});

test('preserves input order, never mutates or reorders', () => {
  assert.equal(ids(searchIssues(ISSUES, 'i-')), ids(ISSUES));
});
