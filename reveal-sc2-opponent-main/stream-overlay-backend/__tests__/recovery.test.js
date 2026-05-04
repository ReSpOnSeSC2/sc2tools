// @ts-check
'use strict';

/**
 * Stage 5 -- routes/recovery.js + lib/integrity_sweep.js end-to-end.
 *
 * Exercises:
 *   * GET /api/recovery on a clean fixture: all five tracked files OK,
 *     no orphans, no candidates.
 *   * GET /api/recovery on a degraded fixture (live=5 keys, orphan
 *     aged 10 min ago with 200 keys) stages a candidate.
 *   * POST /api/recovery/apply promotes the staged candidate.
 *   * Path-traversal: applying a candidate outside data/.recovery/
 *     returns 403 and does NOT touch any file.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');

const { createRecoveryRouter } = require('../routes/recovery');
const { runSweep } = require('../lib/integrity_sweep');

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sc2-recovery-'));
}
function rmTmp(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* */ }
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
}
function makeApp(dataDir) {
  const app = express();
  app.use(createRecoveryRouter({ dataDir }));
  return app;
}

describe('GET /api/recovery', () => {
  test('clean fixture reports all OK', async () => {
    const tmp = makeTmp();
    try {
      writeJson(path.join(tmp, 'MyOpponentHistory.json'), Object.fromEntries(
        Array.from({ length: 150 }).map((_, i) => [String(i), i]),
      ));
      writeJson(path.join(tmp, 'meta_database.json'), Object.fromEntries(
        Array.from({ length: 60 }).map((_, i) => [String(i), i]),
      ));
      writeJson(path.join(tmp, 'custom_builds.json'), { builds: [] });
      writeJson(path.join(tmp, 'profile.json'), { display_name: 'me' });
      writeJson(path.join(tmp, 'config.json'), { a: 1, b: 2, c: 3, d: 4, e: 5 });
      const app = makeApp(tmp);
      const res = await request(app).get('/api/recovery');
      expect(res.status).toBe(200);
      expect(res.body.findings.every((f) => f.status === 'ok')).toBe(true);
      expect(res.body.orphans_aged).toEqual([]);
    } finally { rmTmp(tmp); }
  });

  test('degraded fixture stages a candidate', async () => {
    const tmp = makeTmp();
    try {
      // Live MyOpponentHistory.json with 5 keys (under floor 100).
      writeJson(path.join(tmp, 'MyOpponentHistory.json'), { a: 1, b: 2, c: 3, d: 4, e: 5 });
      // Aged orphan with 200 keys.
      const orphan = path.join(tmp, '.tmp_aged.json');
      writeJson(orphan, Object.fromEntries(
        Array.from({ length: 200 }).map((_, i) => [String(i), i]),
      ));
      const oldT = (Date.now() / 1000) - 600;
      fs.utimesSync(orphan, oldT, oldT);

      const app = makeApp(tmp);
      const res = await request(app).get('/api/recovery');
      expect(res.status).toBe(200);
      const mh = res.body.findings.find((f) => f.basename === 'MyOpponentHistory.json');
      expect(mh.status).toBe('corrupt_small');
      expect(mh.candidate_path).toBeTruthy();
      expect(mh.candidate_source).toBe('orphan');
      expect(mh.candidate_keys).toBe(200);
    } finally { rmTmp(tmp); }
  });
});

describe('POST /api/recovery/apply', () => {
  test('promotes candidate to live target', async () => {
    const tmp = makeTmp();
    try {
      const live = path.join(tmp, 'MyOpponentHistory.json');
      writeJson(live, { a: 1, b: 2 });
      // Stage a candidate via the JS sweep (so we exercise the same
      // code path the SPA would).
      const orphan = path.join(tmp, '.tmp_aged.json');
      writeJson(orphan, Object.fromEntries(
        Array.from({ length: 150 }).map((_, i) => [String(i), i]),
      ));
      const oldT = (Date.now() / 1000) - 600;
      fs.utimesSync(orphan, oldT, oldT);
      const report = runSweep(tmp);
      const candidate = report.candidates_staged[0];
      expect(candidate).toBeTruthy();

      const app = makeApp(tmp);
      const res = await request(app).post('/api/recovery/apply').send({
        candidate_path: candidate,
      });
      expect(res.status).toBe(200);
      expect(res.body.applied.to).toBe('MyOpponentHistory.json');
      const back = JSON.parse(fs.readFileSync(live, 'utf8'));
      expect(Object.keys(back).length).toBe(150);
      // .bak preserved the previous 2-key live.
      const bak = JSON.parse(fs.readFileSync(live + '.bak', 'utf8'));
      expect(bak).toEqual({ a: 1, b: 2 });
    } finally { rmTmp(tmp); }
  });

  test('refuses path traversal', async () => {
    const tmp = makeTmp();
    try {
      writeJson(path.join(tmp, 'MyOpponentHistory.json'), { a: 1 });
      const app = makeApp(tmp);
      const res = await request(app).post('/api/recovery/apply').send({
        candidate_path: '../../../etc/passwd',
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('invalid_path');
    } finally { rmTmp(tmp); }
  });

  test('refuses missing candidate_path', async () => {
    const tmp = makeTmp();
    try {
      const app = makeApp(tmp);
      const res = await request(app).post('/api/recovery/apply').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('missing_candidate_path');
    } finally { rmTmp(tmp); }
  });
});
