/**
 * Tests for lib/datastore.js — schema-validated, quarantine-on-bad-shape
 * data layer. Real fs against tmp dirs seeded with the real schemas.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { createDatastore, ValidationError } = require('../lib/datastore');
const {
  makeTmpDir, rmTmpDir, seedSchemas, writeJsonFixture,
} = require('./_helpers');

const SCHEMAS = ['profile.schema.json', 'config.schema.json',
                 'custom_builds.schema.json'];

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
  const dir = makeTmpDir('datastore-');
  seedSchemas(dir, SCHEMAS);
  return { dir, ds: createDatastore({ dataDir: dir }) };
}

describe('createDatastore factory', () => {
  test('throws when dataDir is missing', () => {
    expect(() => createDatastore({})).toThrow(TypeError);
  });
  test('throws when a registered schema file is missing', () => {
    const dir = makeTmpDir('datastore-noschema-');
    try {
      expect(() => createDatastore({ dataDir: dir }))
        .toThrow(/missing schema/);
    } finally {
      rmTmpDir(dir);
    }
  });
});

describe('read', () => {
  let h;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => rmTmpDir(h.dir));

  test('returns the registry default when the file is missing', () => {
    expect(h.ds.read('profile')).toBeNull();
    // After settings-pr1o the version is derived from
    // custom_builds.schema.json#properties.version.const, not
    // hardcoded. Same observable result — proves the chain works.
    expect(h.ds.read('custom_builds'))
      .toEqual({ version: 3, builds: [] });
  });

  test('returns the parsed value when the file is valid', () => {
    writeJsonFixture(h.dir, 'profile.json', validProfile());
    expect(h.ds.read('profile').battlenet.battle_tag).toBe('Tester#1234');
  });

  test('quarantines + returns fallback on parse error', () => {
    const p = path.join(h.dir, 'profile.json');
    fs.writeFileSync(p, '{not json');
    const out = h.ds.read('profile', { fallback: 'FB' });
    expect(out).toBe('FB');
    expect(fs.existsSync(p)).toBe(false);
    const dirContents = fs.readdirSync(h.dir);
    expect(dirContents.some(n => n.includes('profile.json.broken-parseerror'))).toBe(true);
  });

  test('quarantines + returns fallback on schema invalid', () => {
    const bad = validProfile();
    bad.battlenet.battle_tag = 'NoHash';
    writeJsonFixture(h.dir, 'profile.json', bad);
    const out = h.ds.read('profile', { fallback: 'FB' });
    expect(out).toBe('FB');
    const dirContents = fs.readdirSync(h.dir);
    expect(dirContents.some(n => n.includes('profile.json.broken-schemainvalid'))).toBe(true);
  });

  test('handles trailing-NUL partial-write corruption gracefully', () => {
    // Reproduce the failure mode that bit us four times today.
    const p = path.join(h.dir, 'profile.json');
    const valid = JSON.stringify(validProfile());
    fs.writeFileSync(p, valid + '\u0000'.repeat(500));
    const out = h.ds.read('profile', { fallback: 'FB' });
    // The trailing-NUL stripper means this should parse OK now.
    expect(out).not.toBe('FB');
    expect(out.battlenet.battle_tag).toBe('Tester#1234');
  });
});

describe('write', () => {
  let h;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => rmTmpDir(h.dir));

  test('writes a valid value atomically', () => {
    h.ds.write('profile', validProfile());
    const onDisk = JSON.parse(fs.readFileSync(
      path.join(h.dir, 'profile.json'), 'utf8'));
    expect(onDisk.battlenet.battle_tag).toBe('Tester#1234');
    expect(fs.existsSync(path.join(h.dir, 'profile.json.tmp'))).toBe(false);
  });

  test('throws ValidationError with structured errors on bad shape', () => {
    const bad = validProfile();
    bad.battlenet.battle_tag = 'NoHash';
    let caught = null;
    try { h.ds.write('profile', bad); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(Array.isArray(caught.errors)).toBe(true);
    expect(caught.errors.length).toBeGreaterThan(0);
  });

  test('truncates a longer existing file (no NUL padding)', () => {
    const p = path.join(h.dir, 'profile.json');
    fs.writeFileSync(p, 'X'.repeat(2000));
    h.ds.write('profile', validProfile());
    const buf = fs.readFileSync(p);
    expect(buf.length).toBeLessThan(500);
    expect(buf.includes(0)).toBe(false);
  });

  test('rejects writes for unknown document name', () => {
    expect(() => h.ds.write('xyzzy', {})).toThrow(/unknown document/);
  });
});

describe('end-to-end round trip', () => {
  let h;
  beforeEach(() => { h = buildHarness(); });
  afterEach(() => rmTmpDir(h.dir));

  test('write then read returns the same value', () => {
    h.ds.write('profile', validProfile());
    expect(h.ds.read('profile')).toEqual(validProfile());
  });

  test('write + corrupt + read = quarantine + fallback', () => {
    h.ds.write('profile', validProfile());
    fs.writeFileSync(h.ds.pathFor('profile'), 'totally garbage');
    expect(h.ds.read('profile', { fallback: null })).toBeNull();
    expect(h.ds.has('profile')).toBe(false);
  });
});
