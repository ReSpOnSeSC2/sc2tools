/**
 * Focused tests for the /api/profile spec mounted by routes/settings.js.
 *
 * Stage 11.3 calls for a profile-specific test file that goes deeper
 * than the broader settings.test.js suite. We exercise:
 *   - Schema enforcement on every battlenet field (battle_tag, ids,
 *     region) plus the additionalProperties:false gate at the top level.
 *   - Real ajv error shapes returned by POST /api/profile/validate.
 *   - PUT round-trip + PATCH partial-merge against a tmp data dir.
 *   - 404 / 400 failure paths the launcher relies on.
 *
 * No mocks for fs or ajv: every assertion runs against a fresh tmp
 * dataDir seeded with the real profile.schema.json.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');

const { createSettingsRouter } = require('../routes/settings');
const {
  makeTmpDir, rmTmpDir, seedSchemas, makeApp, writeJsonFixture,
} = require('./_helpers');

const SCHEMAS = ['profile.schema.json', 'config.schema.json'];

function validProfile() {
  return {
    version: 1,
    battlenet: {
      battle_tag: 'Tester#1234',
      character_id: '1-S2-1-267727',
      account_id: '50983875',
      region: 'us',
    },
  };
}

function buildHarness() {
  const dataDir = makeTmpDir('sc2-profile-');
  seedSchemas(dataDir, SCHEMAS);
  const app = makeApp((a) => a.use(createSettingsRouter({ dataDir })));
  return { app, dataDir };
}

describe('GET /api/profile/exists', () => {
  let h;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => rmTmpDir(h.dataDir));

  test('false when profile.json missing', async () => {
    const res = await request(h.app).get('/api/profile/exists');
    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(false);
  });

  test('true after PUT round-trip', async () => {
    const put = await request(h.app).put('/api/profile').send(validProfile());
    expect(put.status).toBe(200);
    const res = await request(h.app).get('/api/profile/exists');
    expect(res.body.exists).toBe(true);
  });
});

describe('GET /api/profile', () => {
  let h;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => rmTmpDir(h.dataDir));

  test('404 when profile.json missing', async () => {
    const res = await request(h.app).get('/api/profile');
    expect(res.status).toBe(404);
  });

  test('200 with body once seeded; envelope is {profile: {...}}', async () => {
    writeJsonFixture(h.dataDir, 'profile.json', validProfile());
    const res = await request(h.app).get('/api/profile');
    expect(res.status).toBe(200);
    expect(res.body.profile.battlenet.battle_tag).toBe('Tester#1234');
  });
});

describe('PUT /api/profile schema enforcement', () => {
  let h;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => rmTmpDir(h.dataDir));

  test('rejects malformed battle_tag (no #)', async () => {
    const bad = validProfile();
    bad.battlenet.battle_tag = 'NoHashAtAll';
    const res = await request(h.app).put('/api/profile').send(bad);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  test('rejects bad character_id pattern', async () => {
    const bad = validProfile();
    bad.battlenet.character_id = 'not-a-pulse-id';
    const res = await request(h.app).put('/api/profile').send(bad);
    expect(res.status).toBe(400);
  });

  test('rejects region outside the lowercase enum', async () => {
    const bad = validProfile();
    bad.battlenet.region = 'NA'; // schema allows only us/eu/kr/cn/sea
    const res = await request(h.app).put('/api/profile').send(bad);
    expect(res.status).toBe(400);
  });

  test('rejects unknown top-level property (additionalProperties:false)', async () => {
    const bad = Object.assign(validProfile(), { rogue_field: 'x' });
    const res = await request(h.app).put('/api/profile').send(bad);
    expect(res.status).toBe(400);
  });

  test('rejects missing required field (battlenet)', async () => {
    const bad = validProfile();
    delete bad.battlenet;
    const res = await request(h.app).put('/api/profile').send(bad);
    expect(res.status).toBe(400);
  });

  test('200 + persisted on the wire for a valid profile', async () => {
    const res = await request(h.app).put('/api/profile').send(validProfile());
    expect(res.status).toBe(200);
    expect(res.body.profile.battlenet.battle_tag).toBe('Tester#1234');
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(h.dataDir, 'profile.json'), 'utf8')
    );
    expect(onDisk.battlenet.battle_tag).toBe('Tester#1234');
  });
});

describe('PATCH /api/profile partial merge', () => {
  let h;
  beforeEach(() => {
    h = buildHarness();
    writeJsonFixture(h.dataDir, 'profile.json', validProfile());
  });
  afterEach(() => rmTmpDir(h.dataDir));

  test('updates only the supplied scalar field', async () => {
    const res = await request(h.app)
      .patch('/api/profile')
      .send({ mmr_target: 4500 });
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(h.dataDir, 'profile.json'), 'utf8')
    );
    expect(onDisk.mmr_target).toBe(4500);
    expect(onDisk.battlenet.battle_tag).toBe('Tester#1234');
  });

  test('400 when patch result fails schema', async () => {
    const res = await request(h.app)
      .patch('/api/profile')
      .send({ battlenet: { battle_tag: 'NoHash' } });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/profile/validate', () => {
  let h;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => rmTmpDir(h.dataDir));

  test('ok:true for a clean payload', async () => {
    const res = await request(h.app)
      .post('/api/profile/validate')
      .send(validProfile());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.errors).toEqual([]);
  });

  test('ok:false + structured errors for a malformed payload', async () => {
    const bad = validProfile();
    bad.battlenet.battle_tag = 'no-hash';
    const res = await request(h.app)
      .post('/api/profile/validate')
      .send(bad);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBeGreaterThan(0);
  });
});
