/**
 * Smoke tests for routes/settings.js.
 *
 * Drives the router via supertest against a fresh Express app pointed
 * at a tmp data dir containing copies of the real schema files. No
 * mocks: every test reads/writes real JSON via the real ajv pipeline.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');

const { createSettingsRouter } = require('../routes/settings');

const REAL_DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SCHEMAS = ['profile.schema.json', 'config.schema.json'];

function makeApp(dataDir) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(createSettingsRouter({ dataDir }));
  return app;
}

function makeTmpDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc2-settings-'));
  for (const schema of SCHEMAS) {
    fs.copyFileSync(path.join(REAL_DATA_DIR, schema), path.join(dir, schema));
  }
  return dir;
}

function validProfile() {
  return {
    version: 1,
    battlenet: {
      battle_tag: 'ReSpOnSe#1234',
      character_id: '1-S2-1-267727',
      account_id: '50983875',
      region: 'us',
    },
    race_preference: 'Protoss',
    mmr_target: null,
    preferred_player_name_in_replays: 'ReSpOnSe',
  };
}

function validConfig() {
  return {
    version: 1,
    paths: {
      sc2_install_dir: 'C:\\Program Files (x86)\\StarCraft II',
      replay_folders: [
        'C:\\Users\\jay19\\OneDrive\\Pictures\\Documents\\StarCraft II\\Accounts\\50983875\\1-S2-1-267727\\Replays\\Multiplayer',
      ],
    },
    macro_engine: {
      enabled_disciplines: ['chrono', 'inject', 'mule'],
      minimum_game_length_sec: 60,
      engine_version: '2026-04-chain-counted',
    },
    build_classifier: {
      active_definition_ids: ['pvp-4-stalker-oracle-into-dt'],
      use_custom_builds: true,
      use_community_shared_builds: true,
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

describe('settings router', () => {
  let dataDir;
  let app;

  beforeEach(() => {
    dataDir = makeTmpDataDir();
    app = makeApp(dataDir);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe('GET /api/profile/exists and /api/config/exists', () => {
    it('reports false when files do not exist', async () => {
      const profileRes = await request(app).get('/api/profile/exists');
      expect(profileRes.status).toBe(200);
      expect(profileRes.body).toEqual({ exists: false });

      const configRes = await request(app).get('/api/config/exists');
      expect(configRes.status).toBe(200);
      expect(configRes.body).toEqual({ exists: false });
    });

    it('reports true after a successful PUT', async () => {
      await request(app).put('/api/profile').send(validProfile()).expect(200);
      const res = await request(app).get('/api/profile/exists');
      expect(res.body).toEqual({ exists: true });
    });
  });

  describe('GET when file missing', () => {
    it('returns 404 not_initialized for profile', async () => {
      const res = await request(app).get('/api/profile');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_initialized' });
    });

    it('returns 404 not_initialized for config', async () => {
      const res = await request(app).get('/api/config');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_initialized' });
    });
  });

  describe('PUT roundtrip', () => {
    it('PUT then GET returns the same profile object', async () => {
      const body = validProfile();
      const put = await request(app).put('/api/profile').send(body);
      expect(put.status).toBe(200);
      expect(put.body.profile).toEqual(body);

      const get = await request(app).get('/api/profile');
      expect(get.status).toBe(200);
      expect(get.body.profile).toEqual(body);
    });

    it('PUT then GET returns the same config object', async () => {
      const body = validConfig();
      const put = await request(app).put('/api/config').send(body);
      expect(put.status).toBe(200);
      expect(put.body.config).toEqual(body);

      const get = await request(app).get('/api/config');
      expect(get.status).toBe(200);
      expect(get.body.config).toEqual(body);
    });

    it('persists profile.json to disk on PUT', async () => {
      await request(app).put('/api/profile').send(validProfile()).expect(200);
      const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'profile.json'), 'utf8'));
      expect(onDisk.battlenet.character_id).toBe('1-S2-1-267727');
    });
  });

  describe('PATCH merge', () => {
    it('merges into existing profile and validates', async () => {
      await request(app).put('/api/profile').send(validProfile()).expect(200);

      const patch = { mmr_target: 4500, battlenet: { region: 'eu' } };
      const res = await request(app).patch('/api/profile').send(patch);
      expect(res.status).toBe(200);
      expect(res.body.profile.mmr_target).toBe(4500);
      expect(res.body.profile.battlenet.region).toBe('eu');
      // Untouched siblings remain.
      expect(res.body.profile.battlenet.battle_tag).toBe('ReSpOnSe#1234');
    });

    it('starts from empty when file does not exist and result must validate', async () => {
      const res = await request(app).patch('/api/profile').send({ version: 1 });
      // Empty + { version: 1 } is missing required `battlenet`, so this fails.
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_failed');
    });

    it('merges into existing config preserving untouched sections', async () => {
      await request(app).put('/api/config').send(validConfig()).expect(200);

      const patch = { stream_overlay: { enabled: true, twitch_channel: 'ResponseSC2' } };
      const res = await request(app).patch('/api/config').send(patch);
      expect(res.status).toBe(200);
      expect(res.body.config.stream_overlay.enabled).toBe(true);
      expect(res.body.config.stream_overlay.twitch_channel).toBe('ResponseSC2');
      expect(res.body.config.stream_overlay.obs_websocket.port).toBe(4455);
      expect(res.body.config.telemetry).toEqual({ opt_in: false });
    });
  });

  describe('schema enforcement', () => {
    it('PUT rejects malformed profile', async () => {
      const bad = validProfile();
      bad.battlenet.region = 'mars';
      const res = await request(app).put('/api/profile').send(bad);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_failed');
      expect(Array.isArray(res.body.errors)).toBe(true);
      expect(res.body.errors.length).toBeGreaterThan(0);
      // Disk should not have been written.
      expect(fs.existsSync(path.join(dataDir, 'profile.json'))).toBe(false);
    });

    it('PUT rejects malformed config', async () => {
      const bad = validConfig();
      bad.macro_engine.minimum_game_length_sec = -1;
      const res = await request(app).put('/api/config').send(bad);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_failed');
    });

    it('PUT rejects non-object body (array)', async () => {
      const res = await request(app)
        .put('/api/profile')
        .set('Content-Type', 'application/json')
        .send('[1,2,3]');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_body');
    });
  });

  describe('POST /validate', () => {
    it('returns ok=true for valid profile', async () => {
      const res = await request(app)
        .post('/api/profile/validate')
        .send(validProfile());
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, errors: [] });
    });

    it('returns ok=false with errors for invalid profile', async () => {
      const bad = validProfile();
      delete bad.battlenet;
      const res = await request(app).post('/api/profile/validate').send(bad);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.errors.length).toBeGreaterThan(0);
    });

    it('returns ok=true for valid config', async () => {
      const res = await request(app)
        .post('/api/config/validate')
        .send(validConfig());
      expect(res.body).toEqual({ ok: true, errors: [] });
    });
  });

  describe('atomic write hygiene', () => {
    it('leaves no .tmp behind after a PUT', async () => {
      await request(app).put('/api/profile').send(validProfile()).expect(200);
      const entries = fs.readdirSync(dataDir);
      expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
    });

    it('leaves no .tmp behind after a rejected PUT', async () => {
      const bad = validProfile();
      bad.race_preference = 'Toss';
      await request(app).put('/api/profile').send(bad).expect(400);
      const entries = fs.readdirSync(dataDir);
      expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
    });
  });
});
