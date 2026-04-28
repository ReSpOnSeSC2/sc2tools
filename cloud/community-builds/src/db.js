"use strict";

const { MongoClient } = require("mongodb");
const { COLLECTIONS } = require("./constants");

const CONNECT_TIMEOUT_MS = 5000;
const SOCKET_TIMEOUT_MS = 30000;

/**
 * Connect to MongoDB and return helpers for the configured DB and collections.
 *
 * @param {{ uri: string, dbName: string }} opts
 * @returns {Promise<{
 *   client: MongoClient,
 *   db: import('mongodb').Db,
 *   builds: import('mongodb').Collection,
 *   votes: import('mongodb').Collection,
 *   flags: import('mongodb').Collection,
 *   close: () => Promise<void>,
 * }>}
 *
 * Example:
 *   const ctx = await connect({ uri: cfg.mongoUri, dbName: cfg.mongoDb });
 *   await ctx.builds.findOne({ id: "abc" });
 *   await ctx.close();
 */
async function connect({ uri, dbName }) {
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    socketTimeoutMS: SOCKET_TIMEOUT_MS,
    retryWrites: true,
  });
  await client.connect();
  const db = client.db(dbName);
  const ctx = {
    client,
    db,
    builds: db.collection(COLLECTIONS.BUILDS),
    votes: db.collection(COLLECTIONS.VOTES),
    flags: db.collection(COLLECTIONS.FLAGS),
    close: () => client.close(),
  };
  await ensureIndexes(ctx);
  return ctx;
}

/**
 * Idempotent index setup. Safe to run on every boot.
 *
 * @param {{ builds: import('mongodb').Collection,
 *           votes: import('mongodb').Collection,
 *           flags: import('mongodb').Collection }} ctx
 * @returns {Promise<void>}
 */
async function ensureIndexes(ctx) {
  await ctx.builds.createIndex({ id: 1 }, { unique: true });
  await ctx.builds.createIndex({ race: 1, vsRace: 1 });
  await ctx.builds.createIndex({ updatedAt: 1 });
  await ctx.builds.createIndex({ deletedAt: 1 });
  await ctx.votes.createIndex({ clientId: 1, buildId: 1 }, { unique: true });
  await ctx.flags.createIndex({ clientId: 1, buildId: 1 }, { unique: true });
}

module.exports = { connect, ensureIndexes };
