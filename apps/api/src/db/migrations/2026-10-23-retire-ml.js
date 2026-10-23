"use strict";

const { MongoClient } = require("mongodb");

const RETIRED_COLLECTIONS = Object.freeze(["ml_models", "ml_jobs"]);

/** Forward-only cleanup approved by the owner; never removes game data.
 * @param {import('mongodb').Db} db
 * @param {{dryRun?: boolean}} [options]
 */
async function retireMlCollections(db, { dryRun = false } = {}) {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((row) => row.name));
  const result = [];
  for (const name of RETIRED_COLLECTIONS) {
    if (!existing.has(name)) continue;
    const documents = await db.collection(name).countDocuments({});
    if (!dryRun) {
      try { await db.collection(name).drop(); }
      catch (err) {
        if (/** @type {any} */ (err).code !== 26) throw err;
      }
    }
    result.push({ collection: name, documents, dropped: !dryRun });
  }
  return result;
}

async function main() {
  const uri = process.env.MONGODB_URI;
  const database = process.env.MONGODB_DB;
  if (!uri || !database) throw new Error("MONGODB_URI and MONGODB_DB are required.");
  const client = new MongoClient(uri);
  try {
    await client.connect();
    process.stdout.write(`${JSON.stringify(await retireMlCollections(client.db(database), {
      dryRun: process.argv.includes("--dry-run"),
    }))}\n`);
  } finally { await client.close(); }
}

if (require.main === module) main().catch(() => {
  console.error("ML retirement failed. Check database connectivity and permissions.");
  process.exitCode = 1;
});

module.exports = { retireMlCollections, RETIRED_COLLECTIONS };
