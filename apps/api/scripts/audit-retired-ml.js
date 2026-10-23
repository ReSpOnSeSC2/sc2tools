"use strict";

const { MongoClient } = require("mongodb");

/** Read-only inventory. Collection deletion needs the owner's explicit approval.
 * @param {import('mongodb').Db} db
 */
async function auditRetiredMl(db) {
  const retired = ["ml_models", "ml_jobs"];
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((row) => row.name));
  return Promise.all(retired.map(async (name) => ({
    collection: name,
    exists: existing.has(name),
    documents: existing.has(name) ? await db.collection(name).countDocuments({}) : 0,
  })));
}

async function main() {
  const uri = process.env.MONGODB_URI;
  const database = process.env.MONGODB_DB;
  if (!uri || !database) throw new Error("MONGODB_URI and MONGODB_DB are required.");
  const client = new MongoClient(uri);
  try {
    await client.connect();
    process.stdout.write(`${JSON.stringify(await auditRetiredMl(client.db(database)))}\n`);
  } finally { await client.close(); }
}

if (require.main === module) main().catch(() => {
  console.error("Retired ML audit failed. Check database connectivity and permissions.");
  process.exitCode = 1;
});

module.exports = { auditRetiredMl };
