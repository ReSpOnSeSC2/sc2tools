"use strict";

const { randomUUID } = require("crypto");
const { COLLECTIONS } = require("../config/constants");
const { expectedVersion } = require("../db/schemaVersioning");

const OPPONENT_BUILD_ORDER_WRITE_LEASE_FIELD =
  "_opponentBuildOrderWriteLease";
const OPPONENT_BUILD_ORDER_WRITE_LEASE_MS = 5 * 60 * 1000;
const OPPONENT_BUILD_ORDER_WRITE_RENEW_MS = 30 * 1000;
const OPPONENT_BUILD_ORDER_WRITE_RETRY_MS = 50;
const OPPONENT_BUILD_ORDER_WRITE_ACQUIRE_TIMEOUT_MS = 1_000;
const CLASSIFIER_WRITE_SENTINEL = Number.MAX_SAFE_INTEGER;

/**
 * Recover a writer that died after raising the classifier fence. R2/Mongo
 * object writes are atomic, so once the writer lease expires the stored
 * detail is either the old complete object or the new complete object. A
 * fresh revision forces any classifier that hydrated before recovery to
 * discard its verdict.
 *
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @param {Date} [now]
 */
async function recoverExpiredOpponentBuildOrderWrites(
  games,
  userId,
  now = new Date(),
) {
  const leaseUntilPath = `${OPPONENT_BUILD_ORDER_WRITE_LEASE_FIELD}.leaseUntil`;
  return games.updateMany(
    {
      userId,
      [OPPONENT_BUILD_ORDER_WRITE_LEASE_FIELD]: { $exists: true },
      $or: [
        { [leaseUntilPath]: { $lte: now } },
        {
          $expr: {
            $ne: [
              { $type: `$${leaseUntilPath}` },
              "date",
            ],
          },
        },
      ],
    },
    {
      $set: {
        _schemaVersion: expectedVersion(COLLECTIONS.GAMES),
        _customBuildRevision: randomUUID(),
      },
      $unset: {
        [OPPONENT_BUILD_ORDER_WRITE_LEASE_FIELD]: "",
        _customBuildClassificationSequence: "",
        _customBuildReclassify: "",
      },
    },
  );
}

/**
 * Clear expired crash residue, then reject a destructive classifier while a
 * live detail writer owns any game for this user. Background jobs treat the
 * error as a retry signal instead of consuming their finite failure budget.
 *
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 */
async function assertNoActiveOpponentBuildOrderWrites(games, userId) {
  const now = new Date();
  await recoverExpiredOpponentBuildOrderWrites(games, userId, now);
  const active = await games.findOne(
    {
      userId,
      [`${OPPONENT_BUILD_ORDER_WRITE_LEASE_FIELD}.leaseUntil`]: { $gt: now },
    },
    { projection: { _id: 1, [`${OPPONENT_BUILD_ORDER_WRITE_LEASE_FIELD}.leaseUntil`]: 1 } },
  );
  if (active) {
    throw opponentBuildOrderWriteInProgressError(
      active[OPPONENT_BUILD_ORDER_WRITE_LEASE_FIELD]?.leaseUntil,
    );
  }
}

/** @param {Date|unknown} leaseUntil */
function opponentBuildOrderWriteInProgressError(leaseUntil) {
  const err = new Error("opponent_build_order_write_in_progress");
  err.name = "RetryableReclassificationError";
  // @ts-expect-error application error metadata
  err.code = "opponent_build_order_write_in_progress";
  // @ts-expect-error application error metadata
  err.retryable = true;
  // Avoid a 250 ms hot loop during R2 I/O. Renewal may extend this date, so
  // cap a single sleep and let the next durable claim re-check Mongo.
  const remaining = leaseUntil instanceof Date
    ? leaseUntil.getTime() - Date.now()
    : 5_000;
  // @ts-expect-error application error metadata
  err.retryAfterMs = Math.max(1_000, Math.min(15_000, remaining));
  return err;
}

/**
 * @param {Array<{opponentBuildOrderWriteLease?: {leaseUntil?: Date|null}|null}>} games
 */
function assertStableOpponentBuildOrderPage(games) {
  let latest = null;
  for (const game of games) {
    const leaseUntil = game.opponentBuildOrderWriteLease?.leaseUntil;
    if (!(leaseUntil instanceof Date) || leaseUntil.getTime() <= Date.now()) {
      continue;
    }
    if (!latest || leaseUntil > latest) latest = leaseUntil;
  }
  if (latest) throw opponentBuildOrderWriteInProgressError(latest);
}

function opponentBuildOrderBusyError() {
  const err = new Error("opponent_build_order_busy");
  err.name = "OpponentBuildOrderBusyError";
  // @ts-expect-error application error metadata
  err.code = "opponent_build_order_busy";
  // @ts-expect-error application error metadata
  err.status = 503;
  // @ts-expect-error application error metadata
  err.retryAfterSec = 2;
  return err;
}

/** @param {unknown} [cause] */
function opponentBuildOrderClassificationQueueError(cause) {
  const err = new Error("opponent_build_order_classification_queue_failed");
  err.name = "OpponentBuildOrderQueueError";
  // @ts-expect-error application error metadata
  err.code = "opponent_build_order_classification_queue_failed";
  // @ts-expect-error application error metadata
  err.status = 503;
  // @ts-expect-error application error metadata
  err.retryAfterSec = 2;
  err.cause = cause;
  return err;
}

/** @param {unknown} err */
function isRetryableReclassificationError(err) {
  return !!(
    err
    && typeof err === "object"
    && "retryable" in err
    && /** @type {{retryable?: unknown}} */ (err).retryable === true
  );
}

module.exports = {
  OPPONENT_BUILD_ORDER_WRITE_LEASE_FIELD,
  OPPONENT_BUILD_ORDER_WRITE_LEASE_MS,
  OPPONENT_BUILD_ORDER_WRITE_RENEW_MS,
  OPPONENT_BUILD_ORDER_WRITE_RETRY_MS,
  OPPONENT_BUILD_ORDER_WRITE_ACQUIRE_TIMEOUT_MS,
  CLASSIFIER_WRITE_SENTINEL,
  recoverExpiredOpponentBuildOrderWrites,
  assertNoActiveOpponentBuildOrderWrites,
  assertStableOpponentBuildOrderPage,
  opponentBuildOrderWriteInProgressError,
  opponentBuildOrderBusyError,
  opponentBuildOrderClassificationQueueError,
  isRetryableReclassificationError,
};
