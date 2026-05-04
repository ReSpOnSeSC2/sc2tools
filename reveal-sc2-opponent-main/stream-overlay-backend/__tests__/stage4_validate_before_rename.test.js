// @ts-check
'use strict';

/**
 * Stage 4 of STAGE_DATA_INTEGRITY_ROADMAP -- validate-before-rename
 * gate added to lib/atomic-fs.js atomicWriteJson.
 *
 * Pins:
 *   * A clean write to a tracked file passes the gate cleanly.
 *   * Shrinkage wipe (live=300 -> candidate=2) is rejected; live
 *     file untouched.
 *   * Untracked basenames bypass the floor but still get the round-
 *     trip + shape check.
 *   * SC2TOOLS_INTEGRITY_FLOORS=0 disables the floor.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  atomicWriteJson,
  DataIntegrityError,
  INTEGRITY_FLOORS_ENV_VAR,
} = require('../lib/atomic-fs');

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sc2-stage4-'));
}
function rmTmp(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* */ }
}

describe('Stage 4 validate-before-rename gate (atomicWriteJson)', () => {
  test('publishes a clean tracked-file write', () => {
    const tmp = makeTmp();
    try {
      const p = path.join(tmp, 'MyOpponentHistory.json');
      const big = {};
      for (let i = 0; i < 150; i++) big[String(i)] = { Name: 'P' + i };
      atomicWriteJson(p, big);
      const back = JSON.parse(fs.readFileSync(p, 'utf8'));
      expect(Object.keys(back).length).toBe(150);
    } finally { rmTmp(tmp); }
  });

  test('shrinkage floor rejects wipe', () => {
    const tmp = makeTmp();
    try {
      const p = path.join(tmp, 'MyOpponentHistory.json');
      const big = {};
      for (let i = 0; i < 300; i++) big[String(i)] = { Name: 'P' + i };
      atomicWriteJson(p, big);

      let err = null;
      try {
        atomicWriteJson(p, { x: 1, y: 2 });
      } catch (e) { err = e; }
      expect(err).toBeInstanceOf(DataIntegrityError);

      // Live file unchanged.
      const back = JSON.parse(fs.readFileSync(p, 'utf8'));
      expect(Object.keys(back).length).toBe(300);

      // No leftover .tmp file.
      const leftovers = fs.readdirSync(tmp).filter((n) => n.endsWith('.tmp'));
      expect(leftovers).toEqual([]);
    } finally { rmTmp(tmp); }
  });

  test('untracked basename bypasses floor (still parses round-trip)', () => {
    const tmp = makeTmp();
    try {
      const p = path.join(tmp, 'random_unknown.json');
      const big = {};
      for (let i = 0; i < 150; i++) big[String(i)] = i;
      atomicWriteJson(p, big);
      // Drop to 2 keys -- floor doesn't apply (untracked).
      atomicWriteJson(p, { a: 1, b: 2 });
      const back = JSON.parse(fs.readFileSync(p, 'utf8'));
      expect(Object.keys(back).length).toBe(2);
    } finally { rmTmp(tmp); }
  });

  test('SC2TOOLS_INTEGRITY_FLOORS=0 disables the floor', () => {
    const tmp = makeTmp();
    const old = process.env[INTEGRITY_FLOORS_ENV_VAR];
    try {
      const p = path.join(tmp, 'MyOpponentHistory.json');
      const big = {};
      for (let i = 0; i < 300; i++) big[String(i)] = { Name: 'P' + i };
      atomicWriteJson(p, big);
      process.env[INTEGRITY_FLOORS_ENV_VAR] = '0';
      atomicWriteJson(p, { x: 1 });
      const back = JSON.parse(fs.readFileSync(p, 'utf8'));
      expect(Object.keys(back).length).toBe(1);
    } finally {
      if (old === undefined) delete process.env[INTEGRITY_FLOORS_ENV_VAR];
      else process.env[INTEGRITY_FLOORS_ENV_VAR] = old;
      rmTmp(tmp);
    }
  });
});
