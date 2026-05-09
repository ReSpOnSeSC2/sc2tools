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

/** Inverse: drop pulseResolveAttemptedAt when rolling back. */
function opponentsV2toV1(doc) {
  const { pulseResolveAttemptedAt, ...rest } = doc;
  void pulseResolveAttemptedAt;
  return rest;
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
  __internal: { opponentsV1toV2, opponentsV2toV1, alreadyRegistered },
};
