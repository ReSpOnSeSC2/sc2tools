/**
 * Shared Jest harness for the stream-overlay-backend route tests.
 *
 * Goals (per Stage 11.3):
 *   - One place to spin up an Express app pointed at a tmp data dir
 *     seeded with the real schemas / fixtures the route under test
 *     needs. Tests stay focused on assertions, not boilerplate.
 *   - No mocks for data files, schema validation, or fs I/O. Every
 *     write hits a real tmp directory; every JSON parse uses the real
 *     ajv pipeline. Mocks are reserved for `fetch` (external HTTP)
 *     and the Python subprocess spawner (per the audit, only the
 *     analyzer.js spawn helpers — handled separately in games.test.js).
 *   - Deterministic clock + monotonic temp dirs so the same suite
 *     can run a thousand times in CI without flake.
 *
 * Example:
 *   const { makeTmpDir, seedSchemas, makeApp } = require('./_helpers');
 *   const dir = makeTmpDir('profile-');
 *   seedSchemas(dir, ['profile.schema.json']);
 *   const app = makeApp((a) => a.use(myRouter({ dataDir: dir })));
 *
 * Engineering preamble compliance:
 *   - Functions <= 30 lines, narrowest catches, no magic constants.
 *   - No PII in any logged output; helpers never print fixture bodies.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const REAL_DATA_DIR = path.resolve(__dirname, '..', '..', '..', 'data');
const DEFAULT_BODY_LIMIT = '1mb';

/**
 * Create a fresh tmp directory under the OS temp root.
 *
 * Example:
 *   const dir = makeTmpDir('sc2-profile-');
 *
 * @param {string} prefix Friendly prefix for grep-ability in /tmp.
 * @returns {string} Absolute path of the newly created directory.
 */
function makeTmpDir(prefix) {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new TypeError('makeTmpDir: prefix must be a non-empty string');
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Recursively delete a directory tree. Safe no-op if already gone.
 *
 * @param {string} dir Absolute path to remove.
 */
function rmTmpDir(dir) {
  if (!dir || typeof dir !== 'string') return;
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Copy the named schema files from the real data/ dir into `dir`.
 *
 * Tests that boot the settings router need both the .schema.json
 * files present so ajv compiles successfully at router-construction
 * time. We never let tests touch the real data/ -- only read from it.
 *
 * @param {string} dir Destination tmp data dir.
 * @param {string[]} schemas Filenames relative to data/.
 */
function seedSchemas(dir, schemas) {
  if (!Array.isArray(schemas)) {
    throw new TypeError('seedSchemas: schemas must be an array');
  }
  for (const name of schemas) {
    const src = path.join(REAL_DATA_DIR, name);
    if (!fs.existsSync(src)) {
      throw new Error(`seedSchemas: schema not found at ${src}`);
    }
    fs.copyFileSync(src, path.join(dir, name));
  }
}

/**
 * Write a JSON value to <dir>/<name> with the same atomic-ish pattern
 * the production code uses (write -> rename). Tests use this to seed
 * profile.json / config.json / meta_database.json fixtures.
 *
 * @param {string} dir
 * @param {string} name
 * @param {unknown} value JSON-serializable value.
 */
function writeJsonFixture(dir, name, value) {
  const dest = path.join(dir, name);
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, dest);
}

/**
 * Build a fresh Express app, install the JSON body parser at the
 * configured limit, and let the caller mount whatever router(s) the
 * test cares about via the `register` callback.
 *
 * Example:
 *   const app = makeApp((a) =>
 *     a.use(createSettingsRouter({ dataDir })));
 *
 * @param {(app: import('express').Express) => void} register
 * @param {{bodyLimit?: string}} [options]
 * @returns {import('express').Express}
 */
function makeApp(register, options) {
  if (typeof register !== 'function') {
    throw new TypeError('makeApp: register must be a function');
  }
  const limit = (options && options.bodyLimit) || DEFAULT_BODY_LIMIT;
  const app = express();
  app.use(express.json({ limit }));
  register(app);
  return app;
}

/**
 * Build a deterministic monotonic clock for tests that depend on
 * timestamp ordering (e.g. backups, sync queue, version pings).
 *
 * @param {string} startIso ISO-8601 anchor, e.g. "2026-04-29T12:00:00Z".
 * @param {number} [stepMs] Increment per call. Default 60_000.
 * @returns {() => Date}
 */
function makeClock(startIso, stepMs) {
  let next = new Date(startIso).getTime();
  const step = typeof stepMs === 'number' ? stepMs : 60_000;
  return function clock() {
    const value = new Date(next);
    next += step;
    return value;
  };
}

/**
 * Build a fake fetch that records every call and returns canned
 * responses in order. Pushing more responses than calls is fine; the
 * extras are simply unused. A call without a queued response gets
 * a 599 stub so the calling code surfaces a clear test failure.
 *
 * @returns {{
 *   fetch: (url: string, init?: object) => Promise<object>,
 *   calls: Array<{url:string, method?:string, body?:string, headers?:object}>,
 *   queue: Array<object>,
 * }}
 */
function makeFakeFetch() {
  const calls = [];
  const queue = [];
  const fetch = function fakeFetch(url, init) {
    calls.push({
      url: String(url),
      method: init && init.method,
      body: init && init.body,
      headers: init && init.headers,
    });
    const next = queue.shift();
    if (!next) {
      return Promise.resolve({
        ok: false,
        status: 599,
        json: async () => ({ error: 'no_canned_response_in_test' }),
        text: async () => '',
      });
    }
    return Promise.resolve(next);
  };
  return { fetch, calls, queue };
}

/**
 * Convenience: build a canned fetch response with sensible defaults.
 *
 * @param {{status?:number, body?:any, ok?:boolean}} [opts]
 * @returns {object}
 */
function jsonResponse(opts) {
  const o = opts || {};
  const status = typeof o.status === 'number' ? o.status : 200;
  const ok = typeof o.ok === 'boolean' ? o.ok : status >= 200 && status < 300;
  const body = o.body !== undefined ? o.body : {};
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

module.exports = {
  REAL_DATA_DIR,
  makeTmpDir,
  rmTmpDir,
  seedSchemas,
  writeJsonFixture,
  makeApp,
  makeClock,
  makeFakeFetch,
  jsonResponse,
};
