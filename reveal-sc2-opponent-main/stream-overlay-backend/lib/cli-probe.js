// @ts-check
/**
 * PYTHON CLI VERSION/AVAILABILITY PROBE
 * ============================================================
 * Friend's-install fix: when the Express backend invokes
 * ``py scripts/macro_cli.py compute`` against a stale checkout that
 * only registers ``backfill``, argparse emits the cryptic
 *
 *   macro_cli: error: argument cmd: invalid choice: 'compute'
 *   (choose from 'backfill')
 *
 * which then bubbles up as raw stderr in the SPA modal. probeCli()
 * runs ``py scripts/<cli>.py --help`` once, parses out the
 * registered subcommands, and rejects ALL subsequent invocations
 * with a typed CliVersionError that carries an actionable fix hint
 * the SPA can render verbatim.
 *
 * Caching: 5-minute TTL per cli name. The probe spawns a python
 * process which is heavy (~150ms cold), so we never want to do it
 * per request. clearCliProbeCache() lets routes/doctor.js force a
 * fresh probe when the user clicks Refresh on the diagnostics
 * banner.
 *
 * Argparse output shape:
 *
 *   usage: macro_cli [-h] {backfill,compute} ...
 *
 *   positional arguments:
 *     {backfill,compute}
 *       backfill            Import .SC2Replay files into ...
 *       compute             Recompute macro breakdown for ...
 *
 * The {a,b,c} braces appear on both the usage and the positional
 * line, so we anchor on either. The regex tolerates whitespace and
 * any number of choices. argparse always emits this shape for
 * required=True subparsers (which both macro_cli and apm_cli use).
 *
 * Engineering preamble compliance:
 *   - Functions <= 30 lines, complexity <= 10.
 *   - JSDoc types, validated by tsc --checkJs.
 *   - Narrow catches (no swallowed exceptions).
 *   - No magic numbers; all timeouts/TTLs are named constants.
 */

'use strict';

const path = require('path');
const { spawn } = require('child_process');

const PROBE_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 5 * 60_000;
const SUBCOMMAND_RE = /\{([a-zA-Z0-9_,\s-]+)\}/;

const cache = new Map();

class CliVersionError extends Error {
  /**
   * @param {string} cli      The CLI name (e.g. 'macro_cli').
   * @param {string[]} missing Subcommands required but not registered.
   */
  constructor(cli, missing) {
    const list = missing.join(', ');
    super(
      `${cli}.py is missing required subcommand(s) [${list}]. `
      + 'Your install is out of date. Re-run START_SC2_TOOLS.bat '
      + '(it will reinstall dependencies), or manually: '
      + 'cd stream-overlay-backend && npm ci && cd .. && py -m pip install -r requirements.txt'
    );
    this.name = 'CliVersionError';
    this.kind = 'cli_version_stale';
    this.cli = cli;
    this.missing = missing;
  }
}

/**
 * Spawn ``<pythonExe> scripts/<cliName>.py --help`` and resolve with
 * the captured stdout. Always rejects on a non-zero exit (argparse
 * prints --help on stdout and exits 0) or on the timeout firing.
 *
 * @param {string} pythonExe  Python launcher (e.g. 'py').
 * @param {string} projectDir Working dir; the spawned process resolves
 *                            ``scripts/<cli>.py`` relative to this.
 * @param {string} cliName    CLI base name without .py.
 * @returns {Promise<string>} Captured stdout on success.
 */
function spawnHelp(pythonExe, projectDir, cliName) {
  return new Promise((resolve, reject) => {
    const scriptRel = path.join('scripts', `${cliName}.py`);
    const proc = spawn(pythonExe, [scriptRel, '--help'], {
      cwd: projectDir,
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`probe timed out after ${PROBE_TIMEOUT_MS}ms`));
    }, PROBE_TIMEOUT_MS);
    proc.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    proc.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(
          stderr.trim() || `${cliName}.py --help exited ${code}`
        ));
      }
      resolve(stdout);
    });
  });
}

/**
 * Extract the registered subcommand names from --help output.
 * Returns an empty array if no {a,b,c} block is found (which means
 * the script doesn't use argparse subparsers; the caller decides
 * whether that's an error).
 *
 * @param {string} helpText
 * @returns {string[]}
 */
function parseSubcommands(helpText) {
  const m = helpText.match(SUBCOMMAND_RE);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Probe a CLI for the presence of required subcommands. Memoised
 * with a 5-minute TTL keyed on cli name + project dir so successive
 * route handlers share one spawn.
 *
 * @param {object} args
 * @param {string} args.pythonExe
 * @param {string} args.projectDir
 * @param {string} args.cliName
 * @param {string[]} args.required
 * @returns {Promise<{ ok: boolean, found: string[], missing: string[], error?: string }>}
 */
async function probeCli(args) {
  const { pythonExe, projectDir, cliName, required } = args;
  const key = `${cliName}::${projectDir}`;
  const hit = cache.get(key);
  if (hit && (Date.now() - hit.t) < CACHE_TTL_MS) return hit.value;

  let value;
  try {
    const helpText = await spawnHelp(pythonExe, projectDir, cliName);
    const found = parseSubcommands(helpText);
    const missing = required.filter((s) => !found.includes(s));
    value = { ok: missing.length === 0, found, missing };
  } catch (err) {
    value = {
      ok: false,
      found: [],
      missing: required.slice(),
      error: err && err.message ? err.message : String(err),
    };
  }
  cache.set(key, { t: Date.now(), value });
  return value;
}

/**
 * Reject with CliVersionError when probeCli finds missing subcommands;
 * resolve to the probe result otherwise. Lets call sites use a single
 * await without re-checking ok.
 *
 * @param {object} args     Same shape as probeCli args.
 * @returns {Promise<{ ok: true, found: string[], missing: string[] }>}
 * @throws {CliVersionError}
 */
async function ensureCliReady(args) {
  const result = await probeCli(args);
  if (result.ok) return result;
  throw new CliVersionError(args.cliName, result.missing);
}

/** Drop all cached probe results -- next call re-spawns --help. */
function clearCliProbeCache() {
  cache.clear();
}

module.exports = {
  CliVersionError,
  probeCli,
  ensureCliReady,
  clearCliProbeCache,
  // exported for tests
  parseSubcommands,
  PROBE_TIMEOUT_MS,
  CACHE_TTL_MS,
};
