"use strict";

const { createHash, randomBytes, randomUUID } = require("crypto");

const DEFAULT_MAX_OPERATIONS = 4096;
const DEFAULT_MAX_DAILY_OPERATIONS = 20;
const MAX_INTENT_BYTES = 16_384;
const WRITE_OPTIONS = Object.freeze({ writeConcern: { w: /** @type {'majority'} */ ("majority") } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,128}$/;

class YoutubeCreateOperationError extends Error {
  /** @param {string} code @param {number} status */
  constructor(code, status = 409) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/** @param {string} value */
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {unknown} value @param {number} depth @returns {any} */
function canonical(value, depth = 0) {
  if (depth > 12) throw new YoutubeCreateOperationError("youtube_intent_invalid", 400);
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.length <= 128) {
    return value.map((item) => canonical(item, depth + 1));
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value).sort();
    if (keys.length > 128 || keys.some((key) => ["__proto__", "constructor", "prototype"].includes(key))) {
      throw new YoutubeCreateOperationError("youtube_intent_invalid", 400);
    }
    return Object.fromEntries(keys.map((key) => [key, canonical(/** @type {Record<string,unknown>} */ (value)[key], depth + 1)]));
  }
  throw new YoutubeCreateOperationError("youtube_intent_invalid", 400);
}

/**
 * @typedef {{userId:string,operationId:string,intent:Record<string,any>,expectedChannelId:string}} CreateArgs
 * @typedef {{userId:string,operationId:string,intent?:Record<string,any>,expectedChannelId:string}} LookupArgs
 * @typedef {{phase:'succeeded'|'uncertain',operationId:string,broadcast?:Record<string,any>}} CreateResult
 */

/** @param {LookupArgs} args */
function normalizeIdentity(args) {
  if (!args || typeof args.userId !== "string" || !args.userId || args.userId.length > 256
      || args.userId.includes("\0") || typeof args.operationId !== "string" || !UUID.test(args.operationId)
      || typeof args.expectedChannelId !== "string" || !PROVIDER_ID.test(args.expectedChannelId)) {
    throw new YoutubeCreateOperationError("youtube_operation_invalid", 400);
  }
  const operationId = args.operationId.toLowerCase();
  return {
    userId: args.userId, operationId, expectedChannelId: args.expectedChannelId,
    _id: `yt-create-op:${digest(`${args.userId}\0${operationId}`)}`,
    quotaId: `yt-create-quota:${digest(args.userId)}`,
  };
}

/** @param {CreateArgs} args */
function normalizeArgs(args) {
  const identity = normalizeIdentity(args);
  const intent = canonical(args.intent);
  if (!intent || Array.isArray(intent) || typeof intent !== "object"
      || !intent.snippet || typeof intent.snippet.title !== "string"
      || typeof intent.snippet.description !== "string") {
    throw new YoutubeCreateOperationError("youtube_intent_invalid", 400);
  }
  const encoded = JSON.stringify({ expectedChannelId: args.expectedChannelId, intent });
  if (Buffer.byteLength(encoded, "utf8") > MAX_INTENT_BYTES) {
    throw new YoutubeCreateOperationError("youtube_intent_too_large", 400);
  }
  return {
    ...identity, intent,
    intentHash: digest(encoded),
  };
}

/** @param {any} row @param {ReturnType<typeof normalizeArgs>} args */
function assertSameIntent(row, args) {
  if (!row || row.kind !== "operation" || row.userId !== args.userId
      || row.operationId !== args.operationId || row.intentHash !== args.intentHash
      || row.expectedChannelId !== args.expectedChannelId) {
    throw new YoutubeCreateOperationError("youtube_operation_intent_conflict");
  }
}

/** @param {any} row @returns {CreateResult} */
function publicResult(row) {
  if (row.phase === "succeeded" && row.broadcast) {
    return { phase: "succeeded", operationId: row.operationId, broadcast: structuredClone(row.broadcast) };
  }
  // A persisted creation can be running or left behind by a crash. Neither
  // case authorizes taking over or repeating its non-idempotent insertion.
  return { phase: "uncertain", operationId: row.operationId };
}

/** @param {any} row */
function privateContext(row) {
  return {
    nonce: row.nonce,
    marker: `\n\n[SC2Tools: ${row.nonce}]`,
    intent: structuredClone(row.intent),
    expectedChannelId: row.expectedChannelId,
  };
}

/** @param {any} actual @param {any} expected @returns {boolean} */
function containsExpected(actual, expected) {
  if (expected === null || typeof expected !== "object") return actual === expected;
  if (Array.isArray(expected)) return JSON.stringify(actual) === JSON.stringify(expected);
  return actual && typeof actual === "object"
    && Object.keys(expected).every((key) => containsExpected(actual[key], expected[key]));
}

/** @param {any} candidate @param {any} row @returns {Record<string,any>|null} */
function ownedCandidate(candidate, row) {
  if (!candidate || typeof candidate.id !== "string" || !PROVIDER_ID.test(candidate.id)
      || candidate.snippet?.channelId !== row.expectedChannelId) return null;
  const expected = structuredClone(row.intent);
  expected.snippet.description += privateContext(row).marker;
  // Google may normalize an equivalent RFC3339 timestamp (offset, fractional
  // seconds) in its response. Ownership still requires the same instant.
  const requestedStart = expected.snippet.scheduledStartTime;
  const returnedStart = candidate.snippet?.scheduledStartTime;
  if (typeof requestedStart === "string" && typeof returnedStart === "string"
      && Number.isFinite(Date.parse(requestedStart)) && Date.parse(requestedStart) === Date.parse(returnedStart)) {
    expected.snippet.scheduledStartTime = returnedStart;
  }
  if (Buffer.byteLength(expected.snippet.description, "utf8") > 5000
      || !containsExpected(candidate, expected)) return null;
  // Preserve only the fields required by the facade; ingestion credentials,
  // arbitrary provider fields, and the server nonce never reach callers.
  const safe = /** @type {Record<string,any>} */ ({
    id: candidate.id,
    snippet: {
      channelId: row.expectedChannelId,
      title: row.intent.snippet.title,
      description: row.intent.snippet.description,
    },
    status: {},
    contentDetails: {},
  });
  if (typeof candidate.snippet.scheduledStartTime === "string") {
    safe.snippet.scheduledStartTime = candidate.snippet.scheduledStartTime.slice(0, 128);
  }
  if (typeof candidate.snippet.categoryId === "string" && /^[0-9]{1,8}$/.test(candidate.snippet.categoryId)) safe.snippet.categoryId = candidate.snippet.categoryId;
  for (const key of ["lifeCycleStatus", "privacyStatus"]) {
    if (typeof candidate.status?.[key] === "string") safe.status[key] = candidate.status[key].slice(0, 64);
  }
  if (typeof candidate.status?.selfDeclaredMadeForKids === "boolean") {
    safe.status.selfDeclaredMadeForKids = candidate.status.selfDeclaredMadeForKids;
  }
  for (const key of ["enableAutoStart", "enableAutoStop"]) {
    if (typeof candidate.contentDetails?.[key] === "boolean") safe.contentDetails[key] = candidate.contentDetails[key];
  }
  if (typeof candidate.contentDetails?.boundStreamId === "string"
      && PROVIDER_ID.test(candidate.contentDetails.boundStreamId)) {
    safe.contentDetails.boundStreamId = candidate.contentDetails.boundStreamId;
  }
  if (typeof candidate.contentDetails?.monitorStream?.enableMonitorStream === "boolean") {
    safe.contentDetails.monitorStream = { enableMonitorStream: candidate.contentDetails.monitorStream.enableMonitorStream };
  }
  return safe;
}

/**
 * Shared database creation guard, deliberately without expiry or takeover.
 * Admission is bounded per user. An operational limit must fail closed;
 * deleting even successful UUID tombstones would permit a delayed replay.
 * Quota reservations never expire, including reservations whose insert
 * acknowledgement was lost. They can be retried only under their same UUID.
 *
 * @param {{collection:import('mongodb').Collection<any>,now?:()=>number,maxOperationsPerUser?:number,maxDailyOperationsPerUser?:number}} deps
 */
function buildYoutubeCreateLedger(deps) {
  const collection = deps.collection;
  const now = deps.now || Date.now;
  const maxOperations = deps.maxOperationsPerUser ?? DEFAULT_MAX_OPERATIONS;
  const maxDaily = deps.maxDailyOperationsPerUser ?? DEFAULT_MAX_DAILY_OPERATIONS;
  if (!Number.isSafeInteger(maxOperations) || maxOperations < 1 || maxOperations > 100_000) {
    throw new YoutubeCreateOperationError("youtube_operation_capacity_invalid", 400);
  }
  if (!Number.isSafeInteger(maxDaily) || maxDaily < 1 || maxDaily > 200) throw new YoutubeCreateOperationError("youtube_operation_capacity_invalid", 400);

  async function ensureIndexes() {
    await collection.createIndex({ userId: 1, operationId: 1 }, {
      unique: true, partialFilterExpression: { kind: "operation" },
      name: "youtube_create_user_operation",
    });
    await collection.createIndex({ userId: 1, broadcastId: 1, expectedChannelId: 1 }, {
      partialFilterExpression: { kind: "operation", phase: "succeeded" },
      name: "youtube_create_owned_broadcast",
    });
    await collection.createIndex({ dailyExpiresAt: 1 }, { expireAfterSeconds: 0, name: "youtube_daily_quota_expiry" });
    // Only short-lived daily counters have dailyExpiresAt. Permanent operation
    // and UUID quota rows never expire or become eligible to insert again.
  }

  /** @param {ReturnType<typeof normalizeArgs>} args */
  async function admit(args) {
    try {
      await collection.updateOne({ _id: args.quotaId }, { $setOnInsert: {
        kind: "quota", userId: args.userId, operationIds: [], intentHashes: {}, count: 0,
      } }, { ...WRITE_OPTIONS, upsert: true });
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 11000) throw error;
    }
    const admitted = await collection.updateOne({
      _id: args.quotaId, kind: "quota", userId: args.userId,
      operationIds: { $ne: args.operationId }, count: { $lt: maxOperations },
    }, {
      $push: /** @type {any} */ ({ operationIds: args.operationId }), $inc: { count: 1 },
      $set: { [`intentHashes.${args.operationId}`]: args.intentHash },
    }, WRITE_OPTIONS);
    if (admitted.matchedCount === 1) return;
    const quota = await collection.findOne({ _id: args.quotaId, kind: "quota", userId: args.userId });
    if (Array.isArray(quota?.operationIds) && quota.operationIds.includes(args.operationId)) {
      if (quota.intentHashes?.[args.operationId] !== args.intentHash) {
        throw new YoutubeCreateOperationError("youtube_operation_intent_conflict");
      }
      return;
    }
    throw new YoutubeCreateOperationError("youtube_operation_capacity_reached", 409);
  }

  /** @param {ReturnType<typeof normalizeArgs>} args */
  async function admitDaily(args) {
    const permanent = await collection.findOne({ _id: args.quotaId, kind: "quota", userId: args.userId });
    if (permanent?.operationIds?.includes(args.operationId) && permanent.intentHashes?.[args.operationId] !== args.intentHash) throw new YoutubeCreateOperationError("youtube_operation_intent_conflict");
    const day = new Date(now()).toISOString().slice(0, 10);
    const quotaId = `yt-create-day:${digest(args.userId)}:${day}`;
    try {
      await collection.updateOne({ _id: quotaId }, { $setOnInsert: {
        kind: "daily_quota", userId: args.userId, day, count: 0, operationIds: [], intentHashes: {},
        dailyExpiresAt: new Date(now() + 32 * 24 * 60 * 60_000),
      } }, { ...WRITE_OPTIONS, upsert: true });
    } catch (error) { if (/** @type {any} */ (error)?.code !== 11000) throw error; }
    const admitted = await collection.updateOne({
      _id: quotaId, kind: "daily_quota", userId: args.userId,
      operationIds: { $ne: args.operationId }, count: { $lt: maxDaily },
    }, {
      $push: /** @type {any} */ ({ operationIds: args.operationId }), $inc: { count: 1 },
      $set: { [`intentHashes.${args.operationId}`]: args.intentHash },
    }, WRITE_OPTIONS);
    if (admitted.matchedCount === 1) return;
    const row = await collection.findOne({ _id: quotaId, kind: "daily_quota", userId: args.userId });
    if (row?.operationIds?.includes(args.operationId)) {
      if (row.intentHashes?.[args.operationId] !== args.intentHash) throw new YoutubeCreateOperationError("youtube_operation_intent_conflict");
      return;
    }
    throw new YoutubeCreateOperationError("youtube_daily_operation_limit", 429);
  }

  /** @param {any} row @param {Record<string,any>} broadcast @returns {Promise<CreateResult>} */
  async function commit(row, broadcast) {
    const result = await collection.updateOne({
      _id: row._id, kind: "operation", userId: row.userId,
      intentHash: row.intentHash, nonce: row.nonce,
      phase: { $in: ["creating", "uncertain"] },
    }, { $set: {
      phase: "succeeded", broadcast, broadcastId: broadcast.id,
      completedAt: new Date(now()), updatedAt: new Date(now()),
    }, $unset: { uncertainty: "" } }, WRITE_OPTIONS);
    if (result.matchedCount === 1) return publicResult({ ...row, phase: "succeeded", broadcast });
    const current = await collection.findOne({ _id: row._id });
    assertSameIntent(current, normalizeArgs(row));
    if (current.phase === "succeeded" && current.broadcastId === broadcast.id) return publicResult(current);
    throw new YoutubeCreateOperationError("youtube_operation_reconciliation_conflict");
  }

  /** @param {CreateArgs} input @param {(context:ReturnType<typeof privateContext>)=>Promise<unknown>} insertFn */
  async function execute(input, insertFn) {
    const args = normalizeArgs(input);
    // Validate before consuming a permanent admission slot.
    if (Buffer.byteLength(args.intent.snippet.description, "utf8") + 46 > 5000) {
      throw new YoutubeCreateOperationError("youtube_description_marker_too_large", 400);
    }
    const existing = await collection.findOne({ _id: args._id });
    if (existing) { assertSameIntent(existing, args); return publicResult(existing); }
    await admitDaily(args);
    await admit(args);
    const row = {
      ...args, kind: "operation", phase: "creating", owner: randomUUID(),
      nonce: randomBytes(16).toString("hex"), createdAt: new Date(now()), updatedAt: new Date(now()),
    };
    if (Buffer.byteLength(row.intent.snippet.description + privateContext(row).marker, "utf8") > 5000) {
      throw new YoutubeCreateOperationError("youtube_description_marker_too_large", 400);
    }
    try {
      await collection.insertOne(row, WRITE_OPTIONS);
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 11000) throw error;
      const winner = await collection.findOne({ _id: args._id });
      assertSameIntent(winner, args);
      return publicResult(winner);
    }
    // Exactly one owner reaches this callback, after majority acknowledgement.
    // No timeout, exception, crash, or later request permits repeating it.
    try {
      const candidate = await insertFn(privateContext(row));
      const broadcast = ownedCandidate(candidate, row);
      if (!broadcast) throw new YoutubeCreateOperationError("youtube_created_broadcast_unverified");
      return await commit(row, broadcast);
    } catch (_error) {
      await collection.updateOne({ _id: row._id, owner: row.owner, phase: "creating" }, { $set: {
        phase: "uncertain", uncertainty: "provider_or_commit_outcome_unknown", updatedAt: new Date(now()),
      } }, WRITE_OPTIONS);
      const current = await collection.findOne({ _id: row._id });
      assertSameIntent(current, args);
      return publicResult(current);
    }
  }

  /** @param {CreateArgs} input @returns {Promise<CreateResult|null>} */
  async function inspect(input) {
    const args = normalizeArgs(input);
    const row = await collection.findOne({ _id: args._id });
    if (!row) return null;
    assertSameIntent(row, args);
    return publicResult(row);
  }

  /** @param {LookupArgs} input @param {(context:ReturnType<typeof privateContext>)=>Promise<unknown>} lookupFn */
  async function reconcile(input, lookupFn) {
    const identity = normalizeIdentity(input);
    const row = await collection.findOne({ _id: identity._id });
    if (!row) return null;
    // A trusted owned-operation read can omit intent; it may only recover
    // that exact durable operation, never accept a caller nonce or new UUID.
    const args = normalizeArgs({ ...input, intent: input.intent === undefined ? row.intent : input.intent });
    assertSameIntent(row, args);
    if (row.phase === "succeeded") return publicResult(row);
    const candidates = await lookupFn(privateContext(row));
    if (!Array.isArray(candidates) || candidates.length > 200) {
      throw new YoutubeCreateOperationError("youtube_reconciliation_list_invalid");
    }
    const matches = new Map();
    for (const candidate of candidates) {
      const safe = ownedCandidate(candidate, row);
      if (safe) matches.set(safe.id, safe);
    }
    if (matches.size !== 1) return publicResult(row);
    return commit(row, [...matches.values()][0]);
  }

  /** @param {{userId:string,broadcastId:string,expectedChannelId:string}} args */
  async function getOwnedBroadcast(args) {
    if (!args || typeof args.userId !== "string" || !args.userId
        || typeof args.broadcastId !== "string" || !PROVIDER_ID.test(args.broadcastId)
        || typeof args.expectedChannelId !== "string" || !PROVIDER_ID.test(args.expectedChannelId)) return null;
    const row = await collection.findOne({
      kind: "operation", userId: args.userId, broadcastId: args.broadcastId,
      expectedChannelId: args.expectedChannelId, phase: "succeeded",
    });
    if (!row || row.broadcast?.id !== args.broadcastId
        || row.broadcast?.snippet?.channelId !== args.expectedChannelId) return null;
    const broadcast = structuredClone(row.broadcast);
    if (row.selectedStreamId) broadcast.selectedStreamId = row.selectedStreamId;
    return broadcast;
  }

  /**
   * Pin BEFORE the first provider bind, then call again with a verified row
   * after binding. An ambiguous bind never permits selecting another stream.
   * The stored pin is distinct from the last verified provider binding.
   * @param {{userId:string,broadcastId:string,expectedChannelId:string,streamId:string,broadcast?:Record<string,any>}} args
   */
  async function markBound(args) {
    const owned = await getOwnedBroadcast(args);
    if (!owned || typeof args.streamId !== "string" || !PROVIDER_ID.test(args.streamId)) {
      throw new YoutubeCreateOperationError("youtube_broadcast_not_owned", 403);
    }
    const previous = owned.selectedStreamId || owned.contentDetails?.boundStreamId;
    if (previous && previous !== args.streamId) {
      throw new YoutubeCreateOperationError("youtube_broadcast_stream_conflict");
    }
    const actual = args.broadcast;
    if (actual && (actual.id !== args.broadcastId || actual.snippet?.channelId !== args.expectedChannelId
        || (actual.contentDetails?.boundStreamId && actual.contentDetails.boundStreamId !== args.streamId))) {
      throw new YoutubeCreateOperationError("youtube_bound_broadcast_unverified");
    }
    const changes = /** @type {Record<string,any>} */ ({ selectedStreamId: args.streamId, updatedAt: new Date(now()) });
    if (actual?.contentDetails?.boundStreamId === args.streamId) {
      changes["broadcast.contentDetails.boundStreamId"] = args.streamId;
    }
    const result = await collection.updateOne({
      kind: "operation", userId: args.userId, broadcastId: args.broadcastId,
      expectedChannelId: args.expectedChannelId, phase: "succeeded",
      $or: [{ selectedStreamId: { $exists: false } }, { selectedStreamId: args.streamId }],
    }, { $set: changes }, WRITE_OPTIONS);
    if (result.matchedCount !== 1) throw new YoutubeCreateOperationError("youtube_broadcast_stream_conflict");
    return getOwnedBroadcast(args);
  }

  /**
   * Coordinate different devices even when Google's occupied lists lag.
   * A previous uncertain bind retains the reservation. Only a trusted fresh
   * owned terminal read can release it; no browser/cloud deletion occurs.
   * @param {{userId:string,broadcastId:string,expectedChannelId:string,streamId:string}} args
   * @param {(previousBroadcastId:string)=>Promise<boolean>} verifyPrevious
   */
  async function claimStream(args, verifyPrevious) {
    const owned = await getOwnedBroadcast(args);
    if (!owned || typeof args.streamId !== "string" || !PROVIDER_ID.test(args.streamId)) throw new YoutubeCreateOperationError("youtube_broadcast_not_owned", 403);
    const _id = `yt-stream-claim:${digest(`${args.userId}\0${args.expectedChannelId}\0${args.streamId}`)}`;
    const fresh = { _id, kind: "stream_claim", userId: args.userId, expectedChannelId: args.expectedChannelId, streamId: args.streamId, broadcastId: args.broadcastId, updatedAt: new Date(now()) };
    try { await collection.insertOne(fresh, WRITE_OPTIONS); return true; } catch (error) {
      if (/** @type {any} */ (error)?.code !== 11000) throw error;
    }
    const previous = await collection.findOne({ _id, kind: "stream_claim", userId: args.userId, expectedChannelId: args.expectedChannelId, streamId: args.streamId });
    if (!previous) throw new YoutubeCreateOperationError("youtube_stream_reserved");
    if (previous.broadcastId === args.broadcastId) return true;
    if (!await getOwnedBroadcast({ ...args, broadcastId: previous.broadcastId }) || typeof verifyPrevious !== "function" || await verifyPrevious(previous.broadcastId) !== true) throw new YoutubeCreateOperationError("youtube_stream_reserved");
    const result = await collection.updateOne({ _id, kind: "stream_claim", userId: args.userId, broadcastId: previous.broadcastId }, { $set: { broadcastId: args.broadcastId, updatedAt: new Date(now()) } }, WRITE_OPTIONS);
    if (result.matchedCount === 1) return true;
    const current = await collection.findOne({ _id, kind: "stream_claim", userId: args.userId });
    if (current?.broadcastId === args.broadcastId) return true;
    throw new YoutubeCreateOperationError("youtube_stream_reserved");
  }

  /**
   * Sanitize a fresh provider read using a known durable owned ID. This
   * function never writes Google metadata. The cleanup flag makes a hidden
   * nonce visible as pending work without exposing it or fabricating Ready.
   * selectedStreamId is an internal proof field and is deliberately absent.
   * @param {{userId:string,expectedChannelId:string,broadcast:Record<string,any>}} args
   * @returns {Promise<Record<string,any>>}
   */
  async function sanitizeOwnedBroadcast(args) {
    const actual = args?.broadcast;
    if (!actual || typeof args.userId !== "string" || !args.userId
        || typeof actual.id !== "string" || !PROVIDER_ID.test(actual.id)
        || typeof args.expectedChannelId !== "string" || !PROVIDER_ID.test(args.expectedChannelId)
        || actual.snippet?.channelId !== args.expectedChannelId) {
      throw new YoutubeCreateOperationError("youtube_broadcast_not_owned", 403);
    }
    const row = await collection.findOne({
      kind: "operation", userId: args.userId, broadcastId: actual.id,
      expectedChannelId: args.expectedChannelId, phase: "succeeded",
    });
    if (!row || row.broadcast?.id !== actual.id
        || row.broadcast?.snippet?.channelId !== args.expectedChannelId) {
      throw new YoutubeCreateOperationError("youtube_broadcast_not_owned", 403);
    }
    const title = actual.snippet.title;
    const description = actual.snippet.description;
    if (typeof title !== "string" || title.length > 100 || typeof description !== "string"
        || Buffer.byteLength(description, "utf8") > 5000) {
      throw new YoutubeCreateOperationError("youtube_owned_broadcast_invalid");
    }
    const marker = privateContext(row).marker;
    const metadataPending = description.includes(marker);
    const safe = /** @type {Record<string,any>} */ ({
      id: actual.id,
      snippet: { channelId: args.expectedChannelId, title, description: description.split(marker).join("") },
      status: {}, contentDetails: {},
    });
    if (typeof actual.snippet.scheduledStartTime === "string") {
      safe.snippet.scheduledStartTime = actual.snippet.scheduledStartTime.slice(0, 128);
    }
    if (typeof actual.snippet.categoryId === "string" && /^[0-9]{1,8}$/.test(actual.snippet.categoryId)) safe.snippet.categoryId = actual.snippet.categoryId;
    for (const key of ["lifeCycleStatus", "privacyStatus"]) {
      if (typeof actual.status?.[key] === "string") safe.status[key] = actual.status[key].slice(0, 64);
    }
    if (typeof actual.status?.selfDeclaredMadeForKids === "boolean") {
      safe.status.selfDeclaredMadeForKids = actual.status.selfDeclaredMadeForKids;
    }
    for (const key of ["enableAutoStart", "enableAutoStop"]) {
      if (typeof actual.contentDetails?.[key] === "boolean") safe.contentDetails[key] = actual.contentDetails[key];
    }
    if (typeof actual.contentDetails?.boundStreamId === "string"
        && PROVIDER_ID.test(actual.contentDetails.boundStreamId)) {
      safe.contentDetails.boundStreamId = actual.contentDetails.boundStreamId;
    }
    if (typeof actual.contentDetails?.monitorStream?.enableMonitorStream === "boolean") {
      safe.contentDetails.monitorStream = { enableMonitorStream: actual.contentDetails.monitorStream.enableMonitorStream };
    }
    if (metadataPending) safe.metadataPending = true;
    return safe;
  }

  return { ensureIndexes, execute, inspect, reconcile, getOwnedBroadcast, markBound, claimStream, sanitizeOwnedBroadcast };
}

module.exports = { buildYoutubeCreateLedger, YoutubeCreateOperationError, DEFAULT_MAX_OPERATIONS, DEFAULT_MAX_DAILY_OPERATIONS };
