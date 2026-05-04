// @ts-check
/**
 * lib/data_integrity_metrics.js -- Stage 7 of STAGE_DATA_INTEGRITY_ROADMAP.
 *
 * Process-local counters + duration histograms for the JS-side
 * write hot paths (analyzer.js persistMetaDb, the routes/* atomic
 * writers). Mirrors core/data_integrity_metrics.py byte-for-byte
 * on counter names so the SPA can render a single dashboard widget
 * regardless of which writer fired the event.
 *
 * Why not Prometheus / OpenTelemetry: sc2tools is a single-user
 * desktop app; a 50MB scraper for one process is wrong-shaped.
 * The Stage 14 master-roadmap Sentry hook can later subscribe
 * to .error() events without changing this surface.
 */

'use strict';

const COUNTER_NAMES = Object.freeze([
  'write_attempted',
  'write_succeeded',
  'write_failed',
  'lock_acquired',
  'lock_contended',
  'lock_timeout',
  'validation_rejected',
  'salvage_triggered',
  'recovery_staged',
  'recovery_applied',
  'schema_too_new_rejection',
]);

const _state = {
  counters: {},      // counter -> basename -> int
  histograms: {},    // (name + ':' + basename) -> number[]
  errors: [],
  maxErrors: 100,
  histogramCap: 1000,
};

function _ensureCounter(name, basename) {
  if (!_state.counters[name]) _state.counters[name] = {};
  if (!_state.counters[name][basename]) _state.counters[name][basename] = 0;
}

/**
 * Increment a named counter. Unknown names are ignored after a
 * console warning (the lint rule below surfaces typos at PR time).
 *
 * @param {string} name
 * @param {{ basename?: string, n?: number }} [opts]
 */
function counterInc(name, opts) {
  if (!COUNTER_NAMES.includes(name)) {
    console.warn(`[metrics] unknown counter: ${name}`);
    return;
  }
  const basename = (opts && opts.basename) || '_global';
  const n = (opts && typeof opts.n === 'number') ? opts.n : 1;
  _ensureCounter(name, basename);
  _state.counters[name][basename] += n;
}

/**
 * Record a duration in ms. Values past the histogramCap are evicted
 * FIFO so a long-running process never grows unbounded memory.
 *
 * @param {string} name
 * @param {number} value
 * @param {{ basename?: string }} [opts]
 */
function histogramRecord(name, value, opts) {
  if (typeof value !== 'number' || !isFinite(value)) return;
  const basename = (opts && opts.basename) || '_global';
  const key = name + ':' + basename;
  if (!_state.histograms[key]) _state.histograms[key] = [];
  _state.histograms[key].push(value);
  if (_state.histograms[key].length > _state.histogramCap) {
    _state.histograms[key] = _state.histograms[key]
      .slice(-_state.histogramCap);
  }
}

/**
 * Record a structured error. Pinned in a ring buffer so the
 * diagnostics widget can render the most-recent N events.
 *
 * @param {string} kind
 * @param {{ detail?: object }} [opts]
 */
function error(kind, opts) {
  const record = {
    kind,
    detail: (opts && opts.detail) || {},
    timestamp: Date.now() / 1000,
  };
  _state.errors.push(record);
  if (_state.errors.length > _state.maxErrors) {
    _state.errors = _state.errors.slice(-_state.maxErrors);
  }
  console.error('[data_integrity error]', kind, record.detail);
}

function _summarize(vals) {
  if (!vals.length) return { count: 0 };
  const sorted = vals.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const pct = (p) => sorted[Math.max(0, Math.min(n - 1, Math.floor(p * (n - 1))))];
  return {
    count: n,
    p50: pct(0.50),
    p95: pct(0.95),
    p99: pct(0.99),
    min: sorted[0],
    max: sorted[n - 1],
  };
}

/**
 * @returns {{
 *   counters: object,
 *   histogram_summary: object,
 *   recent_errors: object[]
 * }}
 */
function snapshot() {
  const histSummary = {};
  for (const k of Object.keys(_state.histograms)) {
    histSummary[k] = _summarize(_state.histograms[k]);
  }
  return {
    counters: JSON.parse(JSON.stringify(_state.counters)),
    histogram_summary: histSummary,
    recent_errors: _state.errors.slice(),
  };
}

function _resetForTests() {
  _state.counters = {};
  _state.histograms = {};
  _state.errors = [];
}

module.exports = {
  COUNTER_NAMES,
  counterInc,
  histogramRecord,
  error,
  snapshot,
  _resetForTests,
};
