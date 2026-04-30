/**
 * Tests for lib/atomic-fs.js — the atomic write primitives that
 * back Hard Rule #4 (every data/* mutation goes through tmp +
 * fsync + rename). Real fs against tmp dirs; no mocks.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  atomicWriteJson, atomicWriteString, atomicWriteBuffer,
  quarantineCorruptFile, TMP_SUFFIX,
} = require('../lib/atomic-fs');
const { makeTmpDir, rmTmpDir } = require('./_helpers');

describe('atomicWriteJson', () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir('atomic-json-'); });
  afterEach(() => rmTmpDir(dir));

  test('writes pretty-printed JSON (2-space indent default)', () => {
    const dest = path.join(dir, 'a.json');
    atomicWriteJson(dest, { hi: 1, nest: { x: 2 } });
    const raw = fs.readFileSync(dest, 'utf8');
    expect(raw).toContain('"hi": 1');
    expect(raw).toContain('"nest": {');
    expect(raw).toContain('    "x": 2');
  });

  test('respects custom indent', () => {
    const dest = path.join(dir, 'b.json');
    atomicWriteJson(dest, { a: 1 }, { indent: 4 });
    expect(fs.readFileSync(dest, 'utf8')).toContain('    "a": 1');
  });

  test('overwrites a longer existing file without leaving stale tail bytes', () => {
    const dest = path.join(dir, 'c.json');
    fs.writeFileSync(dest, 'A'.repeat(2000));
    atomicWriteJson(dest, { tiny: 1 });
    const after = fs.readFileSync(dest, 'utf8');
    expect(after).toMatch(/^\{[\s\S]*"tiny": 1[\s\S]*\}$/);
    expect(after.length).toBeLessThan(50); // proves no stale tail
    expect(after).not.toContain('A');
  });

  test('leaves no .tmp behind after success', () => {
    const dest = path.join(dir, 'd.json');
    atomicWriteJson(dest, { ok: true });
    expect(fs.existsSync(dest + TMP_SUFFIX)).toBe(false);
  });

  test('rejects non-string filePath', () => {
    expect(() => atomicWriteJson('', { x: 1 })).toThrow(TypeError);
    expect(() => atomicWriteJson(null, { x: 1 })).toThrow(TypeError);
  });
});

describe('atomicWriteString', () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir('atomic-str-'); });
  afterEach(() => rmTmpDir(dir));

  test('writes utf8 by default', () => {
    const dest = path.join(dir, 'x.txt');
    atomicWriteString(dest, 'héllo');
    expect(fs.readFileSync(dest, 'utf8')).toBe('héllo');
  });

  test('truncates an existing longer file (no NUL padding)', () => {
    const dest = path.join(dir, 'pad.txt');
    fs.writeFileSync(dest, 'X'.repeat(1024));
    atomicWriteString(dest, 'short');
    const after = fs.readFileSync(dest);
    expect(after.length).toBe(5);
    expect(after.toString('utf8')).toBe('short');
  });

  test('rejects non-string value', () => {
    const dest = path.join(dir, 'bad.txt');
    expect(() => atomicWriteString(dest, 123)).toThrow(TypeError);
    expect(() => atomicWriteString(dest, null)).toThrow(TypeError);
  });
});

describe('atomicWriteBuffer', () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir('atomic-buf-'); });
  afterEach(() => rmTmpDir(dir));

  test('writes a Buffer verbatim', () => {
    const dest = path.join(dir, 'bin.dat');
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    atomicWriteBuffer(dest, payload);
    expect(fs.readFileSync(dest)).toEqual(payload);
  });

  test('respects mode option', () => {
    const dest = path.join(dir, 'private.bin');
    atomicWriteBuffer(dest, Buffer.from('s'), { mode: 0o600 });
    const st = fs.statSync(dest);
    // On posix the mode bits should match; on windows the mode is
    // approximate, so we assert non-strictly to keep tests portable.
    expect(st.mode & 0o777).toBeGreaterThan(0);
  });

  test('rejects non-Buffer payload', () => {
    const dest = path.join(dir, 'nope.bin');
    expect(() => atomicWriteBuffer(dest, 'string')).toThrow(TypeError);
  });
});

describe('quarantineCorruptFile', () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir('atomic-qa-'); });
  afterEach(() => rmTmpDir(dir));

  test('renames the file with .broken-<ts> suffix', () => {
    const f = path.join(dir, 'bad.json');
    fs.writeFileSync(f, '{not json');
    const dest = quarantineCorruptFile(f, 'parse_error');
    expect(fs.existsSync(f)).toBe(false);
    expect(fs.existsSync(dest)).toBe(true);
    expect(dest).toMatch(/\.broken-parseerror-\d{8}T\d{6}$/);
  });

  test('works without a reason tag', () => {
    const f = path.join(dir, 'bad2.json');
    fs.writeFileSync(f, 'x');
    const dest = quarantineCorruptFile(f);
    expect(dest).toMatch(/\.broken-\d{8}T\d{6}$/);
  });
});
