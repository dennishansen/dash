// The transport-level run namespace for remote dash test stores. Production
// stores are unchanged; selecting a dash_test_* table makes a run id mandatory
// and every REST row/query carries it.
const ENV = (typeof process !== 'undefined' && process.env) || {};

export const RUN_ID = ENV.DASH_TEST_RUN_ID
  || (typeof __DASH_TEST_RUN_ID__ !== 'undefined' ? __DASH_TEST_RUN_ID__ : null)
  || null;

export const RUN_TABLES = new Set([
  'dash_test_issues',
  'dash_test_profiles',
  'dash_test_people',
  'dash_test_chats',
  'dash_test_chat_turns',
]);
const RETIRED_SHARED_TEST_TABLES = new Set([
  'issues_test',
  'dash_profiles_test',
  'dash_chats_test',
  'dash_chat_turns_test',
]);

export const isRunTable = table => RUN_TABLES.has(table);

export function requireRunId(table) {
  if (RETIRED_SHARED_TEST_TABLES.has(table)) {
    throw new Error(`shared test store "${table}" is retired — use the run-owned dash_test_* store`);
  }
  if (!isRunTable(table)) return null;
  if (!RUN_ID) {
    throw new Error(`store "${table}" requires DASH_TEST_RUN_ID — a test store without an owning run is not isolated`);
  }
  return RUN_ID;
}

// The ONE authority for a store request's query string — callers pass bare
// terms and never write the `?` themselves, so scoped and unscoped tables can't
// disagree about the shape. An unscoped table gets its terms back untouched; a
// run table gets the run filter first.
export function queryFor(table, query = '') {
  const runId = requireRunId(table);
  const terms = String(query || '').replace(/^\?/, '');
  if (!runId) return terms ? `?${terms}` : '';
  return `?run_id=eq.${encodeURIComponent(runId)}${terms ? `&${terms}` : ''}`;
}

export function rowFor(table, row) {
  const runId = requireRunId(table);
  return runId ? { ...row, run_id: runId } : row;
}

export function rowsFor(table, rows) {
  return rows.map(row => rowFor(table, row));
}

export function stripRunId(row) {
  if (!row || typeof row !== 'object' || !Object.hasOwn(row, 'run_id')) return row;
  const { run_id: _transportScope, ...canonical } = row;
  return canonical;
}
