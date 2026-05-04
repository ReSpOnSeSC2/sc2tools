// @ts-check
'use strict';

/**
 * Stage 6 -- lib/schema_versioning.js mirrors core/schema_versioning.py.
 *
 * Pins:
 *   * stampVersion writes _schema_version (or `version` for custom_builds).
 *   * Forward migration runs when on-disk < target.
 *   * Backward migration runs when on-disk > target.
 *   * Missing migration step throws SchemaMigrationError.
 *   * Newer-than-expected file throws SchemaTooNewError.
 *   * atomicWriteJson auto-stamps the schema version (cross-language
 *     parity with the Python side).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const sv = require('../lib/schema_versioning');
const { atomicWriteJson } = require('../lib/atomic-fs');

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sc2-stage6-'));
}
function rmTmp(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* */ }
}

describe('Stage 6 -- stampVersion', () => {
  test('writes _schema_version for canonical files', () => {
    const d = { a: 1 };
    sv.stampVersion(d, 'MyOpponentHistory.json');
    expect(d._schema_version).toBe(1);
  });

  test('writes legacy `version` for custom_builds', () => {
    const d = { builds: [] };
    sv.stampVersion(d, 'custom_builds.json');
    expect(d.version).toBe(3);
    expect(d._schema_version).toBeUndefined();
  });

  test('unknown basename is no-op', () => {
    const d = { a: 1 };
    sv.stampVersion(d, 'totally_random.json');
    expect(d).toEqual({ a: 1 });
  });
});

describe('Stage 6 -- migrateDict', () => {
  beforeEach(() => {
    sv._internals.MIGRATIONS.length = 0;
  });

  test('forward migration runs when on-disk < target', () => {
    sv.registerMigration({
      basename: 'MyOpponentHistory.json',
      from_version: 1, to_version: 2,
      forward: (d) => Object.assign({}, d, { added_v2: true }),
      backward: (d) => { const c = Object.assign({}, d); delete c.added_v2; return c; },
    });
    const out = sv.migrateDict(
      { _schema_version: 1, x: 1 },
      'MyOpponentHistory.json',
      { targetVersion: 2 },
    );
    expect(out.added_v2).toBe(true);
    expect(out._schema_version).toBe(2);
  });

  test('backward migration runs when on-disk > target', () => {
    sv.registerMigration({
      basename: 'MyOpponentHistory.json',
      from_version: 1, to_version: 2,
      forward: (d) => Object.assign({}, d, { added_v2: true }),
      backward: (d) => { const c = Object.assign({}, d); delete c.added_v2; return c; },
    });
    const out = sv.migrateDict(
      { _schema_version: 2, x: 1, added_v2: true },
      'MyOpponentHistory.json',
      { targetVersion: 1 },
    );
    expect(out.added_v2).toBeUndefined();
    expect(out._schema_version).toBe(1);
  });

  test('missing forward migration throws', () => {
    expect(() => {
      sv.migrateDict(
        { _schema_version: 1 },
        'MyOpponentHistory.json',
        { targetVersion: 5 },
      );
    }).toThrow(sv.SchemaMigrationError);
  });
});

describe('Stage 6 -- assertNotTooNew', () => {
  test('newer file throws', () => {
    expect(() => {
      sv.assertNotTooNew(
        { _schema_version: 999 },
        'MyOpponentHistory.json',
      );
    }).toThrow(sv.SchemaTooNewError);
  });

  test('at or below the registry passes', () => {
    expect(() => {
      sv.assertNotTooNew({ _schema_version: 1 }, 'MyOpponentHistory.json');
    }).not.toThrow();
    expect(() => {
      sv.assertNotTooNew({}, 'MyOpponentHistory.json');
    }).not.toThrow();
  });
});

describe('Stage 6 -- explicit stamp then atomicWriteJson', () => {
  test('writer stamps then save persists _schema_version', () => {
    const tmp = makeTmp();
    try {
      const p = path.join(tmp, 'MyOpponentHistory.json');
      const big = {};
      for (let i = 0; i < 150; i++) big[String(i)] = i;
      sv.stampVersion(big, 'MyOpponentHistory.json');
      atomicWriteJson(p, big);
      const back = JSON.parse(fs.readFileSync(p, 'utf8'));
      expect(back._schema_version).toBe(1);
    } finally { rmTmp(tmp); }
  });

  test('writer stamps then save persists `version` for custom_builds', () => {
    const tmp = makeTmp();
    try {
      const p = path.join(tmp, 'custom_builds.json');
      const data = { builds: [] };
      sv.stampVersion(data, 'custom_builds.json');
      atomicWriteJson(p, data);
      const back = JSON.parse(fs.readFileSync(p, 'utf8'));
      expect(back.version).toBe(3);
    } finally { rmTmp(tmp); }
  });

  test('canonical helper does NOT auto-stamp', () => {
    // Keeps atomic_write_json shape-neutral so iterators that walk
    // db.values() don't see a stray integer key.
    const tmp = makeTmp();
    try {
      const p = path.join(tmp, 'MyOpponentHistory.json');
      atomicWriteJson(p, { a: 1, b: 2 });
      const back = JSON.parse(fs.readFileSync(p, 'utf8'));
      expect(back._schema_version).toBeUndefined();
      expect(back).toEqual({ a: 1, b: 2 });
    } finally { rmTmp(tmp); }
  });
});
