"use strict";

/**
 * Build check-in ("build intent") shared shape.
 *
 * A confirmed check-in overrides a game row's effective build label:
 * ``myBuild`` (plus ``_customBuildSlug`` for a custom build) become the
 * declared build, so every per-user W-L surface counts the game even when
 * the replay never satisfied the build's rules. ``buildIntent.detected``
 * keeps what the classifier said. Classifier writers and cross-user readers
 * work on that detector view; nothing else needs to know about check-ins.
 *
 * Row shape (server-owned, never accepted from uploads):
 *   buildIntent: {
 *     status: "pending" | "confirmed" | "skipped",
 *     build: BuildRef | null,       // the confirmed build
 *     applied: boolean,             // true only while the override is written
 *     detected: {name, slug} | null,// classifier label while applied
 *     suggestion, randomizer, origin, via, gameKey, notes,
 *     confirmedAt, updatedAt,
 *   }
 */

const NOTES_MAX_LENGTH = 1000;
/** Same cut-off as the replay engine's "Game Too Short" label. */
const TOO_SHORT_SECONDS = 45;
const TOO_SHORT_LABEL_RE = /Game Too Short$/;
const MATCHUP_RE = /^[PTZ]v[PTZ]$/;
const CUSTOM_KEY_PREFIX = "custom:";
const CATALOG_KEY_MAX_LENGTH = 80;

/**
 * Catalog build key: identical to the web catalog's ``slugifyDef`` so the
 * randomizer's catalog ids join without translation.
 *
 * Example: `catalogKeyForName("PvZ - 2 Stargate Phoenix")` →
 * "pvz-2-stargate-phoenix".
 *
 * @param {string} name
 * @returns {string}
 */
function catalogKeyForName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, CATALOG_KEY_MAX_LENGTH);
}

/** @param {string} slug @returns {string} */
function customKeyForSlug(slug) {
  return `${CUSTOM_KEY_PREFIX}${slug}`;
}

/**
 * @param {unknown} key
 * @returns {{source: "custom", slug: string} | {source: "catalog", key: string} | null}
 */
function parseBuildKey(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > 200) return null;
  if (key.startsWith(CUSTOM_KEY_PREFIX)) {
    const slug = key.slice(CUSTOM_KEY_PREFIX.length);
    return /^[a-zA-Z0-9._-]{1,80}$/.test(slug) ? { source: "custom", slug } : null;
  }
  return /^[a-z0-9-]{1,80}$/.test(key) ? { source: "catalog", key } : null;
}

/**
 * Is a confirmed override currently written onto this row?
 * @param {any} row
 * @returns {boolean}
 */
function overrideActive(row) {
  const intent = row && typeof row === "object" ? row.buildIntent : null;
  return Boolean(
    intent
    && typeof intent === "object"
    && intent.status === "confirmed"
    && intent.applied === true
    && intent.build
    && typeof intent.build === "object"
    && typeof intent.build.name === "string",
  );
}

/**
 * The classifier's view of a row: what ``myBuild``/``_customBuildSlug``
 * would hold without the check-in. Accepts raw rows (``_customBuildSlug``)
 * and preview rows (``customBuildSlug``).
 *
 * @param {any} row
 * @returns {{myBuild: string|null, customBuildSlug: string|null}}
 */
function detectorView(row) {
  if (overrideActive(row)) {
    const detected = row.buildIntent.detected || {};
    return {
      myBuild: typeof detected.name === "string" ? detected.name : null,
      customBuildSlug: typeof detected.slug === "string" ? detected.slug : null,
    };
  }
  const slug = row && (row._customBuildSlug ?? row.customBuildSlug);
  return {
    myBuild: row && typeof row.myBuild === "string" ? row.myBuild : null,
    customBuildSlug: typeof slug === "string" ? slug : null,
  };
}

/** Aggregation expression: true while a confirmed override is written. */
const OVERRIDE_ACTIVE_EXPR = Object.freeze({
  $and: [
    { $eq: ["$buildIntent.status", "confirmed"] },
    { $eq: ["$buildIntent.applied", true] },
    { $eq: [{ $type: "$buildIntent.build" }, "object"] },
  ],
});

/** Query filter fragment: rows carrying a written override. */
const OVERRIDE_ACTIVE_FILTER = Object.freeze({
  "buildIntent.status": "confirmed",
  "buildIntent.applied": true,
});

/** Aggregation expression: the detector's ``myBuild`` (null when unknown). */
const DETECTOR_BUILD_EXPR = Object.freeze({
  $cond: [
    OVERRIDE_ACTIVE_EXPR,
    { $ifNull: ["$buildIntent.detected.name", null] },
    { $ifNull: ["$myBuild", null] },
  ],
});

/** Aggregation expression: the detector's ``_customBuildSlug`` (null when none). */
const DETECTOR_SLUG_EXPR = Object.freeze({
  $cond: [
    OVERRIDE_ACTIVE_EXPR,
    { $ifNull: ["$buildIntent.detected.slug", null] },
    { $ifNull: ["$_customBuildSlug", null] },
  ],
});

const LABELS_AGREE_EXPR = Object.freeze({
  $and: [
    {
      $eq: [
        { $ifNull: ["$myBuild", null] },
        { $ifNull: ["$buildIntent.detected.name", null] },
      ],
    },
    {
      $eq: [
        { $ifNull: ["$_customBuildSlug", null] },
        { $ifNull: ["$buildIntent.detected.slug", null] },
      ],
    },
  ],
});

/**
 * Match fragment keeping rows whose effective label equals the detector's:
 * every row without a written override, plus override rows where the replay
 * landed on the declared build anyway. Push it into an existing ``$and`` so
 * it runs as a residual filter after the index scan.
 */
const AGREES_WITH_DETECTOR_MATCH = Object.freeze({
  $or: [
    { "buildIntent.applied": { $ne: true } },
    { $expr: LABELS_AGREE_EXPR },
  ],
});

/**
 * Aggregation expression: 1 for games that count toward their label only
 * because of a check-in (override written and the detector disagrees).
 * Use as ``{$sum: COUNTED_BY_CHECKIN_EXPR}`` for "incl. N check-ins".
 */
const COUNTED_BY_CHECKIN_EXPR = Object.freeze({
  $cond: [
    { $and: [OVERRIDE_ACTIVE_EXPR, { $not: [LABELS_AGREE_EXPR] }] },
    1,
    0,
  ],
});

/**
 * Too-short games (leavers, loading-screen disconnects) never take an
 * override: a check-in there would hand the build a free win or loss.
 * @param {{durationSec?: unknown, myBuild?: unknown}} game
 * @returns {boolean}
 */
function isTooShortGame(game) {
  if (!game || typeof game !== "object") return false;
  const duration = Number(game.durationSec);
  if (Number.isFinite(duration) && duration > 0 && duration < TOO_SHORT_SECONDS) {
    return true;
  }
  const detected = detectorView(game).myBuild;
  return typeof detected === "string" && TOO_SHORT_LABEL_RE.test(detected);
}

/**
 * Normalise user notes: trim, drop control characters (keep newlines and
 * tabs), cap at NOTES_MAX_LENGTH.
 * @param {unknown} raw
 * @returns {string|null} null when ``raw`` is not a string or is too long
 */
function sanitizeNotes(raw) {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (cleaned.length > NOTES_MAX_LENGTH) return null;
  return cleaned;
}

module.exports = {
  NOTES_MAX_LENGTH,
  TOO_SHORT_SECONDS,
  TOO_SHORT_LABEL_RE,
  MATCHUP_RE,
  CUSTOM_KEY_PREFIX,
  catalogKeyForName,
  customKeyForSlug,
  parseBuildKey,
  overrideActive,
  detectorView,
  OVERRIDE_ACTIVE_EXPR,
  OVERRIDE_ACTIVE_FILTER,
  DETECTOR_BUILD_EXPR,
  DETECTOR_SLUG_EXPR,
  AGREES_WITH_DETECTOR_MATCH,
  COUNTED_BY_CHECKIN_EXPR,
  isTooShortGame,
  sanitizeNotes,
};
