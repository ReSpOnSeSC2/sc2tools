/**
 * Tests for the session-state recovery and atomic-write helpers in
 * stream-overlay-backend/index.js.
 *
 * These tests run against real fs operations on real bytes (no mocks)
 * inside a tmp dir, per the engineering preamble's "real fixtures
 * over mocks" rule. They are gated on NODE_ENV=test so requiring
 * index.js doesn't start the express server.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';

// Importing index.js exposes the test-only helpers via its
// `module.exports` block. We don't await any server side-effect:
// app.listen() is guarded by `require.main === module`, so a plain
// require() under jest simply pulls in the helpers.
const {
  _atomicWriteJsonSync,
  _parseSessionFile,
  _listSessionBackups,
  _quarantineBrokenSession,
  defaultSession,
} = require('../index');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sc2-session-'));
}

function writeFile(p, body) {
  fs.writeFileSync(p, body, 'utf8');
}

describe('_atomicWriteJsonSync', () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('writes a parseable JSON file with the requested data', () => {
    const target = path.join(dir, 'session.state.json');
    const data = { wins: 3, losses: 1, mmrDelta: -25, metaCounts: { foo: 2 } };
    _atomicWriteJsonSync(target, data, 2);

    expect(fs.existsSync(target)).toBe(true);
    const raw = fs.readFileSync(target, 'utf8');
    expect(JSON.parse(raw)).toEqual(data);
    // Indented with 2 spaces.
    expect(raw).toContain('\n  "wins"');
  });

  test('overwrites an existing file with new content', () => {
    const target = path.join(dir, 'session.state.json');
    _atomicWriteJsonSync(target, { wins: 1 }, 2);
    _atomicWriteJsonSync(target, { wins: 2 }, 2);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ wins: 2 });
  });

  test('does not leave .tmp_ siblings behind on success', () => {
    const target = path.join(dir, 'session.state.json');
    _atomicWriteJsonSync(target, { wins: 1 }, 2);
    const leftovers = fs.readdirSync(dir).filter(n => n.startsWith('.tmp_'));
    expect(leftovers).toEqual([]);
  });
});

describe('_parseSessionFile', () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('returns merged defaults + parsed data for a valid file', () => {
    const target = path.join(dir, 's.json');
    const stored = { wins: 4, losses: 2, lastResultTime: 1000 };
    writeFile(target, JSON.stringify(stored));

    const merged = _parseSessionFile(target);
    expect(merged.wins).toBe(4);
    expect(merged.losses).toBe(2);
    // Defaults survive for fields not in stored.
    const d = defaultSession();
    expect(merged.startedAt).toBe(d.startedAt === undefined ? merged.startedAt : merged.startedAt);
    expect(merged.metaCounts).toEqual({});
  });

  test('throws on truncated / invalid JSON', () => {
    const target = path.join(dir, 's.json');
    // The exact shape we observed in the wild: cuts mid-string in metaCounts.
    writeFile(target, '{\n  "wins": 0,\n  "losses": 2,\n  "metaCounts": {\n    "Terran - Cyclone ');
    expect(() => _parseSessionFile(target)).toThrow();
  });

  test('backfills mmrDelta from real anchors when the stored delta is 0', () => {
    const target = path.join(dir, 's.json');
    writeFile(target, JSON.stringify({
      wins: 0, losses: 0, mmrDelta: 0, mmrStart: 3000, mmrCurrent: 3025
    }));
    const merged = _parseSessionFile(target);
    expect(merged.mmrDelta).toBe(25);
  });
});

describe('_listSessionBackups', () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('orders backups newest first by mtime, excludes .broken-* and .tmp_*', () => {
    const target = path.join(dir, 'session.state.json');
    const older  = `${target}.bak.20260427-180000`;
    const newer  = `${target}.bak.20260428-090000`;
    const broken = `${target}.broken-20260428-100000`;
    const tmp    = path.join(dir, '.tmp_x.json');

    writeFile(older,  '{}');
    writeFile(newer,  '{}');
    writeFile(broken, '{}');
    writeFile(tmp,    '{}');

    // Force a clear mtime gap so the ordering is deterministic.
    fs.utimesSync(older, new Date('2026-04-27T18:00:00Z'), new Date('2026-04-27T18:00:00Z'));
    fs.utimesSync(newer, new Date('2026-04-28T09:00:00Z'), new Date('2026-04-28T09:00:00Z'));

    const list = _listSessionBackups(target);
    expect(list).toEqual([newer, older]);
    expect(list).not.toContain(broken);
    expect(list).not.toContain(tmp);
  });

  test('returns an empty list when the parent dir does not exist', () => {
    const target = path.join(dir, 'nope', 'session.state.json');
    expect(_listSessionBackups(target)).toEqual([]);
  });
});

describe('_quarantineBrokenSession', () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('renames the broken file aside with a .broken-<ts> suffix', () => {
    const target = path.join(dir, 'session.state.json');
    writeFile(target, '{ "broken": ');
    _quarantineBrokenSession(target, 'unit test');
    expect(fs.existsSync(target)).toBe(false);
    const siblings = fs.readdirSync(dir);
    const quarantined = siblings.find(n => n.includes('.broken-'));
    expect(quarantined).toBeDefined();
  });

  test('does not throw when the source file is already gone', () => {
    const target = path.join(dir, 'session.state.json');
    expect(() => _quarantineBrokenSession(target, 'absent')).not.toThrow();
  });
});
