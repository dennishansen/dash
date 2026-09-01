// The board's structured filter model — three fields (owner, tags, created),
// each an {op, values} selection: an operator plus a Set of chosen values, AND
// across fields. The board holds the state and renders the pickers; this module
// is the pure meaning: one matcher, one active-check, the option derivations. It
// mirrors issue-search.js — the board's OTHER filter — which is likewise a small,
// pure, shared module rather than logic bolted into the view.

import { normalizeEmail } from '../server/profiles-store.mjs';

// The fields, in the order they appear in the add-filter menu and as pills.
export const FILTER_FIELDS = ['owner', 'tags', 'created'];

// Created is SINGLE-SELECT: a recency horizon is naturally one choice ("things
// from the last N days"), so picking a bucket replaces the prior one rather than
// OR-ing — which also sidesteps the redundant unions that overlapping horizons
// would produce. Owner and tags stay multi-select OR. (Notion's date filter is
// likewise a single "is within".)
export const SINGLE_SELECT_FIELDS = new Set(['created']);

// EMPTINESS IS A VALUE. "Has no owner" is a thing an owner filter can look for,
// exactly like "has owner Dennis" is — so it belongs in the value list rather
// than in a second, parallel axis of operators. That collapses four operators
// (contains / does not contain / is empty / is not empty) into two, and buys
// composition the old model couldn't express: "contains: (none), dash" is one
// filter for untagged-or-tagged-dash, which needed two filters before.
//
// The sentinel carries a NUL, which no tag and no email can contain — so it can
// never collide with a real value, and it survives JSON for the stored filters.
export const EMPTY_VALUE = '\u0000empty';
export const EMPTY_LABEL = '(none)';

// The operators owner/tags can take (created is a single-select recency horizon
// and takes none). Each operator is its OWN authority — its label and how it
// tests an issue's value set against the selected values. `fieldActive`,
// `fieldMatches`, and the UI all read THIS one table, so there is no second
// place that knows what "not-contains" means, and an operator not in this table
// is inert everywhere (it can never silently blank the board).
const someIn = (owned, values) => { for (const v of values) if (owned.has(v)) return true; return false; };
export const FILTER_OPERATORS = [
  { value: 'contains',     label: 'Is',     test: (owned, values) => someIn(owned, values) },
  { value: 'not-contains', label: "Isn't", test: (owned, values) => !someIn(owned, values) },
];
const OPERATOR = Object.fromEntries(FILTER_OPERATORS.map(o => [o.value, o]));
export const DEFAULT_OP = 'contains';
// Which fields expose the operator selector — created does not.
export function fieldHasOperators(field) { return field !== 'created'; }

// Created-date buckets, newest→oldest, each an inclusive [minAgeDays, maxAgeDays]
// window on how many days ago the issue was created. Labels name the ROLLING
// window honestly (they nest — Today ⊂ Last 7 days ⊂ Last 30 days — but the
// field is single-select, so only one is ever active and the nesting never
// surfaces as a redundant union). `older` is the complement (30+ days ago), so
// it carries its own lower bound rather than an open-ended max.
export const CREATED_BUCKETS = [
  { value: 'today', label: 'Today',        minAgeDays: 0,  maxAgeDays: 0 },
  { value: 'week',  label: 'Last 7 days',  minAgeDays: 0,  maxAgeDays: 6 },
  { value: 'month', label: 'Last 30 days', minAgeDays: 0,  maxAgeDays: 29 },
  { value: 'older', label: 'Older',        minAgeDays: 30, maxAgeDays: Infinity },
];
const BUCKET_BY_VALUE = Object.fromEntries(CREATED_BUCKETS.map(b => [b.value, b]));

// A fresh, inactive filter state: a default operator + an empty value Set per
// field. (created's op is unused — it has no operator.)
export function emptyFilters() {
  return {
    owner:   { op: DEFAULT_OP, values: new Set() },
    tags:    { op: DEFAULT_OP, values: new Set() },
    created: { op: DEFAULT_OP, values: new Set() },
  };
}

// A filter set is the board's QUESTION — which issues you are looking at — so
// it has to outlive a reload the way the view mode and the collapsed columns
// already do. Sets don't survive JSON and a stored value can be older than the
// code reading it, so these two are the only places that know how a filter state
// flattens and how it comes back. Anything unrecognised is dropped rather than
// trusted: a value that isn't a string, a field the catalogue no longer has, or
// an operator the table no longer knows (which would restore a field that looks
// set but constrains nothing).
export function serializeFilters(filters) {
  const out = {};
  for (const field of FILTER_FIELDS) {
    const sel = filters?.[field];
    if (!sel) continue;
    out[field] = { op: sel.op, values: [...sel.values] };
  }
  return out;
}

// The two operators that emptiness-as-a-value replaced. A filter saved before
// that change still means something exact, so it is translated rather than
// dropped: "is empty" was contains-nothing, "is not empty" was contains-anything
// -but-nothing. Restoring the default instead would silently widen someone's
// board to every row.
const RETIRED_OPS = {
  empty:       { op: 'contains',     values: [EMPTY_VALUE] },
  'not-empty': { op: 'not-contains', values: [EMPTY_VALUE] },
};

export function parseFilters(raw) {
  const next = emptyFilters();
  if (!raw || typeof raw !== 'object') return next;
  for (const field of FILTER_FIELDS) {
    const sel = raw[field];
    if (!sel || typeof sel !== 'object') continue;
    const retired = RETIRED_OPS[sel.op];
    if (retired) {
      next[field].op = retired.op;
      next[field].values = new Set(retired.values);
      continue;
    }
    next[field].op = OPERATOR[sel.op] ? sel.op : DEFAULT_OP;
    next[field].values = new Set(
      (Array.isArray(sel.values) ? sel.values : []).filter(v => typeof v === 'string'),
    );
  }
  return next;
}

// Is this field constraining the board? One rule now that emptiness is just a
// value: it needs at least one value chosen. An UNKNOWN operator is inert (the
// single-authority table has no entry for it), so it can never blank the board.
export function fieldActive(field, sel) {
  if (!sel) return false;
  if (!sel.values.size) return false;
  return fieldHasOperators(field) ? !!OPERATOR[sel.op] : true;
}

// Is any field constraining the board? Drives the funnel's lit state and (with
// search) the reorder-disable invariant.
export function anyFilterActive(filters) {
  return FILTER_FIELDS.some(f => fieldActive(f, filters[f]));
}

// Whole-day count from a 'YYYY-MM-DD' created string to `now` (also
// 'YYYY-MM-DD') — how many days ago it was created. Both parsed at UTC midnight
// so the delta is timezone-independent and an exact integer. A future-dated row
// yields a NEGATIVE age, so it matches no bucket (Today starts at 0) — a card
// stamped tomorrow is an anomaly we decline to classify rather than mislabel as
// "today". NaN for a missing/unparseable date — the caller rejects it too.
export function ageInDays(created, now) {
  if (!created) return NaN;
  const a = Date.parse(`${created}T00:00:00Z`);
  const b = Date.parse(`${now}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return Math.round((b - a) / 86400000);
}

// Does a created date fall in a bucket, relative to `now`? A dateless/unparseable
// row matches NO bucket (it can't be classified). Nested bounds mean today's
// card answers true for today/week/month alike.
export function createdMatches(created, bucketValue, now) {
  const bucket = BUCKET_BY_VALUE[bucketValue];
  if (!bucket) return false;
  const age = ageInDays(created, now);
  if (Number.isNaN(age)) return false;
  return age >= bucket.minAgeDays && age <= bucket.maxAgeDays;
}

// What an issue "has" for a field — and an issue that has nothing has the EMPTY
// sentinel, which is what lets one `contains` test answer both "owned by X" and
// "owned by nobody" without the matcher knowing emptiness is special.
function issueValueSet(field, issue) {
  const owned = field === 'owner'
    ? (normalizeEmail(issue.owner) ? new Set([normalizeEmail(issue.owner)]) : new Set())
    : new Set(issue.tags ?? []);
  return owned.size ? owned : new Set([EMPTY_VALUE]);
}

// One ACTIVE field against one issue. Created is a recency OR over its buckets;
// owner/tags delegate to the operator table's own `test` — the single authority
// for what each operator means. An unknown operator imposes no constraint (belt
// and suspenders — `fieldActive` already treats it as inert).
function fieldMatches(field, issue, sel, now) {
  if (field === 'created') return [...sel.values].some(b => createdMatches(issue.created, b, now));
  const op = OPERATOR[sel.op];
  if (!op) return true;
  return op.test(issueValueSet(field, issue), sel.values);
}

// The whole filter state against one issue: it must satisfy every ACTIVE field
// (AND across fields). An inactive field imposes no constraint. `now` is today's
// 'YYYY-MM-DD', threaded in so the matcher stays pure and testable.
export function issueMatchesFilters(issue, filters, now) {
  for (const field of FILTER_FIELDS) {
    const sel = filters[field];
    if (!fieldActive(field, sel)) continue;
    if (!fieldMatches(field, issue, sel, now)) return false;
  }
  return true;
}

// Distinct tags across the corpus, sorted — the tag field's options.
export function tagOptions(issues) {
  const s = new Set();
  for (const i of issues ?? []) for (const t of i.tags ?? []) s.add(t);
  return [...s].sort();
}

// The value list a set-valued field offers, with "(none)" leading it. Emptiness
// is a value, so it is a row like any other — first, because it is the one
// choice that is always available whatever the corpus happens to hold.
export function withEmptyOption(options) {
  return [{ value: EMPTY_VALUE, label: EMPTY_LABEL }, ...options];
}

// Normalized owner emails that hold ≥1 issue — the owner field's candidate
// values. Ordering (by display name) is the caller's job, since names live in
// the roster; this only answers "who can this field match".
export function ownerEmailsPresent(issues) {
  const s = new Set();
  for (const i of issues ?? []) {
    const e = normalizeEmail(i.owner);
    if (e) s.add(e);
  }
  return s;
}

// Today as 'YYYY-MM-DD' in LOCAL time — the `now` the board threads into the
// matcher. Local (not UTC) so "today" means the user's calendar day, not a day
// that flips at UTC midnight.
export function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
