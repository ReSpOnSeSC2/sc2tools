"use strict";

/**
 * Cloud schema migration registry.
 *
 * Modules under this folder used to be one-shot scripts (run by
 * hand at deploy time). The May-2026 "stuck on TOON id" fix
 * introduced the first migration that needs to roll forward at
 * read time too — older opponents docs were stamped at v1, the
 * registry is now at v2, and we want every server boot to know
 * how to migrate v1 → v2 lazily without each service growing its
 * own coercion logic.
 *
 * Calling ``loadAllMigrations`` registers every chain step with
 * the central ``schemaVersioning`` registry. It is idempotent —
 * the registry exposes its underlying array for tests, and we
 * skip steps that are already registered.
 *
 * Boot wiring lives in ``app.js`` (called once before
 * ``makeServices``).
 */

const { COLLECTIONS } = require("../../config/constants");
const { registerMigration, _internals } = require("../schemaVersioning");

/**
 * Forward shape change for opponents v1 → v2.
 *
 * Two no-op-when-already-clean steps:
 *   * If ``pulseCharacterId`` is the literal empty string,
 *     remove it. The API's ingest schema requires ``^[0-9]+$`` so
 *     empty values can only be inherited from older
 *     ``recordGame``/``refreshMetadata`` writes that pre-dated
 *     the sticky-empty guard.
 *   * Ensure ``pulseResolveAttemptedAt`` exists. v1 docs never
 *     carried the field; the backfill filter expects
 *     ``$exists: false`` OR a ``< cutoff`` Date so we leave the
 *     field at ``null`` to make the shape uniform without
 *     forcing a fake "we attempted at epoch" timestamp.
 */
/** @param {Record<string, any>} doc */
function opponentsV1toV2(doc) {
  const next = { ...doc };
  if (next.pulseCharacterId === "" || next.pulseCharacterId === null) {
    delete next.pulseCharacterId;
  }
  if (!("pulseResolveAttemptedAt" in next)) {
    next.pulseResolveAttemptedAt = null;
  }
  return next;
}

/**
 * Inverse: drop pulseResolveAttemptedAt when rolling back.
 * @param {Record<string, any>} doc
 */
function opponentsV2toV1(doc) {
  const { pulseResolveAttemptedAt, ...rest } = doc;
  void pulseResolveAttemptedAt;
  return rest;
}

/**
 * Games v6 introduces optional, server-private classifier fencing fields.
 * Existing rows need no synthetic values: a replay/detail write creates a
 * fresh revision, and background classification creates ordering state only
 * when it commits a decision.
 * @param {Record<string, any>} doc
 */
function gamesV5toV6(doc) {
  return { ...doc };
}

/** @param {Record<string, any>} doc */
function gamesV6toV5(doc) {
  const next = { ...doc };
  delete next._customBuildRevision;
  delete next._customBuildReclassify;
  delete next._customBuildClassificationSequence;
  delete next._customBuildSlug;
  delete next._opponentBuildOrderWriteLease;
  return next;
}

/**
 * Games v7 adds an optional opponent-perspective provenance field. Existing
 * v6 rows remain valid and acquire it only when an opponent custom strategy
 * is classified.
 * @param {Record<string, any>} doc
 */
function gamesV6toV7(doc) {
  return { ...doc };
}

/** @param {Record<string, any>} doc */
function gamesV7toV6(doc) {
  const next = { ...doc };
  delete next._customOpponentStrategySlug;
  return next;
}

const REGISTRATIONS = [
  {
    collection: COLLECTIONS.OPPONENTS,
    fromVersion: 1,
    toVersion: 2,
    forward: opponentsV1toV2,
    backward: opponentsV2toV1,
    description:
      "May-2026 fix: coerce empty pulseCharacterId to unset; add pulseResolveAttemptedAt slot.",
  },
  {
    collection: COLLECTIONS.GAMES,
    fromVersion: 5,
    toVersion: 6,
    forward: gamesV5toV6,
    backward: gamesV6toV5,
    description:
      "August-2026: add optional server-private custom-build classification fences.",
  },
  {
    collection: COLLECTIONS.GAMES,
    fromVersion: 6,
    toVersion: 7,
    forward: gamesV6toV7,
    backward: gamesV7toV6,
    description:
      "August-2026: add independent opponent custom-strategy provenance.",
  },
];

/**
 * Register every known migration with the schema-versioning
 * registry. Safe to call multiple times — duplicates are skipped.
 */
function loadAllMigrations() {
  for (const m of REGISTRATIONS) {
    if (alreadyRegistered(m)) continue;
    registerMigration(m);
  }
}

/** @param {{ collection: string, fromVersion: number, toVersion: number }} m */
function alreadyRegistered(m) {
  for (const existing of _internals.MIGRATIONS) {
    if (
      existing.collection === m.collection
      && existing.fromVersion === m.fromVersion
      && existing.toVersion === m.toVersion
    ) {
      return true;
    }
  }
  return false;
}

module.exports = {
  loadAllMigrations,
  REGISTRATIONS,
  // Exported for tests.
  __internal: {
    opponentsV1toV2,
    opponentsV2toV1,
    gamesV5toV6,
    gamesV6toV5,
    gamesV6toV7,
    gamesV7toV6,
    alreadyRegistered,
  },
};
