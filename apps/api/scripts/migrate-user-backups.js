#!/usr/bin/env node
"use strict";

const { loadConfig } = require("../src/config/loader");
const { connect } = require("../src/db/connect");
const { GdprService } = require("../src/services/gdpr");
const { UserBackupsService } = require("../src/services/userBackups");
const { buildUserBackupsStore } = require("../src/services/userBackupsStore");

/** Dry-run by default. No legacy payload is removed until its gzip object has
 * completed and its metadata update succeeds. Same IDs and creation dates stay
 * usable; restarting skips converted rows. One legacy Mongo document is loaded
 * at a time. Never run a restore as a migration verification step.
 * @param {string[]} args
 */
async function main(args) {
  if (args.includes("--help")) { process.stdout.write("Usage: node scripts/migrate-user-backups.js [--apply]\nDefault: read-only count. --apply streams legacy payloads to the configured private R2 bucket.\n"); return; }
  if (args.some((arg) => arg !== "--apply")) throw new Error("Unknown argument; use --help");
  const config = loadConfig(); const db = await connect({ uri: config.mongoUri, dbName: config.mongoDb });
  try {
    const total = await db.userBackups.countDocuments({ payload: { $exists: true } });
    process.stdout.write(`Legacy backups: ${total}. Mode: ${args.includes("--apply") ? "apply" : "dry-run"}.\n`);
    if (!args.includes("--apply")) return;
    const store = buildUserBackupsStore(config); if (!store) throw new Error("backups_unavailable: configure R2 before applying");
    const gdpr = new GdprService(db); const backups = new UserBackupsService(db, { gdpr, store }); gdpr.backups = backups;
    let migrated = 0;
    for await (const row of db.userBackups.find({ payload: { $exists: true } }, { projection: { userId: 1, id: 1 } }).batchSize(1)) {
      const fence = await gdpr._acquireMutationFence(row.userId, "migrate_backup");
      try { await backups.migrateLegacy(row.userId, row.id, fence.assert); migrated += 1; }
      finally { await gdpr._releaseMutationFence(row.userId, fence); }
    }
    process.stdout.write(`Migrated ${migrated} backups. No restore was executed.\n`);
  } finally { await db.close(); }
}
if (require.main === module) void main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { main };
