/**
 * Smoke tests for routes/backups.js.
 *
 * Drives the router via supertest against a fresh Express app whose
 * dataDir is an isolated tmp directory. No mocks: every assertion
 * runs against real fs operations on real bytes.
 *
 * The injected clock returns a monotonically advancing UTC time so
 * timestamp labels are deterministic and assertions are stable
 * across CI runs.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');

const {
  createBackupsRouter,
  parseSnapshotName,
  validateBackupName,
  isAllowedBase,
  timestampLabel,
} = require('../routes/backups');

// ------------------------------------------------------------------
// FIXTURES
// ------------------------------------------------------------------

function makeTmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sc2-backups-'));
}

function makeClock(startIso) {
  let next = new Date(startIso).getTime();
  return () => {
    const value = new Date(next);
    next += 60_000; // advance one minute per call
    return value;
  };
}

function makeApp(dataDir, clock) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(createBackupsRouter({ dataDir, clock }));
  return app;
}

function writeFixture(dataDir, name, content) {
  fs.writeFileSync(path.join(dataDir, name), content);
}

const META_BYTES = '{"games":[{"map":"Tourmaline LE"}]}';
const PROFILE_BYTES = JSON.stringify({
  version: 1,
  battlenet: {
    battle_tag: 'ReSpOnSe#1234',
    character_id: '1-S2-1-267727',
    account_id: '50983875',
    region: 'us',
  },
  races: ['Protoss'],
  mmr_target: null,
  preferred_player_name_in_replays: 'ReSpOnSe',
}, null, 2);

// ------------------------------------------------------------------
// PARSER + VALIDATOR UNIT TESTS
// ------------------------------------------------------------------

describe('parseSnapshotName', () => {
  it('decomposes a backup-kind name', () => {
    expect(parseSnapshotName('meta_database.json.backup-20260427T120000Z'))
      .toEqual({
        base: 'meta_database.json',
        kind: 'backup',
        label: '20260427T120000Z',
      });
  });

  it('decomposes a broken-kind name', () => {
    expect(parseSnapshotName('meta_database.json.broken-20260426-182232'))
      .toEqual({
        base: 'meta_database.json',
        kind: 'broken',
        label: '20260426-182232',
      });
  });

  it('decomposes a pre-kind name with a long migration label', () => {
    expect(parseSnapshotName(
      'meta_database.json.pre-chrono-fix-20260427-021758'
    )).toEqual({
      base: 'meta_database.json',
      kind: 'pre',
      label: 'chrono-fix-20260427-021758',
    });
  });

  it('decomposes a bak-kind name', () => {
    expect(parseSnapshotName('profile.json.bak-1777307689')).toEqual({
      base: 'profile.json',
      kind: 'bak',
      label: '1777307689',
    });
  });

  it('returns null for a live file', () => {
    expect(parseSnapshotName('meta_database.json')).toBeNull();
  });

  it('returns null for non-allow-listed bases', () => {
    expect(parseSnapshotName('hostile.txt.backup-x')).toBeNull();
    expect(parseSnapshotName('etc.json.backup-y')).toBeNull();
  });

  it('returns null for empty / nullish input', () => {
    expect(parseSnapshotName('')).toBeNull();
    expect(parseSnapshotName(null)).toBeNull();
    expect(parseSnapshotName(undefined)).toBeNull();
  });
});

describe('validateBackupName', () => {
  it('accepts a real backup name', () => {
    const res = validateBackupName('profile.json.bak-1777307689');
    expect(res.ok).toBe(true);
    expect(res.parsed.base).toBe('profile.json');
  });

  it('rejects path traversal at the regex layer', () => {
    expect(validateBackupName('../etc/passwd')).toEqual({
      ok: false, error: 'invalid_name',
    });
    expect(validateBackupName('foo/bar.backup-x')).toEqual({
      ok: false, error: 'invalid_name',
    });
    expect(validateBackupName('foo\\bar.backup-x')).toEqual({
      ok: false, error: 'invalid_name',
    });
  });

  it('rejects an allow-listed live file', () => {
    expect(validateBackupName('config.json')).toEqual({
      ok: false, error: 'not_a_backup',
    });
  });

  it('rejects empty input as name_required', () => {
    expect(validateBackupName('')).toEqual({
      ok: false, error: 'name_required',
    });
  });
});

describe('isAllowedBase', () => {
  it('admits every base in the allow list', () => {
    expect(isAllowedBase('meta_database.json')).toBe(true);
    expect(isAllowedBase('MyOpponentHistory.json')).toBe(true);
    expect(isAllowedBase('profile.json')).toBe(true);
    expect(isAllowedBase('config.json')).toBe(true);
    expect(isAllowedBase('custom_builds.json')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isAllowedBase('arbitrary.json')).toBe(false);
    expect(isAllowedBase('')).toBe(false);
    expect(isAllowedBase('../etc/passwd')).toBe(false);
  });
});

describe('timestampLabel', () => {
  it('formats UTC iso to a filename-safe label', () => {
    expect(timestampLabel(new Date('2026-04-27T18:30:45.123Z')))
      .toBe('20260427T183045Z');
  });
});

// ------------------------------------------------------------------
// FACTORY CONTRACT
// ------------------------------------------------------------------

describe('createBackupsRouter', () => {
  it('throws without dataDir', () => {
    expect(() => createBackupsRouter()).toThrow(/dataDir/);
    expect(() => createBackupsRouter({})).toThrow(/dataDir/);
  });

  it('returns an Express router', () => {
    const r = createBackupsRouter({ dataDir: '/tmp/never-actually-read' });
    expect(typeof r.use).toBe('function');
  });
});

// ------------------------------------------------------------------
// HTTP CONTRACT
// ------------------------------------------------------------------

describe('backups router HTTP', () => {
  let dataDir;
  let app;
  let clock;

  beforeEach(() => {
    dataDir = makeTmpDataDir();
    clock = makeClock('2026-04-27T18:00:00Z');
    app = makeApp(dataDir, clock);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // ---- LIST -------------------------------------------------------
  describe('GET /api/backups', () => {
    it('returns an empty list for an empty data dir', async () => {
      const res = await request(app).get('/api/backups').expect(200);
      expect(res.body).toEqual({ backups: [] });
    });

    it('returns only allow-listed backup-shaped entries', async () => {
      writeFixture(dataDir, 'meta_database.json', META_BYTES);
      writeFixture(dataDir, 'meta_database.json.backup-20260427T120000Z', '{}');
      writeFixture(dataDir, 'meta_database.json.broken-20260426-182232', '{}');
      writeFixture(dataDir, 'meta_database.json.pre-chrono-fix-20260427-021758', '{}');
      writeFixture(dataDir, 'profile.json.bak-1777307689', '{}');
      // Should be filtered out:
      writeFixture(dataDir, 'random_unrelated_file.txt', 'x');
      writeFixture(dataDir, 'hostile.json.backup-x', 'x');
      writeFixture(dataDir, 'meta_database.json', '{}'); // live file

      const res = await request(app).get('/api/backups').expect(200);
      const names = res.body.backups.map((b) => b.name).sort();
      expect(names).toEqual([
        'meta_database.json.backup-20260427T120000Z',
        'meta_database.json.broken-20260426-182232',
        'meta_database.json.pre-chrono-fix-20260427-021758',
        'profile.json.bak-1777307689',
      ]);
    });

    it('attaches base, kind, label, size, modified_iso to each entry', async () => {
      writeFixture(dataDir, 'meta_database.json.backup-20260427T120000Z', '{}');
      const res = await request(app).get('/api/backups').expect(200);
      const entry = res.body.backups[0];
      expect(entry.name).toBe('meta_database.json.backup-20260427T120000Z');
      expect(entry.base).toBe('meta_database.json');
      expect(entry.kind).toBe('backup');
      expect(entry.label).toBe('20260427T120000Z');
      expect(typeof entry.size).toBe('number');
      expect(typeof entry.modified_iso).toBe('string');
      expect(() => new Date(entry.modified_iso)).not.toThrow();
    });

    it('sorts entries newest-first by modified_iso', async () => {
      writeFixture(dataDir, 'meta_database.json.backup-20260101T000000Z', 'a');
      writeFixture(dataDir, 'meta_database.json.backup-20260427T120000Z', 'b');
      // touch the second file to be definitively newer than the first
      const olderTime = new Date('2026-01-02T00:00:00Z');
      const newerTime = new Date('2026-04-27T18:00:00Z');
      fs.utimesSync(
        path.join(dataDir, 'meta_database.json.backup-20260101T000000Z'),
        olderTime, olderTime
      );
      fs.utimesSync(
        path.join(dataDir, 'meta_database.json.backup-20260427T120000Z'),
        newerTime, newerTime
      );
      const res = await request(app).get('/api/backups').expect(200);
      expect(res.body.backups[0].name)
        .toBe('meta_database.json.backup-20260427T120000Z');
    });
  });

  // ---- CREATE -----------------------------------------------------
  describe('POST /api/backups/create', () => {
    it('snapshots meta_database.json by default', async () => {
      writeFixture(dataDir, 'meta_database.json', META_BYTES);
      const res = await request(app).post('/api/backups/create')
        .send({}).expect(200);
      expect(res.body.snapshot.base).toBe('meta_database.json');
      expect(res.body.snapshot.kind).toBe('backup');
      expect(res.body.snapshot.name).toMatch(
        /^meta_database\.json\.backup-\d{8}T\d{6}Z$/
      );
      // file actually exists on disk
      expect(fs.existsSync(path.join(dataDir, res.body.snapshot.name))).toBe(true);
      // contents byte-identical
      expect(fs.readFileSync(
        path.join(dataDir, res.body.snapshot.name), 'utf8'
      )).toBe(META_BYTES);
    });

    it('snapshots an explicit allow-listed base', async () => {
      writeFixture(dataDir, 'profile.json', PROFILE_BYTES);
      const res = await request(app).post('/api/backups/create')
        .send({ base: 'profile.json' }).expect(200);
      expect(res.body.snapshot.base).toBe('profile.json');
      expect(res.body.snapshot.size).toBe(Buffer.byteLength(PROFILE_BYTES));
    });

    it('rejects a base outside the allow list with 400', async () => {
      const res = await request(app).post('/api/backups/create')
        .send({ base: '../etc/passwd' }).expect(400);
      expect(res.body).toEqual({ error: 'invalid_base' });
    });

    it('returns 404 base_not_found when the live file is missing', async () => {
      const res = await request(app).post('/api/backups/create')
        .send({ base: 'meta_database.json' }).expect(404);
      expect(res.body).toEqual({ error: 'base_not_found' });
    });

    it('produces a unique snapshot name per call (clock advances)', async () => {
      writeFixture(dataDir, 'meta_database.json', META_BYTES);
      const a = await request(app).post('/api/backups/create')
        .send({}).expect(200);
      const b = await request(app).post('/api/backups/create')
        .send({}).expect(200);
      expect(a.body.snapshot.name).not.toBe(b.body.snapshot.name);
    });
  });

  // ---- RESTORE ----------------------------------------------------
  describe('POST /api/backups/restore', () => {
    it('overwrites the live file with snapshot bytes', async () => {
      writeFixture(dataDir, 'meta_database.json', '{"old":true}');
      writeFixture(
        dataDir,
        'meta_database.json.backup-20260427T120000Z',
        '{"new":true}'
      );
      const res = await request(app).post('/api/backups/restore').send({
        snapshot: 'meta_database.json.backup-20260427T120000Z',
      }).expect(200);
      expect(res.body.restored).toBe('meta_database.json');
      expect(fs.readFileSync(
        path.join(dataDir, 'meta_database.json'), 'utf8'
      )).toBe('{"new":true}');
    });

    it('takes a pre-restore safety snapshot of the current live file', async () => {
      writeFixture(dataDir, 'meta_database.json', '{"old":true}');
      writeFixture(
        dataDir,
        'meta_database.json.backup-20260427T120000Z',
        '{"new":true}'
      );
      const res = await request(app).post('/api/backups/restore').send({
        snapshot: 'meta_database.json.backup-20260427T120000Z',
      }).expect(200);
      expect(res.body.pre_restore_snapshot).not.toBeNull();
      expect(res.body.pre_restore_snapshot.kind).toBe('pre');
      expect(res.body.pre_restore_snapshot.name).toMatch(
        /^meta_database\.json\.pre-restore-\d{8}T\d{6}Z$/
      );
      // Pre-restore snapshot contains the OLD bytes; live now has NEW.
      expect(fs.readFileSync(
        path.join(dataDir, res.body.pre_restore_snapshot.name), 'utf8'
      )).toBe('{"old":true}');
    });

    it('still restores when no live file exists yet (no safety snapshot)', async () => {
      writeFixture(
        dataDir,
        'meta_database.json.backup-20260427T120000Z',
        '{"new":true}'
      );
      const res = await request(app).post('/api/backups/restore').send({
        snapshot: 'meta_database.json.backup-20260427T120000Z',
      }).expect(200);
      expect(res.body.pre_restore_snapshot).toBeNull();
      expect(fs.readFileSync(
        path.join(dataDir, 'meta_database.json'), 'utf8'
      )).toBe('{"new":true}');
    });

    it('rejects path traversal in snapshot name with 400 invalid_name', async () => {
      const res = await request(app).post('/api/backups/restore')
        .send({ snapshot: '../etc/passwd' }).expect(400);
      expect(res.body).toEqual({ error: 'invalid_name' });
    });

    it('rejects a non-allow-listed base via not_a_backup', async () => {
      const res = await request(app).post('/api/backups/restore')
        .send({ snapshot: 'hostile.json.backup-x' }).expect(400);
      expect(res.body).toEqual({ error: 'not_a_backup' });
    });

    it('returns 404 when the snapshot does not exist on disk', async () => {
      const res = await request(app).post('/api/backups/restore')
        .send({ snapshot: 'meta_database.json.backup-20260427T120000Z' })
        .expect(404);
      expect(res.body).toEqual({ error: 'snapshot_not_found' });
    });

    it('rejects an empty snapshot field with name_required', async () => {
      const res = await request(app).post('/api/backups/restore')
        .send({}).expect(400);
      expect(res.body).toEqual({ error: 'name_required' });
    });
  });

  // ---- DELETE -----------------------------------------------------
  describe('DELETE /api/backups/:name', () => {
    it('removes a real backup from disk', async () => {
      writeFixture(
        dataDir,
        'meta_database.json.backup-20260427T120000Z',
        'x'
      );
      const res = await request(app)
        .delete('/api/backups/meta_database.json.backup-20260427T120000Z')
        .expect(200);
      expect(res.body).toEqual({
        deleted: 'meta_database.json.backup-20260427T120000Z',
      });
      expect(fs.existsSync(
        path.join(dataDir, 'meta_database.json.backup-20260427T120000Z')
      )).toBe(false);
    });

    it('rejects unsafe chars in :name via the regex layer (400)',
      async () => {
        // Path traversal attempts using path separators (.., /, \\)
        // are short-circuited by Express's URL normalisation before
        // they reach our handler -- that's a defense layer in its
        // own right. What our regex defends against is unsafe chars
        // that DO survive routing: spaces, quotes, semicolons,
        // shell metacharacters, etc.
        const unsafe = encodeURIComponent("foo'bar.backup-x");
        const res = await request(app).delete(`/api/backups/${unsafe}`)
          .expect(400);
        expect(res.body).toEqual({ error: 'invalid_name' });
      });

    it('returns 404 (not 200) for express-collapsed traversal attempts',
      async () => {
        // Sanity check that Express's routing kicks the request to
        // 404 before our handler runs. We never want a path that
        // looks like /api/backups/.. to mutate anything.
        const res = await request(app).delete('/api/backups/..');
        expect([404, 400]).toContain(res.status);
      });

    it('rejects non-backup filenames with 409 not_a_backup', async () => {
      writeFixture(dataDir, 'meta_database.json', '{}');
      const res = await request(app)
        .delete('/api/backups/meta_database.json')
        .expect(409);
      expect(res.body).toEqual({ error: 'not_a_backup' });
      // Live file MUST still exist.
      expect(fs.existsSync(path.join(dataDir, 'meta_database.json')))
        .toBe(true);
    });

    it('returns 404 when the snapshot does not exist on disk', async () => {
      const res = await request(app)
        .delete('/api/backups/meta_database.json.backup-20260427T120000Z')
        .expect(404);
      expect(res.body).toEqual({ error: 'snapshot_not_found' });
    });
  });

  // ---- END-TO-END FLOW --------------------------------------------
  describe('end-to-end snapshot lifecycle', () => {
    it('create -> list -> restore -> delete works on real bytes', async () => {
      writeFixture(dataDir, 'meta_database.json', '{"v":1}');

      // create
      const created = await request(app).post('/api/backups/create')
        .send({}).expect(200);
      const snapName = created.body.snapshot.name;

      // mutate the live file
      writeFixture(dataDir, 'meta_database.json', '{"v":2}');

      // list shows our snapshot
      const listed = await request(app).get('/api/backups').expect(200);
      const names = listed.body.backups.map((b) => b.name);
      expect(names).toContain(snapName);

      // restore brings v=1 back
      const restored = await request(app).post('/api/backups/restore')
        .send({ snapshot: snapName }).expect(200);
      expect(restored.body.restored).toBe('meta_database.json');
      expect(fs.readFileSync(
        path.join(dataDir, 'meta_database.json'), 'utf8'
      )).toBe('{"v":1}');

      // delete the original snapshot
      const deleted = await request(app)
        .delete(`/api/backups/${snapName}`).expect(200);
      expect(deleted.body.deleted).toBe(snapName);
    });
  });

  // ---- PII GUARD --------------------------------------------------
  describe('PII guard', () => {
    it('does not log battle_tag or character_id during create/restore',
      async () => {
        const messages = [];
        const origLog = console.log;
        const origErr = console.error;
        console.log = (...args) => messages.push(args.join(' '));
        console.error = (...args) => messages.push(args.join(' '));
        try {
          writeFixture(dataDir, 'profile.json', PROFILE_BYTES);
          const created = await request(app).post('/api/backups/create')
            .send({ base: 'profile.json' }).expect(200);
          await request(app).post('/api/backups/restore')
            .send({ snapshot: created.body.snapshot.name }).expect(200);
          await request(app).get('/api/backups').expect(200);
        } finally {
          console.log = origLog;
          console.error = origErr;
        }
        const joined = messages.join('\n');
        expect(joined).not.toMatch(/ReSpOnSe#1234/);
        expect(joined).not.toMatch(/1-S2-1-267727/);
        expect(joined).not.toMatch(/50983875/);
      });
  });
});
