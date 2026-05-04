// @ts-check
/**
 * DATA STUB CREATION ON STARTUP
 * ============================================================
 * Friend's-install fix: on a fresh clone the data files
 * MyOpponentHistory.json / meta_database.json / custom_builds.json
 * don't exist until the watcher / poller / bulk-import runs. The
 * analyzer endpoints silently return [] when those files are
 * missing, which surfaces as the "No data" empty state in the SPA
 * with no path forward for the user.
 *
 * ensureDataStubs() creates VALID empty stubs at startup so:
 *   - Endpoints never see the missing-file branch.
 *   - The SPA's empty-state CTAs (components/empty-states.jsx) can
 *     check the file shape and render the right "Import replays"
 *     or "Start poller" guidance.
 *   - When the live data arrives later, the watcher overwrites the
 *     stub through the same atomic-fs path -- no migration needed.
 *
 * config.json is INTENTIONALLY NOT stubbed: its absence is the
 * first-run signal the wizard at index.html:2135-2147 reads
 * (/api/profile/exists 404 -> setShowWizard(true)).
 *
 * Schema notes:
 *   - meta_database.json is a flat object keyed by build name.
 *     {} is a valid empty document.
 *   - MyOpponentHistory.json is keyed by SC2Pulse character ID.
 *     {} is a valid empty document.
 *   - custom_builds.json schema (data/custom_builds.schema.json)
 *     requires { version: 3, builds: [] } -- v3 introduced in Stage
 *     7.5b. Older v2 files auto-migrate; the v3 stub matches the
 *     schema exactly so ajv validation in routes/custom-builds.js
 *     passes on a fresh install.
 *
 * Idempotency: every stub is gated behind fs.existsSync, so a
 * restart on a populated install is a no-op. Atomic writes use the
 * same pattern as every other data/* mutation (Hard Rule #4).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const atomicFs = require('./atomic-fs');

const META_DB_FILENAME = 'meta_database.json';
const OPP_HISTORY_FILENAME = 'MyOpponentHistory.json';
const CUSTOM_BUILDS_FILENAME = 'custom_builds.json';

const CUSTOM_BUILDS_SCHEMA_VERSION = 3;

const STUBS = Object.freeze([
  Object.freeze({ name: META_DB_FILENAME, contents: {} }),
  Object.freeze({ name: OPP_HISTORY_FILENAME, contents: {} }),
  Object.freeze({
    name: CUSTOM_BUILDS_FILENAME,
    contents: { version: CUSTOM_BUILDS_SCHEMA_VERSION, builds: [] },
  }),
]);

/**
 * Create the data directory and any missing data-file stubs.
 *
 * Safe to call on every backend startup: present files are left
 * untouched. Throws only if the data directory itself can't be
 * created (which would mean the install is on a read-only volume,
 * a fatal precondition we want to surface immediately).
 *
 * @param {string} dataDir Absolute path to the data/ directory.
 * @returns {{ created: string[], skipped: string[] }}
 */
function ensureDataStubs(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir) {
    throw new TypeError('ensureDataStubs: dataDir must be a non-empty string');
  }
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const created = [];
  const skipped = [];
  for (const stub of STUBS) {
    const target = path.join(dataDir, stub.name);
    if (fs.existsSync(target)) {
      skipped.push(stub.name);
      continue;
    }
    atomicFs.atomicWriteJson(target, stub.contents);
    created.push(stub.name);
  }
  return { created, skipped };
}

module.exports = { ensureDataStubs };
