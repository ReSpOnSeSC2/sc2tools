/**
 * Tests for the Stage 7.4 custom-builds router + sync service.
 *
 * No real network calls. The community-builds service is replaced
 * by a fake fetch that records requests and returns canned responses.
 * Every test runs in a tmp dataDir so they cannot pollute the
 * live install.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

const { createCustomBuildsRouter } = require('../routes/custom-builds');
const H = require('../routes/custom_builds_helpers');
const { createCommunitySyncService, __test__: SYNC_T } = require('../services/community_sync');

const SCHEMA_SRC = path.join(__dirname, '..', '..', 'data', 'custom_builds.schema.json');

/**
 * Spin up a fresh dataDir + Express app for one test.
 *
 * @returns {{app, dataDir, syncCalls, sync, fakeFetch, fetchResponses}}
 */
function buildHarness() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-'));
  fs.copyFileSync(SCHEMA_SRC, path.join(dataDir, 'custom_builds.schema.json'));
  fs.writeFileSync(
    path.join(dataDir, 'profile.json'),
    JSON.stringify({ display_name: 'TesterBT' })
  );
  const fetchResponses = [];
  const fetchCalls = [];
  const fakeFetch = (url, init) => {
    fetchCalls.push({ url, method: init && init.method, body: init && init.body, headers: init && init.headers });
    const next = fetchResponses.shift();
    if (!next) {
      return Promise.resolve({ ok: false, status: 599, json: async () => ({ error: 'no_canned_response' }) });
    }
    return Promise.resolve(next);
  };
  const sync = createCommunitySyncService({
    dataDir,
    baseUrl: 'http://test-community.local',
    fetchImpl: fakeFetch,
    intervalMs: 1000 * 60 * 60 * 24, // never fires during a test
  });
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(
    '/api/custom-builds',
    createCustomBuildsRouter({ dataDir, sync, getIo: () => ({ emit: () => undefined }) })
  );
  return { app, dataDir, sync, fetchResponses, fetchCalls, fakeFetch };
}

/**
 * Minimal valid v3 build body. Stage 7.5b replaced the weighted
 * `signature` model with rule-based matching: each rule is boolean,
 * all-must-pass.
 *
 * @returns {object}
 */
function validBody(overrides) {
  return {
    name: 'PvZ Test Build',
    race: 'Protoss',
    vs_race: 'Zerg',
    rules: [
      { type: 'before', name: 'BuildStargate', time_lt: 110 },
    ],
    ...(overrides || {}),
  };
}

describe('custom-builds router: schema validation', () => {
  test('POST rejects unknown race with structured error', async () => {
    const { app } = buildHarness();
    const res = await request(app).post('/api/custom-builds').send(validBody({ race: 'Snek' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details[0].keyword).toBe('enum');
  });

  test('POST rejects empty rules array', async () => {
    const { app } = buildHarness();
    const res = await request(app).post('/api/custom-builds').send(validBody({ rules: [] }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
  });

  test('POST rejects out-of-range time_lt', async () => {
    const { app } = buildHarness();
    const res = await request(app).post('/api/custom-builds').send(
      validBody({ rules: [{ type: 'before', name: 'BuildStargate', time_lt: 99999 }] })
    );
    expect(res.status).toBe(400);
  });
});

describe('custom-builds router: CRUD round-trip', () => {
  test('POST creates with default author from profile.json', async () => {
    const { app, dataDir } = buildHarness();
    const res = await request(app).post('/api/custom-builds').send(validBody());
    expect(res.status).toBe(201);
    expect(res.body.author).toBe('TesterBT');
    expect(res.body.sync_state).toBe('pending');
    expect(res.body.id).toBe('pvz-test-build');
    // Verify atomic write left no .tmp file behind.
    const stragglers = fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp'));
    expect(stragglers).toEqual([]);
  });

  test('GET / returns merged list with counts', async () => {
    const { app } = buildHarness();
    await request(app).post('/api/custom-builds').send(validBody());
    const res = await request(app).get('/api/custom-builds');
    expect(res.status).toBe(200);
    expect(res.body.builds.length).toBe(1);
    expect(res.body.counts).toEqual({ custom: 1, community_cache: 0, total: 1 });
  });

  test('GET /:id returns the build', async () => {
    const { app } = buildHarness();
    const create = await request(app).post('/api/custom-builds').send(validBody());
    const res = await request(app).get('/api/custom-builds/' + create.body.id);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('PvZ Test Build');
  });

  test('POST 409 on duplicate id', async () => {
    const { app } = buildHarness();
    await request(app).post('/api/custom-builds').send(validBody({ id: 'pvz-fixed' }));
    const dup = await request(app).post('/api/custom-builds').send(validBody({ id: 'pvz-fixed', name: 'Other' }));
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('build_exists');
  });

  test('PUT replaces and bumps updated_at', async () => {
    const { app } = buildHarness();
    const create = await request(app).post('/api/custom-builds').send(validBody());
    const orig = create.body.updated_at;
    await new Promise((r) => setTimeout(r, 1100));
    const res = await request(app)
      .put('/api/custom-builds/' + create.body.id)
      .send(validBody({ name: 'Renamed Build', skill_level: 'master' }));
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed Build');
    expect(res.body.skill_level).toBe('master');
    expect(res.body.updated_at > orig).toBe(true);
  });

  test('PATCH applies whitelisted fields, flips sync_state', async () => {
    const { app } = buildHarness();
    const create = await request(app).post('/api/custom-builds').send(validBody());
    const res = await request(app).patch('/api/custom-builds/' + create.body.id).send({ skill_level: 'gold', forbidden: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.skill_level).toBe('gold');
    expect(res.body.forbidden).toBeUndefined();
    expect(res.body.sync_state).toBe('pending');
  });

  test('DELETE removes the build and queues a community DELETE', async () => {
    const { app, sync } = buildHarness();
    const create = await request(app).post('/api/custom-builds').send(validBody());
    const del = await request(app).delete('/api/custom-builds/' + create.body.id);
    expect(del.status).toBe(204);
    const get = await request(app).get('/api/custom-builds/' + create.body.id);
    expect(get.status).toBe(404);
    const queue = sync.readQueue();
    expect(queue.entries.find((e) => e.kind === 'delete' && e.id === create.body.id)).toBeTruthy();
  });
});

describe('custom-builds router: dedup with community cache', () => {
  test('custom build wins over community cache on id collision', async () => {
    const { app, dataDir } = buildHarness();
    const sampleRule = [{ type: 'before', name: 'BuildPylon', time_lt: 30 }];
    fs.writeFileSync(
      path.join(dataDir, 'community_builds.cache.json'),
      JSON.stringify({
        version: 3,
        builds: [
          {
            id: 'pvz-test-build', name: 'Community Version', race: 'Protoss',
            vs_race: 'Zerg', rules: sampleRule, skill_level: 'silver',
          },
          {
            id: 'community-only', name: 'Solo', race: 'Zerg',
            vs_race: 'Terran', rules: sampleRule,
          },
        ],
      })
    );
    await request(app).post('/api/custom-builds').send(validBody());
    const res = await request(app).get('/api/custom-builds');
    expect(res.body.counts).toEqual({ custom: 1, community_cache: 2, total: 2 });
    const pvz = res.body.builds.find((b) => b.id === 'pvz-test-build');
    expect(pvz.source).toBe('custom');
    expect(pvz.name).toBe('PvZ Test Build');
    const solo = res.body.builds.find((b) => b.id === 'community-only');
    expect(solo.source).toBe('community');
  });
});

describe('custom-builds router: derive draft from a real game', () => {
  test('POST /from-game returns a v3 draft with empty rules and full event count', async () => {
    const { app } = buildHarness();
    const events = [
      { t: 18, what: 'BuildPylon' },
      { t: 30, what: 'BuildGateway' },
      { t: 30, what: 'BuildGateway' },
      { t: 95, what: 'BuildStargate' },
      { t: 200, what: 'GameEvent' },
    ];
    const res = await request(app).post('/api/custom-builds/from-game').send({ events, name: 'X' });
    expect(res.status).toBe(200);
    expect(res.body.event_count).toBe(5);
    // Stage 7.5b: pickRulesFromEvents intentionally returns []. The
    // editor opens with 0 rules and the user clicks [+] to add them.
    expect(Array.isArray(res.body.draft.rules)).toBe(true);
    expect(res.body.draft.rules).toEqual([]);
    expect(res.body.draft.name).toBe('X');
  });

  test('POST /from-game errors when no events resolve', async () => {
    const { app } = buildHarness();
    const res = await request(app).post('/api/custom-builds/from-game').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no_events_resolved');
  });
});

describe('custom-builds router: preview-matches against meta DB', () => {
  test('POST /preview-matches returns matching games', async () => {
    const { app, dataDir } = buildHarness();
    fs.writeFileSync(
      path.join(dataDir, 'meta_database.json'),
      JSON.stringify({
        'Existing Build': {
          games: [
            {
              game_id: 'g-1',
              events: [
                { t: 90, what: 'BuildStargate' },
                { t: 17, what: 'BuildPylon' },
              ],
            },
            {
              game_id: 'g-2',
              events: [{ t: 200, what: 'BuildGateway' }],
            },
          ],
        },
      })
    );
    const candidate = {
      rules: [{ type: 'before', name: 'BuildStargate', time_lt: 110 }],
    };
    const res = await request(app).post('/api/custom-builds/preview-matches').send(candidate);
    expect(res.status).toBe(200);
    expect(res.body.scanned_games).toBe(2);
    expect(res.body.matches.length).toBe(1);
    expect(res.body.matches[0].game_id).toBe('g-1');
  });

  test('POST /preview-matches errors on missing rules', async () => {
    const { app } = buildHarness();
    const res = await request(app).post('/api/custom-builds/preview-matches').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_rules');
  });
});

describe('community_sync service: queue mutation under stubbed fetch', () => {
  test('queueUpsert + syncNow drains the queue and flips sync_state', async () => {
    const { app, sync, fetchResponses, dataDir } = buildHarness();
    // Canned: handshake -> POST -> sync diff (empty)
    fetchResponses.push(
      { ok: true, status: 200, json: async () => ({ pepperHex: 'ab'.repeat(32), service: 'community-builds', version: '1.0' }) },
      { ok: true, status: 201, json: async () => ({ id: 'pvz-test-build', version: 1, updatedAt: 1714280000000 }) },
      { ok: true, status: 200, json: async () => ({ upserts: [], deletes: [], serverNow: 1714280000000 }) }
    );
    await request(app).post('/api/custom-builds').send(validBody());
    expect(sync.readQueue().entries.length).toBe(1);
    const r = await request(app).post('/api/custom-builds/sync').send();
    expect(r.status).toBe(200);
    expect(r.body.pending_count).toBe(0);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'custom_builds.json'), 'utf8'));
    expect(onDisk.builds[0].sync_state).toBe('synced');
    expect(onDisk.builds[0].remote_version).toBe(1);
  });

  test('failed POST stays in queue with backoff', async () => {
    const { app, sync, fetchResponses } = buildHarness();
    fetchResponses.push(
      { ok: true, status: 200, json: async () => ({ pepperHex: 'cd'.repeat(32) }) },
      { ok: false, status: 500, json: async () => ({ error: 'server' }) },
      { ok: true, status: 200, json: async () => ({ upserts: [], deletes: [], serverNow: 1 }) }
    );
    await request(app).post('/api/custom-builds').send(validBody());
    await sync.syncNow();
    const q = sync.readQueue();
    expect(q.entries.length).toBe(1);
    expect(q.entries[0].attempts).toBe(1);
    expect(q.entries[0].next_attempt_at).toBeGreaterThan(Date.now());
  });

  test('pull merges remote upserts into the cache', async () => {
    const { sync, fetchResponses, dataDir } = buildHarness();
    fetchResponses.push(
      { ok: true, status: 200, json: async () => ({ pepperHex: '11'.repeat(32) }) },
      {
        ok: true, status: 200,
        json: async () => ({
          upserts: [{
            id: 'pulled-build', name: 'Pulled', race: 'Zerg', vsRace: 'Protoss',
            skillLevel: 'master',
            rules: [{ type: 'before', name: 'BuildSpawningPool', time_lt: 80 }],
            version: 3,
            createdAt: 1700000000000, updatedAt: 1714000000000,
            authorClientId: 'aa', authorDisplay: 'pro',
          }],
          deletes: [], serverNow: 1714000000000,
        }),
      }
    );
    await sync.syncNow();
    const cache = JSON.parse(fs.readFileSync(path.join(dataDir, 'community_builds.cache.json'), 'utf8'));
    expect(cache.builds.length).toBe(1);
    expect(cache.builds[0].id).toBe('pulled-build');
    expect(cache.builds[0].vs_race).toBe('Protoss');
    expect(cache.builds[0].sync_state).toBe('synced');
  });

  test('GET /sync/status reports pending count and base url', async () => {
    const { app, sync } = buildHarness();
    await request(app).post('/api/custom-builds').send(validBody());
    const res = await request(app).get('/api/custom-builds/sync/status');
    expect(res.status).toBe(200);
    expect(res.body.pending_count).toBe(1);
    expect(res.body.base_url).toBe('http://test-community.local');
    expect(typeof res.body.client_id).toBe('string');
    expect(res.body.client_id.length).toBeGreaterThanOrEqual(32);
  });
});

describe('community_sync service: vote forwarding', () => {
  test('POST /:id/vote enqueues +1 by default', async () => {
    const { app, sync } = buildHarness();
    await request(app).post('/api/custom-builds').send(validBody());
    const res = await request(app).post('/api/custom-builds/pvz-test-build/vote').send({});
    expect(res.status).toBe(200);
    expect(res.body.vote).toBe(1);
    const queue = sync.readQueue();
    expect(queue.entries.find((e) => e.kind === 'vote' && e.vote === 1)).toBeTruthy();
  });

  test('POST /:id/vote with body {vote: -1} enqueues -1', async () => {
    const { app, sync } = buildHarness();
    await request(app).post('/api/custom-builds').send(validBody());
    const res = await request(app).post('/api/custom-builds/pvz-test-build/vote').send({ vote: -1 });
    expect(res.body.vote).toBe(-1);
    const queue = sync.readQueue();
    expect(queue.entries.find((e) => e.kind === 'vote' && e.vote === -1)).toBeTruthy();
  });
});

describe('helpers', () => {
  test('parseLogLine handles MM:SS prefixes with verb', () => {
    expect(H.parseLogLine('01:35 Build Stargate')).toEqual({ t: 95, what: 'BuildStargate' });
    expect(H.parseLogLine('00:18 Pylon')).toEqual({ t: 18, what: 'BuildPylon' });
    expect(H.parseLogLine('garbage')).toBeNull();
  });

  test('evaluateRule (before): matches when event occurs in window, fails outside', () => {
    // Stage 7.5b: scoreSignature was retired with the v2 weighted-score
    // model. v3 uses boolean per-rule evaluateRule / evaluateRules.
    const rule = { type: 'before', name: 'BuildStargate', time_lt: 100 };
    expect(H.evaluateRule([{ t: 90, what: 'BuildStargate' }], rule).ok).toBe(true);
    expect(H.evaluateRule([{ t: 200, what: 'BuildStargate' }], rule).ok).toBe(false);
  });

  test('uniqueIdFor appends -2 on collision', () => {
    expect(H.uniqueIdFor('My Build', new Set())).toBe('my-build');
    expect(H.uniqueIdFor('My Build', new Set(['my-build']))).toBe('my-build-2');
  });

  test('toRemote/fromRemote round-trip preserves rules', () => {
    const local = {
      id: 'x', name: 'X', race: 'Protoss', vs_race: 'Zerg', skill_level: 'gold',
      description: 'd', win_conditions: [], loses_to: [], transitions_into: [],
      rules: [{ type: 'before', name: 'BuildPylon', time_lt: 30 }],
      created_at: '2026-04-29T00:00:00Z', updated_at: '2026-04-29T00:00:00Z',
      author: 'me', sync_state: 'pending',
    };
    const remote = SYNC_T.toRemote(local, 'aabb');
    expect(remote.vsRace).toBe('Zerg');
    expect(remote.skillLevel).toBe('gold');
    const back = SYNC_T.fromRemote({ ...remote, version: 1, createdAt: 1714000000000, updatedAt: 1714000000000 });
    expect(back.vs_race).toBe('Zerg');
    expect(back.rules[0].name).toBe('BuildPylon');
    expect(back.rules[0].type).toBe('before');
    expect(back.sync_state).toBe('synced');
  });

  test('signBody produces a stable HMAC-SHA256 hex digest', () => {
    const pepper = '00'.repeat(32);
    const sig = SYNC_T.signBody(pepper, '{"id":"abc"}');
    expect(typeof sig).toBe('string');
    expect(sig.length).toBe(64);
    const sig2 = SYNC_T.signBody(pepper, '{"id":"abc"}');
    expect(sig).toBe(sig2); // deterministic
  });
});
