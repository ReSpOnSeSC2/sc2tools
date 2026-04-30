/**
 * Tests for lib/schema-version.js — the canonical
 * schema-version reader. Real fs against tmp dirs seeded with
 * the real schemas.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const {
  getSchemaVersion, getAllSchemaVersions,
} = require('../lib/schema-version');
const {
  makeTmpDir, rmTmpDir, seedSchemas,
} = require('./_helpers');

const SCHEMAS = ['profile.schema.json', 'config.schema.json',
                 'custom_builds.schema.json'];

function harness() {
  const dir = makeTmpDir('schema-version-');
  seedSchemas(dir, SCHEMAS);
  return dir;
}

describe('getSchemaVersion', () => {
  let dir;
  beforeEach(() => { dir = harness(); });
  afterEach(() => rmTmpDir(dir));

  test('returns 1 for profile (matches schema.properties.version.const)', () => {
    expect(getSchemaVersion(dir, 'profile')).toBe(1);
  });

  test('returns 1 for config', () => {
    expect(getSchemaVersion(dir, 'config')).toBe(1);
  });

  test('returns 3 for custom_builds (was hardcoded; now derived)', () => {
    expect(getSchemaVersion(dir, 'custom_builds')).toBe(3);
  });

  test('throws on unknown document', () => {
    expect(() => getSchemaVersion(dir, 'xyzzy'))
      .toThrow(/unknown document/);
  });

  test('throws when dataDir is missing', () => {
    expect(() => getSchemaVersion('', 'profile')).toThrow(TypeError);
    expect(() => getSchemaVersion(null, 'profile')).toThrow(TypeError);
  });

  test('throws when the schema lacks properties.version.const', () => {
    // Mutate a copy of the schema to remove the const, prove the
    // helper fails LOUDLY rather than silently defaulting.
    const broken = path.join(dir, 'profile.schema.json');
    const schema = JSON.parse(fs.readFileSync(broken, 'utf8'));
    delete schema.properties.version.const;
    fs.writeFileSync(broken, JSON.stringify(schema));
    expect(() => getSchemaVersion(dir, 'profile'))
      .toThrow(/lacks integer properties\.version\.const/);
  });
});

describe('getAllSchemaVersions', () => {
  let dir;
  beforeEach(() => { dir = harness(); });
  afterEach(() => rmTmpDir(dir));

  test('returns the version for every registered document', () => {
    const all = getAllSchemaVersions(dir);
    expect(all).toEqual({
      profile: 1,
      config: 1,
      custom_builds: 3,
    });
  });
});
