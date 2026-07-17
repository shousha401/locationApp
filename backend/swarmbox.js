// Swarmbox PostgREST client — lifted from valueTool (backend/swarmbox.js).
//
// Same battle-tested pattern: no-auth fetch, AbortController per-request timeout,
// rolling-worker concurrency, a process-wide concurrency guardrail, retries with
// backoff, and a circuit breaker. Routes never throw — they get { ok, data } and
// decide whether to surface the failure or return a graceful empty.
//
// This app makes ONE big call (the full-inventory snapshot, ~250k rows), so the
// timeout defaults are set generous via .env (SWARMBOX_TIMEOUT_MS).

const SWARMBOX_BASE_URL = process.env.SWARMBOX_BASE_URL || 'https://jdfood.swarmbox.com:443/pg-api';
const FETCH_TIMEOUT_MS = Number(process.env.SWARMBOX_TIMEOUT_MS) || 120000;
const CONCURRENCY = Number(process.env.SWARMBOX_CONCURRENCY) || 2;

// ── Failure classification ───────────────────────────────────────────────────
//   timeout   — ran out of time (may be too heavy to serve).
//   transient — Swarmbox unhealthy (5xx, 429, reset). Retry the SAME request.
//   permanent — 4xx. Malformed or absent; give up.
const isTimeout = (res) =>
  (res.status === 0 && /abort/i.test(res.text || ''))
  || res.status === 504 || res.status === 408
  || /statement timeout|canceling statement|query timeout/i.test(res.text || '');
const isTransient = (res) =>
  res.status === 0 || res.status === 429 || (res.status >= 500 && res.status <= 599);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry a Swarmbox call on transient failure with exponential backoff + jitter.
async function withRetry(fn, { attempts = 3, baseMs = 500, label = '', retryOn = isTransient } = {}) {
  let res = await fn();
  for (let i = 1; i < attempts && !res.ok && retryOn(res) && !breakerOpen(); i++) {
    const wait = Math.round(baseMs * 2 ** (i - 1) * (0.75 + Math.random() * 0.5));
    console.warn(`[Swarmbox] ${label || 'call'} failed (${res.status || 'err'}) — retry ${i}/${attempts - 1} in ${wait}ms`);
    await sleep(wait);
    res = await fn();
  }
  return res;
}

// ── Circuit breaker ──────────────────────────────────────────────────────────
const BREAKER_FAILS = Number(process.env.SWARMBOX_BREAKER_FAILS) || 40;
const BREAKER_COOLDOWN_MS = Number(process.env.SWARMBOX_BREAKER_COOLDOWN_MS) || 60000;
const BREAKER_ENABLED = process.env.SWARMBOX_BREAKER !== 'off';
let consecutiveFails = 0;
let breakerUntil = 0;

function breakerOpen() {
  return BREAKER_ENABLED && Date.now() < breakerUntil;
}
function noteResult(ok) {
  if (!BREAKER_ENABLED) return;
  if (ok) { consecutiveFails = 0; return; }
  if (++consecutiveFails >= BREAKER_FAILS && !breakerOpen()) {
    breakerUntil = Date.now() + BREAKER_COOLDOWN_MS;
    consecutiveFails = 0;
    console.error(`[Swarmbox] CIRCUIT OPEN — ${BREAKER_FAILS} consecutive failures; pausing all calls for ${BREAKER_COOLDOWN_MS}ms`);
  }
}
const BREAKER_RESULT = { ok: false, status: 0, text: 'circuit open (Swarmbox failing — calls paused)' };

// Some product codes arrive short ("18", "601") and Swarmbox stores them
// 6-digit zero-padded. Normalize before every call.
function normalizeItemCode(code) {
  return String(code ?? '').trim().padStart(6, '0');
}

// Rolling worker pool — keeps at most `limit` calls in flight at once.
async function mapWithConcurrency(list, limit, worker) {
  const out = new Array(list.length);
  let cursor = 0;
  const runner = async () => {
    while (cursor < list.length) {
      const i = cursor++;
      out[i] = await worker(list[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, runner));
  return out;
}

// Process-wide semaphore, foreground vs background lanes (foreground always
// keeps at least one slot).
const RESERVED = Math.min(
  Number(process.env.SWARMBOX_RESERVED_SLOTS) || 1,
  Math.max(1, CONCURRENCY - 1),
);
const BG_LIMIT = Math.max(1, CONCURRENCY - RESERVED);

let inFlight = 0;
let bgInFlight = 0;
const fgWaiters = [];
const bgWaiters = [];

const canRun = (bg) => inFlight < CONCURRENCY && (!bg || bgInFlight < BG_LIMIT);

function take(bg) {
  inFlight++;
  if (bg) bgInFlight++;
}

function acquireSlot(bg) {
  if (canRun(bg)) { take(bg); return Promise.resolve(); }
  return new Promise((resolve) => (bg ? bgWaiters : fgWaiters).push(resolve));
}

function pump() {
  while (fgWaiters.length && canRun(false)) { take(false); fgWaiters.shift()(); }
  while (bgWaiters.length && canRun(true)) { take(true); bgWaiters.shift()(); }
}

function releaseSlot(bg) {
  inFlight--;
  if (bg) bgInFlight--;
  pump();
}

// One POST attempt. Never throws — returns { ok, status, data?, text? }.
async function postOnce(rpcName, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${SWARMBOX_BASE_URL}/rpc/${rpcName}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { ok: false, status: response.status, text };
    }
    const data = await response.json();
    return { ok: true, status: response.status, data: Array.isArray(data) ? data : [] };
  } catch (err) {
    return { ok: false, status: 0, text: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

async function postRpc(rpcName, body, { background = false } = {}) {
  if (breakerOpen()) return BREAKER_RESULT;
  await acquireSlot(background);
  try {
    const result = await postOnce(rpcName, body);
    noteResult(result.ok);
    return result;
  } finally {
    releaseSlot(background);
  }
}

// GET a PostgREST table/view or RPC (e.g. "rpc/inventory_detail?p_item=%25&...").
// Same no-auth, timeout + concurrency guardrail. Never throws.
async function getRows(pathAndQuery, { background = false } = {}) {
  if (breakerOpen()) return BREAKER_RESULT;
  await acquireSlot(background);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${SWARMBOX_BASE_URL}/${pathAndQuery}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      noteResult(false);
      return { ok: false, status: response.status, text };
    }
    const data = await response.json();
    noteResult(true);
    return { ok: true, status: response.status, data: Array.isArray(data) ? data : [] };
  } catch (err) {
    noteResult(false);
    return { ok: false, status: 0, text: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
    releaseSlot(background);
  }
}

module.exports = {
  postRpc, getRows, normalizeItemCode, mapWithConcurrency,
  withRetry, isTimeout, isTransient, breakerOpen,
};
