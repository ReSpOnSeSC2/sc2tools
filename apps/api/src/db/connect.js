"use strict";

const { MongoClient } = require("mongodb");
const { COLLECTIONS, TIMEOUTS } = require("../config/constants");

/**
 * @typedef {{
 *   client: MongoClient,
 *   db: import('mongodb').Db,
 *   users: import('mongodb').Collection,
 *   profiles: import('mongodb').Collection,
 *   opponents: import('mongodb').Collection,
 *   games: import('mongodb').Collection,
 *   customBuilds: import('mongodb').Collection,
 *   devicePairings: import('mongodb').Collection,
 *   deviceTokens: import('mongodb').Collection,
 *   overlayTokens: import('mongodb').Collection,
 *   close: () => Promise<void>,
 * }} DbContext
 */

/**
 * Open the MongoDB connection and return collection handles.
 *
 * @param {{ uri: string, dbName: string }} opts
 * @returns {Promise<DbContext>}
 *
 * Example:
 *   const ctx = await connect({ uri: cfg.mongoUri, dbName: cfg.mongoDb });
 */
async function connect({ uri, dbName }) {
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: TIMEOUTS.MONGO_CONNECT_MS,
    socketTimeoutMS: TIMEOUTS.MONGO_SOCKET_MS,
    retryWrites: true,
  });
  await client.connect();
  const db = client.db(dbName);
  const ctx = {
    client,
    db,
    users: db.collection(COLLECTIONS.USERS),
    profiles: db.collection(COLLECTIONS.PROFILES),
    opponents: db.collection(COLLECTIONS.OPPONENTS),
    games: db.collection(COLLECTIONS.GAMES),
    customBuilds: db.collection(COLLECTIONS.CUSTOM_BUILDS),
    devicePairings: db.collection(COLLECTIONS.DEVICE_PAIRINGS),
    deviceTokens: db.collection(COLLECTIONS.DEVICE_TOKENS),
    overlayTokens: db.collection(COLLECTIONS.OVERLAY_TOKENS),
    close: () => client.close(),
  };
  await ensureIndexes(ctx);
  return ctx;
}

/**
 * Idempotent index setup. Safe to call on every boot — Mongo skips
 * indexes that already exist with the same spec.
 *
 * Hot queries we index for:
 *   - opponents browse:   {userId, pulseId}
 *   - games by date:      {userId, date}
 *   - games by opponent:  {userId, oppPulseId, date}
 *   - games dedupe:       {userId, gameId}  (unique)
 *   - device pairings:    {code} (unique, TTL)
 *   - device tokens:      {tokenHash} (unique)
 *   - overlay tokens:     {token} (unique)
 *
 * @param {DbContext} ctx
 */
async function ensureIndexes(ctx) {
  await ctx.users.createIndex({ clerkUserId: 1 }, { unique: true });

  await ctx.opponents.createIndex({ userId: 1, pulseId: 1 }, { unique: true });
  await ctx.opponents.createIndex({ userId: 1, lastSeen: -1 });

  await ctx.games.createIndex({ userId: 1, gameId: 1 }, { unique: true });
  await ctx.games.createIndex({ userId: 1, date: -1 });
  await ctx.games.createIndex({ userId: 1, oppPulseId: 1, date: -1 });

  await ctx.customBuilds.createIndex({ userId: 1, slug: 1 }, { unique: true });
  await ctx.customBuilds.createIndex({ userId: 1, updatedAt: -1 });

  await ctx.devicePairings.createIndex({ code: 1 }, { unique: true });
  await ctx.devicePairings.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },
  );

  await ctx.deviceTokens.createIndex({ tokenHash: 1 }, { unique: true });
  await ctx.deviceTokens.createIndex({ userId: 1, lastSeenAt: -1 });

  await ctx.overlayTokens.createIndex({ token: 1 }, { unique: true });
  await ctx.overlayTokens.createIndex({ userId: 1, createdAt: -1 });
}

module.exports = { connect, ensureIndexes };
