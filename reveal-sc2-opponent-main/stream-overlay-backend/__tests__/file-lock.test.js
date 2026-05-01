// @ts-check
/**
 * Tests for stream-overlay-backend/lib/file-lock.js — cross-process
 * lockfile primitive (Node side, mirrors core/file_lock.py).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  withFileLock,
  withFileLockSync,
  FileLockTimeoutError,
  _internals,
  ENABLE_ENV_VAR,
} = require('../lib/file-lock');

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rm(dir) {
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

describe('safeLockName + resolveLockDir', () => {
  test('collapses .bak suffix so live + .bak share the same lock', () => {
    const live = _internals.safeLockName('data/MyOpponentHistory.json');
    const bak = _internals.safeLockName('data/MyOpponentHistory.json.bak');
    expect(live).toBe(bak);
  });

  test('replaces unsafe characters with _', () => {
    const out = _internals.safeLockName('data/has spaces & symbols!.json');
    expect(out).toMatch(/\.lock$/);
    expect(out).not.toMatch(/[ &!]/);
  });

  test('creates the lock dir on demand', () => {
    const tmp = makeTmp('sc2-lock-resolve-');
    try {
      const target = path.join(tmp, 'MyOpponentHistory.json');
      const dir = _internals.resolveLockDir(target);
      expect(fs.existsSync(dir)).toBe(true);
      expect(path.basename(dir)).toBe('.locks');
    } finally { rm(tmp); }
  });
});

describe('isPidAlive', () => {
  test('current process is alive', () => {
    expect(_internals.isPidAlive(process.pid)).toBe(true);
  });

  test('astronomically high PID is dead', () => {
    expect(_internals.isPidAlive(4_000_000_000)).toBe(false);
  });

  test('non-positive / non-integer PIDs are dead', () => {
    expect(_internals.isPidAlive(0)).toBe(false);
    expect(_internals.isPidAlive(-1)).toBe(false);
    expect(_internals.isPidAlive(/** @type {any} */ ('hello'))).toBe(false);
  });
});

describe('withFileLockSync (happy path)', () => {
  test('creates lockfile during work, removes on exit', () => {
    const tmp = makeTmp('sc2-lock-sync-');
    try {
      const target = path.join(tmp, 'MyOpponentHistory.json');
      const lockPath = path.join(tmp, '.locks', _internals.safeLockName(target));
      const inside = withFileLockSync(target, () => {
        expect(fs.existsSync(lockPath)).toBe(true);
        const meta = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        expect(meta.pid).toBe(process.pid);
        expect(meta.lang).toBe('node');
        return 'ok';
      });
      expect(inside).toBe('ok');
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally { rm(tmp); }
  });

  test('releases on thrown exception', () => {
    const tmp = makeTmp('sc2-lock-throw-');
    try {
      const target = path.join(tmp, 'data.json');
      const lockPath = path.join(tmp, '.locks', _internals.safeLockName(target));
      expect(() => withFileLockSync(target, () => {
        throw new Error('boom');
      })).toThrow('boom');
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally { rm(tmp); }
  });
});

describe('withFileLock (async)', () => {
  test('awaits the work and releases on exit', async () => {
    const tmp = makeTmp('sc2-lock-async-');
    try {
      const target = path.join(tmp, 'MyOpponentHistory.json');
      const lockPath = path.join(tmp, '.locks', _internals.safeLockName(target));
      const out = await withFileLock(target, async () => {
        expect(fs.existsSync(lockPath)).toBe(true);
        await new Promise((r) => setTimeout(r, 10));
        return 42;
      });
      expect(out).toBe(42);
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally { rm(tmp); }
  });
});

describe('Stale lock recovery', () => {
  function writeLock(lockPath, { pid, ageSec }) {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const meta = {
      pid, host: 'test', lang: 'node', platform: 'Test',
      since: Date.now() - ageSec * 1000,
      stamp: '2026-05-01T00:00:00Z',
    };
    fs.writeFileSync(lockPath, JSON.stringify(meta), 'utf8');
  }

  test('dead PID is stolen immediately', () => {
    const tmp = makeTmp('sc2-lock-deadpid-');
    try {
      const target = path.join(tmp, 'MyOpponentHistory.json');
      const lockPath = path.join(tmp, '.locks', _internals.safeLockName(target));
      writeLock(lockPath, { pid: 4_000_000_000, ageSec: 1 });
      const t0 = Date.now();
      withFileLockSync(target, () => {
        const meta = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        expect(meta.pid).toBe(process.pid);
      }, { timeoutSec: 2 });
      expect(Date.now() - t0).toBeLessThan(500);
    } finally { rm(tmp); }
  });

  test('age threshold steals even for a live PID', () => {
    const tmp = makeTmp('sc2-lock-age-');
    try {
      const target = path.join(tmp, 'MyOpponentHistory.json');
      const lockPath = path.join(tmp, '.locks', _internals.safeLockName(target));
      writeLock(lockPath, { pid: process.pid, ageSec: 60 });
      const before = Date.now() - 5_000;
      withFileLockSync(target, () => {
        const meta = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        expect(meta.since).toBeGreaterThan(before);
      }, { timeoutSec: 2, staleAfterSec: 5 });
    } finally { rm(tmp); }
  });
});

describe('Timeout behaviour', () => {
  test('contender times out while holder is alive and fresh', async () => {
    const tmp = makeTmp('sc2-lock-timeout-');
    try {
      const target = path.join(tmp, 'MyOpponentHistory.json');
      const childScript = `
        const { withFileLock } = require(${JSON.stringify(path.resolve(__dirname, '../lib/file-lock'))});
        withFileLock(${JSON.stringify(target)}, () => new Promise(r => setTimeout(r, 3000)))
          .then(() => process.exit(0));
      `;
      const child = require('child_process').spawn(process.execPath, ['-e', childScript], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const lockPath = path.join(tmp, '.locks', _internals.safeLockName(target));
      const start = Date.now();
      while (!fs.existsSync(lockPath) && Date.now() - start < 2000) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(fs.existsSync(lockPath)).toBe(true);

      let threw = null;
      const t0 = Date.now();
      try {
        await withFileLock(target, () => 'should-not-run', { timeoutSec: 0.5 });
      } catch (err) { threw = err; }
      const elapsed = Date.now() - t0;
      expect(threw).toBeInstanceOf(FileLockTimeoutError);
      expect(elapsed).toBeGreaterThanOrEqual(400);
      expect(elapsed).toBeLessThan(2000);

      child.kill('SIGKILL');
    } finally { rm(tmp); }
  }, 15_000);
});

describe('Cross-process contention', () => {
  test('two processes do not lose updates under the lock', async () => {
    const tmp = makeTmp('sc2-lock-xproc-');
    try {
      const target = path.join(tmp, 'MyOpponentHistory.json');
      const counter = path.join(tmp, 'counter.json');
      fs.writeFileSync(counter, JSON.stringify({ n: 0 }), 'utf8');
      const nEach = 50;
      const childScript = `
        const fs = require('fs');
        const { withFileLockSync } = require(${JSON.stringify(path.resolve(__dirname, '../lib/file-lock'))});
        for (let i = 0; i < ${nEach}; i++) {
          withFileLockSync(${JSON.stringify(target)}, () => {
            const d = JSON.parse(fs.readFileSync(${JSON.stringify(counter)}, 'utf8'));
            d.n += 1;
            fs.writeFileSync(${JSON.stringify(counter)}, JSON.stringify(d), 'utf8');
          }, { timeoutSec: 20 });
        }
      `;
      const childPromise = new Promise((resolve, reject) => {
        const proc = require('child_process').spawn(
          process.execPath, ['-e', childScript],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('exit', (code) => {
          if (code === 0) resolve(stderr);
          else reject(new Error(`child exit ${code}; stderr=${stderr}`));
        });
      });

      for (let i = 0; i < nEach; i++) {
        withFileLockSync(target, () => {
          const d = JSON.parse(fs.readFileSync(counter, 'utf8'));
          d.n += 1;
          fs.writeFileSync(counter, JSON.stringify(d), 'utf8');
        }, { timeoutSec: 20 });
        await new Promise((r) => setImmediate(r));
      }

      await childPromise;
      const final = JSON.parse(fs.readFileSync(counter, 'utf8')).n;
      expect(final).toBe(2 * nEach);
    } finally { rm(tmp); }
  }, 60_000);
});

describe('Disabled mode (env var)', () => {
  test('SC2TOOLS_DATA_LOCK_ENABLED=0 makes the lock a no-op', () => {
    const tmp = makeTmp('sc2-lock-disabled-');
    const old = process.env[ENABLE_ENV_VAR];
    try {
      process.env[ENABLE_ENV_VAR] = '0';
      const target = path.join(tmp, 'MyOpponentHistory.json');
      withFileLockSync(target, () => 'ran');
      expect(fs.existsSync(path.join(tmp, '.locks'))).toBe(false);
    } finally {
      if (old === undefined) delete process.env[ENABLE_ENV_VAR];
      else process.env[ENABLE_ENV_VAR] = old;
      rm(tmp);
    }
  });
});
