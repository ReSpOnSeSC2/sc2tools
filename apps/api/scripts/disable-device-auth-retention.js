#!/usr/bin/env node
"use strict";

/**
 * Durably disable device-auth retention: the rollback and manual-edit barrier ADR 0072 requires before any activation.
 * It sets the exact credential authority incarnation to the non-granting "prepared" mode with a fresh generation, then
 * waits out the old lease bound (2.1 s) before reporting. It never activates retention, never clears pending credential
 * work or denyAll, and no route, endpoint or flag reaches it. Owner-run only.
 *
 * Usage (run with the API's env: MONGODB_URI + MONGODB_DB):
 *   node scripts/disable-device-auth-retention.js
 *   node scripts/disable-device-auth-retention.js --incarnation <uuid> --apply
 *
 * Without --apply it is a dry run: it prints the host, the database and the authority record's incarnation, mode and
 * pending count, and writes nothing. With --apply, --incarnation must name the current incarnation exactly; a mismatch
 * changes nothing. Exit codes: 0 dry run or disabled; 1 refused (no matching incarnation, or no record to disable) or
 * failed before any write; 2 usage; 3 outcome unknown after the write was attempted (the record may be disabled, so
 * rerun the dry run to read its mode).
 */

const { MongoClient } = require("mongodb");
const { DeviceCredentialWrites, AUTHORITY_KEY } = require("../src/services/deviceCredentialWrites");

/** @param {string[]} argv @param {import('mongodb').Db} db @param {(line: string) => void} [log] */
async function main(argv, db, log = line => { process.stdout.write(`${line}\n`); }) {
  const apply = argv.includes("--apply"), at = argv.indexOf("--incarnation");
  const incarnation = at >= 0 ? argv[at + 1] : undefined;
  /** @type {import('mongodb').Collection<import('../src/services/deviceCredentialWrites').CredentialAuthority>} */
  const collection = /** @type {any} */ (db.collection("jobLocks", { readConcern: { level: "majority" } }));
  log(`Database ${db.databaseName}.`);
  const row = await collection.findOne({ _id: AUTHORITY_KEY });
  if (!row) { log("No credential authority record exists in this database; there is nothing to disable."); return apply ? 1 : 0; }
  log(`Authority incarnation ${row.incarnation}: mode ${row.mode}, denyAll ${row.denyAll}, ${Array.isArray(row.pending) ? row.pending.length : "?"} pending.`);
  if (!apply) { log("Dry run; nothing written. Pass --incarnation <the incarnation above> --apply to disable."); return 0; }
  if (!incarnation) { log("--apply needs --incarnation <uuid>."); return 2; }
  const logger = { warn: (/** @type {any} */ fields, /** @type {string} */ message) => log(`${message}: ${fields?.err?.message ?? "no detail"}`) };
  try {
    const result = await new DeviceCredentialWrites(collection, { logger }).disable({ incarnation });
    log(`Outcome: ${result.outcome}${result.generation ? ` (generation ${result.generation})` : ""}.`);
    return { disabled: 0, refused: 1, "possibly-disabled": 3 }[result.outcome];
  } catch (error) {
    const code = /** @type {any} */ (error).code;
    if (code === "device_credential_disable_invalid") { log("--incarnation must be a UUID."); return 2; }
    // Every other failure follows the write attempt, so the record may already be disabled.
    log(`Outcome unknown (${code || /** @type {any} */ (error).message}); the record may be disabled. Rerun the dry run to read its mode.`);
    return 3;
  }
}

/** The URI's host list without credentials, for the operator to confirm. @param {string} uri */
function hostOf(uri) {
  const match = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/.exec(uri);
  return match ? match[1] : "unparsed";
}

if (require.main === module) {
  const uri = process.env.MONGODB_URI, dbName = process.env.MONGODB_DB || "sc2tools_saas";
  if (!uri) { console.error("MONGODB_URI is required."); process.exitCode = 2; }
  else {
    console.log(`Host ${hostOf(uri)}.`);
    const client = new MongoClient(uri);
    client.connect().then(() => main(process.argv.slice(2), client.db(dbName)))
      .then(code => { process.exitCode = code; }, error => { console.error(`Failed before any write: ${error.message}`); process.exitCode = 1; })
      .finally(() => client.close());
  }
}

module.exports = { main, hostOf };
