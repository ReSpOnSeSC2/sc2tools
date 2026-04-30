/**
 * Tests for the /games/:id/* endpoints in analyzer.js (Stage 11.3).
 *
 * SCOPE NOTE: this file covers /games/:gameId/build-order ONLY. The
 * sibling endpoints /games/:gameId/macro-breakdown,
 * /games/:gameId/opp-build-order, and /games/:gameId/apm-curve all
 * shell out to Python via inline spawn helpers (runMacroCli,
 * spawnBuildOrderCli) inside analyzer.js. Cleanly mocking those
 * requires extracting the helpers to a separate module, which is a
 * larger refactor tracked in docs/adr/0011-analyzer-spawn-di.md.
 *
 * The build-order endpoint is read-only -- it composes its response
 * from the in-memory meta_database -- so we can drive it with a tmp
 * fixture file pointed at via the SC2_META_DB_PATH env override that
 * the Stage 11.3 surgery added at the top of analyzer.js.
 *
 * No mocks: every assertion runs against real fs reads of a real
 * fixture meta_database.json shape.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');

const { makeTmpDir, rmTmpDir, makeApp, writeJsonFixture } = require('./_helpers');

const FIXTURE_GAME_ID = 'g-2026-04-30-001';
const FIXTURE_BUILD_NAME = 'PvT - Cannon Rush';
const FIXTURE_BUILD_LOG = ['[0:12] Probe', '[0:30] Pylon', '[1:00] Forge'];
const FIXTURE_OPP_BUILD_LOG = ['[0:18] SCV', '[0:42] Supply Depot'];

function buildFixtureMetaDb() {
  return {
    [FIXTURE_BUILD_NAME]: {
      games: [
        {
          id: FIXTURE_GAME_ID,
          opponent: 'OppName',
          opp_race: 'Terran',
          map: 'Goldenaura',
          result: 'win',
          date: '2026-04-30 12:00',
          game_length: 540,
          macro_score: 67,
          top_3_leaks: [
            { metric: 'idle_workers', cost: 12 },
            { metric: 'production_idle', cost: 8 },
            { metric: 'unspent_minerals', cost: 5 },
          ],
          build_log: FIXTURE_BUILD_LOG,
          opp_build_log: FIXTURE_OPP_BUILD_LOG,
        },
      ],
    },
  };
}

function loadAnalyzerWithFixture() {
  const dir = makeTmpDir('sc2-games-');
  const metaPath = path.join(dir, 'meta_database.json');
  const oppPath = path.join(dir, 'MyOpponentHistory.json');
  writeJsonFixture(dir, 'meta_database.json', buildFixtureMetaDb());
  writeJsonFixture(dir, 'MyOpponentHistory.json', {});
  // Wire env BEFORE require so analyzer.js picks up our paths at module load.
  process.env.SC2_META_DB_PATH = metaPath;
  process.env.SC2_OPP_HISTORY_PATH = oppPath;
  // Drop any cached require so a fresh module load resolves the new paths.
  delete require.cache[require.resolve('../analyzer')];
  // eslint-disable-next-line global-require
  const analyzer = require('../analyzer');
  const app = makeApp((a) => a.use(analyzer.router));
  return { app, dir };
}

describe('GET /games/:gameId/build-order', () => {
  let h;
  beforeAll(() => { h = loadAnalyzerWithFixture(); });
  afterAll(() => rmTmpDir(h.dir));

  test('200 with the canonical envelope for a known game id', async () => {
    const res = await request(h.app).get(`/games/${FIXTURE_GAME_ID}/build-order`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.game_id).toBe(FIXTURE_GAME_ID);
    expect(res.body.my_build).toBe(FIXTURE_BUILD_NAME);
    expect(res.body.opponent).toBe('OppName');
    expect(res.body.opp_race).toBe('Terran');
    expect(res.body.map).toBe('Goldenaura');
    expect(res.body.result).toBe('win');
  });

  test('parses MY build_log into structured events with t (sec) + what', async () => {
    const res = await request(h.app).get(`/games/${FIXTURE_GAME_ID}/build-order`);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(res.body.events.length).toBe(FIXTURE_BUILD_LOG.length);
    expect(res.body.events[0]).toMatchObject({ time: 12 });
    expect(res.body.events[1]).toMatchObject({ time: 30 });
    expect(res.body.events[2]).toMatchObject({ time: 60 });
  });

  test('parses OPPONENT opp_build_log when present', async () => {
    const res = await request(h.app).get(`/games/${FIXTURE_GAME_ID}/build-order`);
    expect(Array.isArray(res.body.opp_events)).toBe(true);
    expect(res.body.opp_events.length).toBe(FIXTURE_OPP_BUILD_LOG.length);
    expect(res.body.opp_build_available).toBe(true);
  });

  test('infers my_race from the matchup-prefixed build name', async () => {
    const res = await request(h.app).get(`/games/${FIXTURE_GAME_ID}/build-order`);
    expect(res.body.my_race).toBe('Protoss'); // PvT prefix -> Protoss
  });

  test('exposes macro_score and top_3_leaks from the meta_database record', async () => {
    const res = await request(h.app).get(`/games/${FIXTURE_GAME_ID}/build-order`);
    expect(res.body.macro_score).toBe(67);
    expect(res.body.top_3_leaks).toHaveLength(3);
    expect(res.body.top_3_leaks[0].metric).toBe('idle_workers');
  });

  test('early_events is the <=300s slice when no early_build_log is stored', async () => {
    const res = await request(h.app).get(`/games/${FIXTURE_GAME_ID}/build-order`);
    expect(Array.isArray(res.body.early_events)).toBe(true);
    // Fixture build_log has 3 events, all under 300s, so early == events.
    expect(res.body.early_events.length).toBe(res.body.events.length);
  });

  test('404 for an unknown game id', async () => {
    const res = await request(h.app).get('/games/totally-unknown-id/build-order');
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('game not found');
  });

  test('404 envelope is JSON, not HTML (contract for the SPA)', async () => {
    const res = await request(h.app).get('/games/xxx/build-order');
    expect(res.headers['content-type']).toMatch(/json/);
  });
});
