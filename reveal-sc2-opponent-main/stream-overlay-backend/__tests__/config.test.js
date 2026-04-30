/**
 * Focused tests for the /api/config spec mounted by routes/settings.js.
 *
 * Per Stage 11.3 we keep settings.test.js for shared GET/PUT/PATCH
 * plumbing and use this file for config-specific schema enforcement.
 * The config schema has six required top-level branches (paths,
 * macro_engine, build_classifier, stream_overlay, telemetry, ui), each
 * with its own additionalProperties:false gate, so we exercise a
 * representative failure mode for each branch the launcher reads.
 *
 * No mocks for fs or ajv: tmp dataDir seeded with real config.schema.json.
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

function validConfig() {
  return {
    version: 1,
    paths: {
      sc2_install_dir: 'C:/Program Files (x86)/StarCraft II',
      replay_folders: [
        'C:/Users/test/Documents/StarCraft II/Accounts/X/Y/Replays/Multiplayer',
      ],
    },
    macro_engine: {
      enabled_disciplines: ['chrono', 'inject', 'mule', 'supply', 'worker_production'],
      minimum_game_length_sec: 120,
      engine_version: '2026-04-chain-counted',
    },
    build_classifier: {
      active_definition_ids: ['pvt-cannon-rush'],
      use_custom_builds: true,
      use_community_shared_builds: false,
    },
    stream_overlay: {
      enabled: false,
      twitch_channel: null,
      obs_websocket: { host: '127.0.0.1', port: 4455, password: null },
    },
    telemetry: { opt_in: false },
    ui: { theme: 'dark', default_perspective: 'me' },
  };
}

function buildHarness() {
  const dataDir = makeTmpDir('sc2-config-');
  seedSchemas(dataDir, SCHEMAS);
  const app = makeApp((a) => a.use(createSettingsRouter({ dataDir })));
  return { app, dataDir };
}

describe('GET /api/config', () => {
  let h;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => rmTmpDir(h.dataDir));

  test('404 when config.json missing', async () => {
    const res = await request(h.app).get('/api/config');
    expect(res.status).toBe(404);
  });

  test('200 with body once seeded; envelope is {config: {...}}', async () => {
    writeJsonFixture(h.dataDir, 'config.json', validConfig());
    const res = await request(h.app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.config.paths.replay_folders).toHaveLength(1);
    expect(res.body.config.macro_engine.engine_version).toBe('2026-04-chain-counted');
  });
});

describe('PUT /api/config schema enforcement', () => {
  let h;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => rmTmpDir(h.dataDir));

  test('happy path: 200 + atomic write on disk', async () => {
    const res = await request(h.app).put('/api/config').send(validConfig());
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(h.dataDir, 'config.json'), 'utf8')
    );
    expect(onDisk.macro_engine.engine_version).toBe('2026-04-chain-counted');
    // Atomic write contract: no leftover .tmp file after success.
    expect(fs.existsSync(path.join(h.dataDir, 'config.json.tmp'))).toBe(false);
  });

  test('rejects payload missing required `paths`', async () => {
    const bad = validConfig();
    delete bad.paths;
    const res = await request(h.app).put('/api/config').send(bad);
    expect(res.status).toBe(400);
    expect(Array.isArray(res.body.errors)).toBe(true);
  });

  test('rejects empty replay_folders (minItems:1)', async () => {
    const bad = validConfig();
    bad.paths.replay_folders = [];
    const res = await request(h.app).put('/api/config').send(bad);
    expect(res.status).toBe(400);
  });

  test('rejects duplicate replay_folders (uniqueItems:true)', async () => {
    const bad = validConfig();
    bad.paths.replay_folders = ['C:/x', 'C:/x'];
    const res = await request(h.app).put('/api/config').send(bad);
    expect(res.status).toBe(400);
  });

  test('rejects unknown top-level property', async () => {
    const bad = Object.assign(validConfig(), { unknown_key: 1 });
    const res = await request(h.app).put('/api/config').send(bad);
    expect(res.status).toBe(400);
  });

  test('rejects unknown macro_engine discipline', async () => {
    const bad = validConfig();
    bad.macro_engine.enabled_disciplines = ['not_a_discipline'];
    const res = await request(h.app).put('/api/config').send(bad);
    expect(res.status).toBe(400);
  });

  test('rejects ui.theme outside enum', async () => {
    const bad = validConfig();
    bad.ui.theme = 'midnight'; // schema allows only "dark"|"light"
    const res = await request(h.app).put('/api/config').send(bad);
    expect(res.status).toBe(400);
  });

  test('rejects obs_websocket.port out of range', async () => {
    const bad = validConfig();
    bad.stream_overlay.obs_websocket.port = 99999;
    const res = await request(h.app).put('/api/config').send(bad);
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/config partial merge', () => {
  let h;
  beforeEach(() => {
    h = buildHarness();
    writeJsonFixture(h.dataDir, 'config.json', validConfig());
  });
  afterEach(() => rmTmpDir(h.dataDir));

  test('deep-merges a nested key without dropping siblings', async () => {
    const res = await request(h.app)
      .patch('/api/config')
      .send({ ui: { theme: 'light' } });
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(h.dataDir, 'config.json'), 'utf8')
    );
    expect(onDisk.ui.theme).toBe('light');
    expect(onDisk.ui.default_perspective).toBe('me');
    expect(onDisk.paths.replay_folders).toHaveLength(1);
  });
});

describe('POST /api/config/validate', () => {
  let h;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => rmTmpDir(h.dataDir));

  test('ok:true for a clean config', async () => {
    const res = await request(h.app)
      .post('/api/config/validate')
      .send(validConfig());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('ok:false + structured errors when invalid', async () => {
    const bad = validConfig();
    bad.paths.replay_folders = [];
    const res = await request(h.app)
      .post('/api/config/validate')
      .send(bad);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(Array.isArray(res.body.errors)).toBe(true);
  });
});
