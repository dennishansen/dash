// Durable identity, ownership and completion notification for dash test jobs.
// Data lives in Supabase; Realtime is only the wake-up signal and every join or
// reconnect re-reads the row, so a missed frame cannot lose completion.
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { URL, ANON, SERVICE, rest, restUrl, RPC } from './supabase.mjs';

export const TEST_RUNS_TABLE = 'dash_test_runs';
const RUNS = restUrl(TEST_RUNS_TABLE);
const enc = encodeURIComponent;
const HEARTBEAT_MS = 15_000;

export const isTerminalStatus = status => status === 'completed' || status === 'failed';

export async function createTestRun({
  id = crypto.randomUUID(),
  command,
  branch = null,
  commitSha = null,
} = {}) {
  if (!command) throw new Error('createTestRun requires command');
  const rows = await rest(RUNS, 'POST', '', [{
    id, command, branch, commit_sha: commitSha, status: 'queued',
  }], 'return=representation');
  return rows[0];
}

export async function createRecoverableTestRun(fields, {
  create = createTestRun,
  read = getTestRun,
  readAttempts = 8,
  retryMinMs = 100,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const id = fields.id || crypto.randomUUID();
  try {
    return await create({ ...fields, id });
  } catch (createError) {
    let readError = null;
    for (let attempt = 0; attempt < readAttempts; attempt++) {
      try {
        const row = await read(id);
        if (row) return row;
        const missing = new Error(
          `test run ${id} was not committed after create failed: ${createError.message}`,
        );
        missing.runId = id;
        missing.cause = createError;
        throw missing;
      } catch (error) {
        if (error.runId === id) throw error;
        readError = error;
      }
      if (attempt + 1 < readAttempts) {
        await sleep(Math.min(retryMinMs * (2 ** attempt), 2000));
      }
    }
    const unavailable = new Error(
      `test run ${id} create outcome is unknown: ${(readError || createError).message}`,
    );
    unavailable.runId = id;
    unavailable.cause = readError || createError;
    throw unavailable;
  }
}

export async function getTestRun(id) {
  const rows = await rest(RUNS, 'GET', `?id=eq.${enc(id)}&select=*&limit=1`);
  return rows?.[0] || null;
}

export async function deleteTestRun(id) {
  await rest(RUNS, 'DELETE', `?id=eq.${enc(id)}`, null, 'return=minimal');
}

export async function claimTestRun(id, {
  runnerId = crypto.randomUUID(),
  host = null,
  pid = process.pid,
} = {}) {
  const now = new Date().toISOString();
  const rows = await rest(RUNS, 'PATCH',
    `?id=eq.${enc(id)}&status=eq.queued&select=*`, {
      status: 'running',
      runner_id: runnerId,
      runner_host: host,
      runner_pid: pid,
      started_at: now,
      heartbeat_at: now,
    }, 'return=representation');
  if (!rows?.length) throw new Error(`test run ${id} is not queued or does not exist`);
  return rows[0];
}

export async function failQueuedTestRun(id, error = 'test supervisor did not claim queued run') {
  const now = new Date().toISOString();
  const rows = await rest(RUNS, 'PATCH',
    `?id=eq.${enc(id)}&status=eq.queued&select=*`, {
      status: 'failed',
      completed_at: now,
      heartbeat_at: now,
      fixtures_cleaned_at: now,
      error,
      result: { failure_kind: 'launch-failure' },
    }, 'return=representation');
  return rows?.[0] || getTestRun(id);
}

export async function heartbeatTestRun(id, runnerId) {
  const rows = await rest(RUNS, 'PATCH',
    `?id=eq.${enc(id)}&status=eq.running&runner_id=eq.${enc(runnerId)}&select=id`, {
      heartbeat_at: new Date().toISOString(),
    }, 'return=representation');
  if (!rows?.length) throw new Error(`test run ${id} is no longer owned by runner ${runnerId}`);
}

export async function joinTestRun(id, runnerId) {
  // Joining never extends liveness. Database time proves that the remotely
  // matching owner is both running and fresh; only ownsLease processes refresh
  // heartbeat_at.
  const rows = await rest(RPC, 'POST', '/validate_dash_test_run_lease', {
    p_id: id,
    p_runner_id: runnerId,
    p_stale_after: '45 seconds',
  });
  const row = rows?.[0] || null;
  if (!row) {
    throw new Error(`test run ${id} is not owned by live supervisor ${runnerId}`);
  }
  return row;
}

// One process owns the durable lease. A nested runner may join only by
// presenting that exact owner id and proving it against the remote row; an env
// flag alone can never opt out of persistence.
export async function acquireTestRun({
  command,
  branch = null,
  commitSha = null,
  host = null,
  pid = process.pid,
} = {}) {
  const inheritedId = process.env.DASH_TEST_RUN_ID || null;
  const inheritedRunnerId = process.env.DASH_TEST_RUNNER_ID || null;
  if (inheritedId && inheritedRunnerId) {
    return {
      row: await joinTestRun(inheritedId, inheritedRunnerId),
      runnerId: inheritedRunnerId,
      ownsLease: false,
    };
  }

  const row = inheritedId
    ? await getTestRun(inheritedId)
    : await createTestRun({ command, branch, commitSha });
  if (!row) throw new Error(`test run ${inheritedId} does not exist`);
  const runnerId = crypto.randomUUID();
  const claimed = await claimTestRun(row.id, { runnerId, host, pid });
  process.env.DASH_TEST_RUN_ID = claimed.id;
  process.env.DASH_TEST_RUNNER_ID = runnerId;
  return { row: claimed, runnerId, ownsLease: true };
}

export function startTestRunHeartbeat(id, runnerId, {
  intervalMs = HEARTBEAT_MS,
  onError = error => console.error(`test-run heartbeat failed: ${error.message}`),
} = {}) {
  const timer = setInterval(() => {
    heartbeatTestRun(id, runnerId).catch(onError);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function updateTestRunProgress(id, runnerId, {
  totalFiles,
  passedFiles,
  failedFiles,
  currentFile,
  progress,
} = {}) {
  const patch = {};
  if (totalFiles !== undefined) patch.total_files = totalFiles;
  if (passedFiles !== undefined) patch.passed_files = passedFiles;
  if (failedFiles !== undefined) patch.failed_files = failedFiles;
  if (currentFile !== undefined) patch.current_file = currentFile;
  if (progress !== undefined) patch.progress = progress;
  const rows = await rest(RUNS, 'PATCH',
    `?id=eq.${enc(id)}&status=eq.running&runner_id=eq.${enc(runnerId)}&select=*`,
    patch, 'return=representation');
  if (!rows?.length) throw new Error(`test run ${id} is no longer owned by runner ${runnerId}`);
  return rows[0];
}

// A nested runner may report which inner file is active, but the process that
// owns the durable lease is the sole authority for the parent plan's counts.
// Both supervisors use this one projection so their join behavior cannot drift.
export function shapeTestRunProgress(ownsLease, fields = {}) {
  if (ownsLease) return { ...fields };
  const joined = {};
  if (fields.currentFile !== undefined) joined.currentFile = fields.currentFile;
  if (fields.progress !== undefined) joined.progress = fields.progress;
  return joined;
}

export function updateTestRunLeaseProgress(lease, fields) {
  return updateTestRunProgress(
    lease.row.id,
    lease.runnerId,
    shapeTestRunProgress(lease.ownsLease, fields),
  );
}

// Terminal state and fixture cleanup are one database transaction. Observers
// cannot receive "completed" while child rows still exist, and the durable
// result parent remains after its disposable issue/profile/chat fixtures go.
async function finishTestRun(id, runnerId, fields) {
  const payload = {
    p_id: id,
    p_runner_id: runnerId,
    p_status: fields.status,
    p_total_files: fields.total_files ?? null,
    p_passed_files: fields.passed_files ?? null,
    p_failed_files: fields.failed_files ?? null,
    p_result: fields.result ?? {},
    p_error: fields.error ?? null,
  };
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const rows = await rest(RPC, 'POST', '/finish_dash_test_run', payload);
      if (rows?.length) return rows[0];
      lastError = new Error(`test run ${id} is no longer owned by runner ${runnerId}`);
    } catch (error) {
      lastError = error;
    }
    try {
      const row = await getTestRun(id);
      if (row?.runner_id === runnerId && row.status === fields.status
          && row.fixtures_cleaned_at) return row;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
  throw lastError;
}

export function completeTestRun(id, runnerId, result) {
  return finishTestRun(id, runnerId, {
    status: 'completed',
    total_files: result.totalFiles ?? null,
    passed_files: result.passedFiles ?? null,
    failed_files: 0,
    result,
    error: null,
  });
}

export function failTestRun(id, runnerId, error, result = {}) {
  return finishTestRun(id, runnerId, {
    status: 'failed',
    total_files: result.totalFiles ?? null,
    passed_files: result.passedFiles ?? null,
    failed_files: result.failedFiles ?? null,
    result,
    error: String(error || 'test run failed'),
  });
}

export async function resolveStaleTestRun(id, staleAfter = '45 seconds') {
  const rows = await rest(RPC, 'POST', '/resolve_stale_dash_test_run', {
    p_id: id,
    p_stale_after: staleAfter,
  });
  return rows?.[0] || getTestRun(id);
}

function socketUrl() {
  return `${URL.replace(/^http/, 'ws')}/realtime/v1/websocket`
    + `?apikey=${encodeURIComponent(ANON)}&vsn=1.0.0`;
}

// Subscribe to one run. RESYNC is emitted only after the server acknowledges
// each join, including reconnects; callers use it to re-read durable state.
export function subscribeTestRun(id, onEvent, {
  WebSocketCtor = WebSocket,
  reconnectMinMs = 250,
  reconnectMaxMs = 5000,
  onSocket = () => {},
} = {}) {
  if (!SERVICE) throw new Error('test-run notifications require DASH_SUPABASE_SERVICE_KEY');
  const topic = `realtime:test-run:${id}`;
  let ws = null;
  let stopped = false;
  let ref = 0;
  let heartbeat = null;
  let reconnect = null;
  let backoff = reconnectMinMs;

  const clear = () => {
    clearInterval(heartbeat);
    clearTimeout(reconnect);
    heartbeat = reconnect = null;
  };
  const drop = () => {
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(); } catch {}
    ws = null;
  };
  const retry = () => {
    clear();
    drop();
    if (stopped) return;
    reconnect = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, reconnectMaxMs);
  };
  const connect = () => {
    if (stopped) return;
    clear();
    drop();
    ws = new WebSocketCtor(socketUrl());
    onSocket(ws);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        topic,
        event: 'phx_join',
        payload: {
          config: { postgres_changes: [{
            event: 'UPDATE', schema: 'public', table: TEST_RUNS_TABLE, filter: `id=eq.${id}`,
          }] },
          access_token: SERVICE,
        },
        ref: String(++ref),
      }));
      heartbeat = setInterval(() => {
        if (ws?.readyState === WebSocketCtor.OPEN) {
          ws.send(JSON.stringify({
            topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++ref),
          }));
        }
      }, HEARTBEAT_MS);
    };
    ws.onmessage = event => {
      let msg;
      try { msg = JSON.parse(String(event.data || '')); } catch { return; }
      if (msg.event === 'phx_reply' && msg.topic === topic) {
        if (msg.payload?.status === 'ok') {
          backoff = reconnectMinMs;
          onEvent({ event: 'RESYNC', record: null });
        } else retry();
      } else if (msg.event === 'postgres_changes') {
        const data = msg.payload?.data || {};
        if (data.table === TEST_RUNS_TABLE) {
          onEvent({ event: data.type || 'UPDATE', record: data.record || null });
        }
      } else if (msg.event === 'phx_error') {
        retry();
      }
    };
    ws.onclose = retry;
    ws.onerror = () => { try { ws.close(); } catch {} };
  };

  connect();
  return () => {
    stopped = true;
    clear();
    drop();
  };
}

export function waitForTerminal(id, {
  read = () => resolveStaleTestRun(id),
  subscribe = subscribeTestRun,
  staleCheckMs = 15_000,
  readRetryMinMs = 100,
  readRetryMaxMs = 2000,
  maxReadFailures = Infinity,
} = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    let unsubscribe = null;
    let unsubscribePending = false;
    let staleTimer = null;
    let readRetry = null;
    let reading = false;
    let refreshPending = false;
    let readFailures = 0;

    const stop = () => {
      clearInterval(staleTimer);
      clearTimeout(readRetry);
      if (unsubscribe) unsubscribe();
      else unsubscribePending = true;
    };
    const finish = row => {
      if (done || !row || !isTerminalStatus(row.status)) return false;
      done = true;
      stop();
      resolve(row);
      return true;
    };
    const fail = error => {
      if (done) return;
      done = true;
      stop();
      reject(error);
    };
    const refresh = async () => {
      if (done) return;
      if (readRetry) {
        refreshPending = true;
        return;
      }
      if (reading) {
        refreshPending = true;
        return;
      }
      reading = true;
      try {
        const row = await read(id);
        readFailures = 0;
        if (!row) {
          fail(new Error(`test run ${id} does not exist`));
          return;
        }
        finish(row);
      } catch (error) {
        if (done) return;
        // A network exception or server-side outage is temporary durable-state
        // unavailability; keep the run handle alive while Realtime reconnects.
        // Authentication and most other 4xx responses are permanent for this
        // caller. Request timeout, Too Early, and rate limiting are explicitly
        // retryable; Retry-After, when supplied, is part of that contract.
        const retryableClientStatus = [408, 425, 429].includes(error?.status);
        if (Number.isInteger(error?.status) && error.status >= 400
            && error.status < 500 && !retryableClientStatus) {
          fail(error);
          return;
        }
        readFailures++;
        if (readFailures >= maxReadFailures) {
          fail(error);
          return;
        }
        const backoff = Math.min(
          readRetryMinMs * (2 ** (readFailures - 1)),
          readRetryMaxMs,
        );
        const delay = Math.max(backoff, Number(error?.retryAfterMs) || 0);
        clearTimeout(readRetry);
        readRetry = setTimeout(() => {
          readRetry = null;
          refreshPending = false;
          void refresh();
        }, delay);
      } finally {
        reading = false;
        if (refreshPending && !done && !readRetry) {
          refreshPending = false;
          queueMicrotask(refresh);
        }
      }
    };

    // Subscribe first, then read: an update in the gap is either delivered or
    // present in the read. Every joined/rejoined socket asks for another read.
    unsubscribe = subscribe(id, event => {
      if (finish(event?.record)) return;
      if (event?.event === 'RESYNC') void refresh();
    });
    if (unsubscribePending) unsubscribe();
    // Realtime owns normal completion. This bounded lease check exists only
    // for the one event no dead process can publish: its own disappearance.
    if (!done) {
      staleTimer = setInterval(refresh, staleCheckMs);
      void refresh();
    }
  });
}
