/**
 * Tests for the version contract exposed via /api/health.
 *
 * Stage 11.3 originally specified a separate /api/version endpoint,
 * but the audit showed the launcher already polls /api/health and
 * reads its `version` field. To avoid introducing a parallel public
 * surface, version.test.js pins THAT contract instead: the value
 * MUST equal package.json#version, MUST be a non-empty semver-like
 * string, and MUST NOT vary across calls within a single boot.
 */

'use strict';

const path = require('path');

process.env.NODE_ENV = 'test';
process.env.SC2_META_DB_PATH = path.join(__dirname, '_helpers', '__nope__.json');
process.env.SC2_OPP_HISTORY_PATH = path.join(__dirname, '_helpers', '__nope__.json');

const request = require('supertest');
const pkg = require('../package.json');
const indexExports = require('../index');

describe('/api/health version field', () => {
  test('matches package.json#version exactly', async () => {
    const res = await request(indexExports.app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(pkg.version);
  });

  test('is a non-empty string', async () => {
    const res = await request(indexExports.app).get('/api/health');
    expect(typeof res.body.version).toBe('string');
    expect(res.body.version.length).toBeGreaterThan(0);
  });

  test('is stable across calls within a single process', async () => {
    const a = await request(indexExports.app).get('/api/health');
    const b = await request(indexExports.app).get('/api/health');
    const c = await request(indexExports.app).get('/api/health');
    expect(a.body.version).toBe(b.body.version);
    expect(b.body.version).toBe(c.body.version);
  });
});
