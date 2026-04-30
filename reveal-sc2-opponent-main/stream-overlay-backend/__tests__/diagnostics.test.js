/**
 * Tests for routes/diagnostics.js (Stage 4 + 11.3).
 *
 * The router runs 13 parallel checks; each check is wrapped in a
 * safeRun guard so exceptions become an ERR result card rather than a
 * 500. We test:
 *   - Factory contract: createDiagnosticsRouter throws when dataDir is
 *     missing or no fetch impl is available.
 *   - GET /api/diagnostics happy path returns the canonical envelope.
 *   - 30s in-memory cache: second call returns cached:true; ?refresh=1
 *     bypasses it.
 *   - GET /api/diagnostics/bundle: 200 streamed binary or graceful
 *     failure envelope. We do not unzip the stream here (that's a
 *     bundle_test.js concern) -- we just confirm the handler completes
 *     without raising.
 *   - safeRun: a check that throws still yields an ERR card.
 *
 * No real network (fetch is stubbed). No real Python (we set pythonCmd
 * to /bin/false on POSIX so any check that would shell out fails fast
 * and gracefully through safeRun).
 */

'use strict';

const request = require('supertest');

const {
  createDiagnosticsRouter, _internals,
} = require('../routes/diagnostics');
const {
  makeTmpDir, rmTmpDir, makeApp, writeJsonFixture, makeFakeFetch, jsonResponse,
} = require('./_helpers');

const VERSION_BODY_OK = { ok: true, status: 'up' };
const FAKE_PYTHON_CMD = process.platform === 'win32' ? 'cmd.exe' : '/bin/false';

function buildHarness({ pulseStatus } = {}) {
  const dataDir = makeTmpDir('sc2-diag-');
  // Seed minimal profile + config so checkProfileConfig has something
  // to read; the schema legality is exercised by profile/config tests.
  writeJsonFixture(dataDir, 'profile.json', { version: 1, battlenet: {
    battle_tag: 'X#1', character_id: '1-S2-1-1', account_id: '1', region: 'NA',
  } });
  writeJsonFixture(dataDir, 'config.json', { version: 1 });
  const ff = makeFakeFetch();
  ff.queue.push(jsonResponse({ status: pulseStatus || 200, body: VERSION_BODY_OK }));
  ff.queue.push(jsonResponse({ status: 200, body: VERSION_BODY_OK }));
  ff.queue.push(jsonResponse({ status: 200, body: VERSION_BODY_OK }));
  const router = createDiagnosticsRouter({
    dataDir,
    pythonCmd: FAKE_PYTHON_CMD,
    fetchImpl: ff.fetch,
    pulseBaseUrl: 'http://test.invalid/api',
    cacheTtlMs: 100,
  });
  const app = makeApp((a) => a.use(router));
  return { app, dataDir, fakeFetch: ff };
}

describe('createDiagnosticsRouter factory', () => {
  test('throws when dataDir is missing', () => {
    expect(() => createDiagnosticsRouter({})).toThrow(/dataDir/);
  });

  test('throws when no fetch impl is available', () => {
    const dataDir = makeTmpDir('sc2-diag-');
    try {
      const savedFetch = globalThis.fetch;
      globalThis.fetch = undefined;
      try {
        expect(() => createDiagnosticsRouter({ dataDir })).toThrow(/fetch/);
      } finally {
        globalThis.fetch = savedFetch;
      }
    } finally {
      rmTmpDir(dataDir);
    }
  });
});

describe('GET /api/diagnostics', () => {
  let h;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => rmTmpDir(h.dataDir));

  test('200 with checks array, generated_at, cached:false on first call', async () => {
    const res = await request(h.app).get('/api/diagnostics');
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(false);
    expect(typeof res.body.generated_at).toBe('string');
    expect(Array.isArray(res.body.checks)).toBe(true);
    // CHECK_RUNNERS has 13 entries; the response must mirror it 1:1.
    expect(res.body.checks).toHaveLength(_internals.CHECK_RUNNERS.length);
    for (const check of res.body.checks) {
      expect(typeof check.id).toBe('string');
      expect(['ok', 'warn', 'err', 'info', 'pending']).toContain(check.status);
    }
  });

  test('cached:true on the immediate second call', async () => {
    await request(h.app).get('/api/diagnostics');
    const res = await request(h.app).get('/api/diagnostics');
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
  });

  test('?refresh=1 bypasses the cache', async () => {
    await request(h.app).get('/api/diagnostics');
    const res = await request(h.app).get('/api/diagnostics?refresh=1');
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(false);
  });

  test('cache expires after cacheTtlMs', async () => {
    await request(h.app).get('/api/diagnostics');
    await new Promise((r) => setTimeout(r, 150)); // > cacheTtlMs (100)
    const res = await request(h.app).get('/api/diagnostics');
    expect(res.body.cached).toBe(false);
  });
});

describe('safeRun guard (unit)', () => {
  test('a throwing check becomes an ERR card, not an exception', async () => {
    const out = await _internals.safeRun('boom', () => {
      throw new Error('synthetic check failure');
    });
    expect(out.status).toBe('err');
    expect(out.id).toBe('boom');
    expect(out.detail.error).toMatch(/synthetic check failure/);
  });

  test('a passing check is returned unchanged', async () => {
    const card = { id: 'x', title: 'X', status: 'ok', summary: 'fine' };
    const out = await _internals.safeRun('x', async () => card);
    expect(out).toEqual(card);
  });
});

describe('runAllChecks (unit)', () => {
  test('returns one result per CHECK_RUNNERS entry, in order', async () => {
    const dataDir = makeTmpDir('sc2-diag-runall-');
    writeJsonFixture(dataDir, 'profile.json', { version: 1 });
    writeJsonFixture(dataDir, 'config.json', { version: 1 });
    try {
      const ff = makeFakeFetch();
      ff.queue.push(jsonResponse({ body: VERSION_BODY_OK }));
      ff.queue.push(jsonResponse({ body: VERSION_BODY_OK }));
      const cfg = _internals.buildConfig({
        dataDir, pythonCmd: FAKE_PYTHON_CMD, fetchImpl: ff.fetch,
        pulseBaseUrl: 'http://test.invalid', cacheTtlMs: 100,
      });
      const deps = _internals.buildCheckDeps(cfg);
      const results = await _internals.runAllChecks(deps);
      expect(results).toHaveLength(_internals.CHECK_RUNNERS.length);
      // No throws bubbled up.
      for (const r of results) expect(typeof r.status).toBe('string');
    } finally {
      rmTmpDir(dataDir);
    }
  });
});

describe('GET /api/diagnostics/bundle', () => {
  let h;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => rmTmpDir(h.dataDir));

  test('responds without raising and either streams a body or returns a structured error', async () => {
    const res = await request(h.app).get('/api/diagnostics/bundle');
    // bundle streaming may legitimately fail in CI if archiver
    // hits a redacted/missing source file -- both are acceptable as
    // long as the handler does NOT crash the process.
    expect([200, 500]).toContain(res.status);
    if (res.status === 500) {
      expect(res.body.error).toBe('bundle_failed');
    }
  });
});
