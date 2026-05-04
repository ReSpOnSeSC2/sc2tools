// @ts-check
'use strict';

/**
 * STAGE 3 + STAGE 7 INTEGRATION TEST -- 3-process cross-language lock
 * ===================================================================
 * Three independent processes (Python, Node, PowerShell) each take
 * the cross-process file lock and append a counter to a shared
 * fixture. With the lock honoured everywhere the final counter is the
 * sum of every increment; without it we would observe lost updates.
 *
 * The test runs against the canonical lockfile contract documented
 * in core/file_lock.py, lib/file-lock.js, and lib/Lock-FileAtomic.ps1.
 *
 * Skips the PowerShell leg automatically when not on Windows or when
 * `powershell.exe` cannot be located.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { withFileLockSync } = require('../../lib/file-lock');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PY_LOCK_MOD = 'core.file_lock';
const PS_LIB_PATH = path.join(REPO_ROOT, 'lib', 'Lock-FileAtomic.ps1');
// Lower-than-thunderdome iteration count -- this test exists to prove
// CORRECTNESS of the cross-language lockfile contract (no lost updates),
// not to benchmark throughput. PS 5.1's ConvertFrom-Json is enormously
// slower than Python's json or Node's JSON.parse, so a higher iteration
// count starves the PS contender even though the lock works fine. With
// 10 iterations per writer and 4 writers we still see ~40 contended
// acquisitions per run, plenty to surface any race regression.
const N_EACH = 10;
const ITER_TIMEOUT_SEC = 60;
const TEST_TIMEOUT_MS = 120_000;

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sc2-xproc-'));
}
function rmTmp(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}
function readN(counterPath) {
  return JSON.parse(fs.readFileSync(counterPath, 'utf8')).n;
}

function whichPython() {
  // Prefer 'python' (the launcher / matches MEMORY note: python3 is a
  // Microsoft Store stub on this box). Fallbacks for *nix: python3.
  const candidates = process.platform === 'win32'
    ? ['python', 'py', 'python3']
    : ['python3', 'python'];
  for (const exe of candidates) {
    try {
      const out = cp.spawnSync(exe, ['-c', 'import sys; print(sys.version_info[:2])'], {
        encoding: 'utf8',
      });
      if (out.status === 0) return exe;
    } catch (_) { /* try next */ }
  }
  return null;
}

function whichPowerShell() {
  if (process.platform !== 'win32') return null;
  const candidates = ['pwsh', 'powershell'];
  for (const exe of candidates) {
    try {
      const out = cp.spawnSync(exe, ['-NoProfile', '-Command', 'Write-Host pong'], {
        encoding: 'utf8',
      });
      if (out.status === 0) return exe;
    } catch (_) { /* try next */ }
  }
  return null;
}

function spawnNodeWriter(target, counter) {
  const childScript = `
    const fs = require('fs');
    const { withFileLockSync } = require(${JSON.stringify(path.resolve(__dirname, '../../lib/file-lock'))});
    for (let i = 0; i < ${N_EACH}; i++) {
      withFileLockSync(${JSON.stringify(target)}, () => {
        const d = JSON.parse(fs.readFileSync(${JSON.stringify(counter)}, 'utf8'));
        d.n += 1;
        fs.writeFileSync(${JSON.stringify(counter)}, JSON.stringify(d), 'utf8');
      }, { timeoutSec: ${ITER_TIMEOUT_SEC} });
    }
  `;
  return new Promise((resolve, reject) => {
    const proc = cp.spawn(process.execPath, ['-e', childScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('exit', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`node child exit ${code}; stderr=${stderr}`));
    });
  });
}

function spawnPythonWriter(pyExe, target, counter) {
  const code = `
import json, os, sys
sys.path.insert(0, ${JSON.stringify(REPO_ROOT)})
from ${PY_LOCK_MOD} import file_lock

target = ${JSON.stringify(target)}
counter = ${JSON.stringify(counter)}
for _ in range(${N_EACH}):
    with file_lock(target, timeout_sec=${ITER_TIMEOUT_SEC}):
        with open(counter, 'r', encoding='utf-8') as f:
            d = json.load(f)
        d['n'] = d.get('n', 0) + 1
        with open(counter, 'w', encoding='utf-8') as f:
            json.dump(d, f)
`;
  return new Promise((resolve, reject) => {
    const proc = cp.spawn(pyExe, ['-c', code], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('exit', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`python child exit ${code}; stderr=${stderr}`));
    });
  });
}

function spawnPowerShellWriter(psExe, target, counter) {
  // We deliberately use [System.IO.File]::WriteAllBytes with a no-BOM
  // UTF8 encoding because PS5.1's Set-Content -Encoding UTF8 writes a
  // BOM, which makes the Python and Node readers (json.load /
  // JSON.parse) reject the file. Cross-language coordination requires
  // BOM-free UTF-8 on both reads AND writes.
  const psScript = `
$ErrorActionPreference = 'Stop'
. ${JSON.stringify(PS_LIB_PATH)}
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
for ($i = 0; $i -lt ${N_EACH}; $i++) {
    Lock-FileAtomic -TargetPath ${JSON.stringify(target)} -TimeoutSec ${ITER_TIMEOUT_SEC} -ScriptBlock {
        $raw = [System.IO.File]::ReadAllText(${JSON.stringify(counter)}, $utf8NoBom)
        $obj = $raw | ConvertFrom-Json
        $n = if ($null -ne $obj.n) { [int]$obj.n } else { 0 }
        $next = @{ n = $n + 1 } | ConvertTo-Json -Compress
        [System.IO.File]::WriteAllText(${JSON.stringify(counter)}, $next, $utf8NoBom)
    }
}
`;
  return new Promise((resolve, reject) => {
    const proc = cp.spawn(psExe, ['-NoProfile', '-Command', psScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('exit', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`powershell child exit ${code}; stderr=${stderr}`));
    });
  });
}

describe('Cross-language file lock contention', () => {
  test('Python + Node + PowerShell each contribute every increment', async () => {
    const pyExe = whichPython();
    const psExe = whichPowerShell();
    const tmp = makeTmp();
    try {
      const target = path.join(tmp, 'MyOpponentHistory.json');
      const counter = path.join(tmp, 'counter.json');
      // Use openSync+fsync so the bytes are durable BEFORE we spawn any
      // child -- on Windows, otherwise, a child process can race the
      // parent's writeFileSync flush and observe ENOENT.
      const initFd = fs.openSync(counter, 'w');
      fs.writeSync(initFd, JSON.stringify({ n: 0 }), 0, 'utf8');
      fs.fsyncSync(initFd);
      fs.closeSync(initFd);

      const writers = [];
      // (label, promise) so a failure tells us which writer died.
      writers.push(['node-child', spawnNodeWriter(target, counter)]);
      if (pyExe) {
        writers.push(['python', spawnPythonWriter(pyExe, target, counter)]);
      }
      if (psExe) {
        writers.push(['powershell', spawnPowerShellWriter(psExe, target, counter)]);
      }
      const totalWriters = writers.length + 1; // +1 for the parent Node loop

      // Surface which writers were enabled so a passing test on a CI
      // box without Python or PowerShell doesn't silently degrade to
      // a Node-only test that wouldn't have caught the cross-language
      // bug we are guarding against.
      const enabledWriters = writers.map(([label]) => label).join(',') || '(none)';
      console.log('[cross-proc-lock] writers enabled:', enabledWriters,
        '| total (incl. parent):', totalWriters);

      // Parent Node writer in this process exercises the in-process
      // withFileLockSync path. We wait 1.5s before starting so the
      // PowerShell child has time to spawn and start contending --
      // PS5.1 startup is much slower than node/python and without
      // this delay the PS writer would run alone after the others
      // finished, missing the cross-language contention path we are
      // trying to verify.
      const parentPromise = (async () => {
        await new Promise((r) => setTimeout(r, 1500));
        for (let i = 0; i < N_EACH; i++) {
          withFileLockSync(target, () => {
            const d = JSON.parse(fs.readFileSync(counter, 'utf8'));
            d.n += 1;
            fs.writeFileSync(counter, JSON.stringify(d), 'utf8');
          }, { timeoutSec: ITER_TIMEOUT_SEC });
          await new Promise((r) => setImmediate(r));
        }
      })();

      // Use allSettled so cleanup waits for EVERY writer to exit,
      // even if one fails. Then surface the first failure (if any)
      // with a useful error message before checking the counter.
      const settled = await Promise.allSettled([
        parentPromise,
        ...writers.map(([, p]) => p),
      ]);
      const failures = settled
        .map((r, idx) => ({ result: r, label: idx === 0 ? 'parent-node' : writers[idx - 1][0] }))
        .filter(({ result }) => result.status === 'rejected');
      if (failures.length) {
        const reason = failures.map((f) => `${f.label}: ${f.result.reason && f.result.reason.message}`).join(' | ');
        throw new Error('writer failure(s): ' + reason);
      }

      const final = readN(counter);
      expect(final).toBe(totalWriters * N_EACH);

      // No leftover lockfiles after all writers released.
      const lockDir = path.join(tmp, '.locks');
      const leftover = fs.existsSync(lockDir)
        ? fs.readdirSync(lockDir).filter((f) => f.endsWith('.lock'))
        : [];
      expect(leftover).toEqual([]);
    } finally {
      rmTmp(tmp);
    }
  }, TEST_TIMEOUT_MS);
});
