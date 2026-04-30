/**
 * Tests for the /health and /api/health endpoints in index.js.
 *
 * The launcher (SC2ReplayAnalyzer.py) and the Stage-4 diagnostics page
 * both poll /api/health for liveness + version, so the response shape
 * is a public contract. /health is the legacy verbose probe used by
 * pm2 / OBS browser sources.
 *
 * NODE_ENV=test gates the export of the constructed Express `app`,
 * so we drive supertest against the in-process app without ever
 * calling server.listen.
 */

'use strict';

const path = require('path');

// Boot index.js in test mode. Helpers + redirected paths must be set
// BEFORE the require so analyzer.js sees them at module load.
process.env.NODE_ENV = 'test';
process.env.SC2_META_DB_PATH = path.join(__dirname, '_helpers', '__nope__.json');
process.env.SC2_OPP_HISTORY_PATH = path.join(__dirname, '_helpers', '__nope__.json');

const request = require('supertest');
const indexExports = require('../index');

describe('GET /health (legacy verbose probe)', () => {
  test('200 with ok:true and a numeric uptime', async () => {
    const res = await request(indexExports.app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.uptimeSec).toBe('number');
    expect(res.body.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  test('returns the session snapshot field', async () => {
    const res = await request(indexExports.app).get('/health');
    expect(res.body).toHaveProperty('session');
  });

  test('returns historyPath + metaDbPath as strings', async () => {
    const res = await request(indexExports.app).get('/health');
    expect(typeof res.body.historyPath).toBe('string');
    expect(typeof res.body.metaDbPath).toBe('string');
  });
});

describe('GET /api/health (schema-stable probe)', () => {
  test('200 with the canonical {ok, version, uptime_sec} envelope', async () => {
    const res = await request(indexExports.app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.version).toBe('string');
    expect(typeof res.body.uptime_sec).toBe('number');
    // Snake-case is the contract the python launcher relies on.
    expect(res.body).not.toHaveProperty('uptimeSec');
    // No PII or extra noise leaking through.
    expect(Object.keys(res.body).sort()).toEqual(
      ['ok', 'uptime_sec', 'version'].sort()
    );
  });

  test('uptime_sec advances monotonically across calls', async () => {
    const a = await request(indexExports.app).get('/api/health');
    await new Promise((r) => setTimeout(r, 1100));
    const b = await request(indexExports.app).get('/api/health');
    expect(b.body.uptime_sec).toBeGreaterThanOrEqual(a.body.uptime_sec);
  });
});
