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
 *     opponent: {                   // optional correction of the opponent's build
 *       status: "none" | "confirmed", build, applied, detected,
 *       origin, via, confirmedAt, updatedAt,
 *     },
 *   }
 *
 * The opponent axis mirrors the "you" axis on ``opponent.strategy`` and
 * ``_customOpponentStrategySlug``; its helpers carry an ``OPP_`` /
 * ``opponent`` prefix.
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

/**
 * Is a confirmed opponent-build correction currently written onto this row?
 * @param {any} row
 * @returns {boolean}
 */
function opponentOverrideActive(row) {
  const intent = row && typeof row === "object" ? row.buildIntent : null;
  const opp = intent && typeof intent === "object" ? intent.opponent : null;
  return Boolean(
    opp
    && typeof opp === "object"
    && opp.status === "confirmed"
    && opp.applied === true
    && opp.build
    && typeof opp.build === "object"
    && typeof opp.build.name === "string",
  );
}

/**
 * The classifier's view of the opponent axis. Accepts raw rows
 * (``_customOpponentStrategySlug``) and preview rows
 * (``customOpponentStrategySlug``).
 *
 * @param {any} row
 * @returns {{strategy: string|null, customStrategySlug: string|null}}
 */
function opponentDetectorView(row) {
  if (opponentOverrideActive(row)) {
    const detected = row.buildIntent.opponent.detected || {};
    return {
      strategy: typeof detected.name === "string" ? detected.name : null,
      customStrategySlug: typeof detected.slug === "string" ? detected.slug : null,
    };
  }
  const opponent = row && row.opponent && typeof row.opponent === "object" ? row.opponent : {};
  const slug = row && (row._customOpponentStrategySlug ?? row.customOpponentStrategySlug);
  return {
    strategy: typeof opponent.strategy === "string" ? opponent.strategy : null,
    customStrategySlug: typeof slug === "string" ? slug : null,
  };
}

/**
 * Projection fragment for ``opponentOverrideActive`` /
 * ``opponentDetectorView``. Kept separate from
 * ``BUILD_INTENT_LABEL_PROJECTION`` so "you"-only readers stay lean.
 */
const OPP_INTENT_LABEL_PROJECTION = Object.freeze({
  "buildIntent.opponent.status": 1,
  "buildIntent.opponent.applied": 1,
  "buildIntent.opponent.build": 1,
  "buildIntent.opponent.detected": 1,
});

/**
 * Projection fragment carrying exactly what ``overrideActive`` and
 * ``detectorView`` read. Never includes notes or the suggestion cache.
 */
const BUILD_INTENT_LABEL_PROJECTION = Object.freeze({
  "buildIntent.status": 1,
  "buildIntent.applied": 1,
  "buildIntent.build": 1,
  "buildIntent.detected": 1,
});

/**
 * A raw row as the classifier sees it: on an override row ``myBuild`` and
 * ``_customBuildSlug`` are replaced by the detector's values (``null`` when
 * the detector had none, so ``a || b`` slug fallbacks never reach the
 * declared slug); an opponent correction likewise swaps ``opponent.strategy``
 * and ``_customOpponentStrategySlug`` (project ``OPP_INTENT_LABEL_PROJECTION``
 * for that). Rows without an override are returned unchanged.
 *
 * @template {Record<string, any>} T
 * @param {T} row
 * @returns {T}
 */
function withDetectorLabels(row) {
  const you = overrideActive(row);
  const opp = opponentOverrideActive(row);
  if (!you && !opp) return row;
  /** @type {Record<string, any>} */
  const out = { ...row };
  if (you) {
    const view = detectorView(row);
    out.myBuild = view.myBuild;
    out._customBuildSlug = view.customBuildSlug;
  }
  if (opp) {
    const view = opponentDetectorView(row);
    const opponent = row.opponent && typeof row.opponent === "object" ? row.opponent : {};
    out.opponent = { ...opponent, strategy: view.strategy };
    out._customOpponentStrategySlug = view.customStrategySlug;
  }
  return /** @type {T} */ (out);
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
 * Aggregation expression for a game row's ``planned`` field on per-build
 * recent-game lists: ``{detected, notes}`` while an override is written
 * (``detected`` = the classifier's label), else null.
 */
const PLANNED_GAME_EXPR = Object.freeze({
  $cond: [
    OVERRIDE_ACTIVE_EXPR,
    {
      detected: { $ifNull: ["$buildIntent.detected.name", null] },
      notes: { $ifNull: ["$buildIntent.notes", ""] },
    },
    null,
  ],
});

/** Aggregation expression: true while an opponent correction is written. */
const OPP_OVERRIDE_ACTIVE_EXPR = Object.freeze({
  $and: [
    { $eq: ["$buildIntent.opponent.status", "confirmed"] },
    { $eq: ["$buildIntent.opponent.applied", true] },
    { $eq: [{ $type: "$buildIntent.opponent.build" }, "object"] },
  ],
});

/** Query filter fragment: rows carrying a written opponent correction. */
const OPP_OVERRIDE_ACTIVE_FILTER = Object.freeze({
  "buildIntent.opponent.status": "confirmed",
  "buildIntent.opponent.applied": true,
});

/** Aggregation expression: the detector's ``opponent.strategy`` (null when unknown). */
const DETECTOR_OPP_STRATEGY_EXPR = Object.freeze({
  $cond: [
    OPP_OVERRIDE_ACTIVE_EXPR,
    { $ifNull: ["$buildIntent.opponent.detected.name", null] },
    { $ifNull: ["$opponent.strategy", null] },
  ],
});

/** Aggregation expression: the detector's ``_customOpponentStrategySlug``. */
const DETECTOR_OPP_SLUG_EXPR = Object.freeze({
  $cond: [
    OPP_OVERRIDE_ACTIVE_EXPR,
    { $ifNull: ["$buildIntent.opponent.detected.slug", null] },
    { $ifNull: ["$_customOpponentStrategySlug", null] },
  ],
});

const OPP_LABELS_AGREE_EXPR = Object.freeze({
  $and: [
    {
      $eq: [
        { $ifNull: ["$opponent.strategy", null] },
        { $ifNull: ["$buildIntent.opponent.detected.name", null] },
      ],
    },
    {
      $eq: [
        { $ifNull: ["$_customOpponentStrategySlug", null] },
        { $ifNull: ["$buildIntent.opponent.detected.slug", null] },
      ],
    },
  ],
});

/**
 * Opponent-axis twin of ``AGREES_WITH_DETECTOR_MATCH``. Both are ``$or``
 * fragments: combine them with ``$and``, never by spreading.
 */
const OPP_AGREES_WITH_DETECTOR_MATCH = Object.freeze({
  $or: [
    { "buildIntent.opponent.applied": { $ne: true } },
    { $expr: OPP_LABELS_AGREE_EXPR },
  ],
});

/** 1 for games whose opponent label counts only because of a correction. */
const OPP_COUNTED_BY_CHECKIN_EXPR = Object.freeze({
  $cond: [
    { $and: [OPP_OVERRIDE_ACTIVE_EXPR, { $not: [OPP_LABELS_AGREE_EXPR] }] },
    1,
    0,
  ],
});

/** ``planned`` for opponent-perspective recent-game rows (see PLANNED_GAME_EXPR). */
const OPP_PLANNED_GAME_EXPR = Object.freeze({
  $cond: [
    OPP_OVERRIDE_ACTIVE_EXPR,
    {
      detected: { $ifNull: ["$buildIntent.opponent.detected.name", null] },
      notes: { $ifNull: ["$buildIntent.notes", ""] },
    },
    null,
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
  withDetectorLabels,
  BUILD_INTENT_LABEL_PROJECTION,
  OVERRIDE_ACTIVE_EXPR,
  OVERRIDE_ACTIVE_FILTER,
  DETECTOR_BUILD_EXPR,
  DETECTOR_SLUG_EXPR,
  AGREES_WITH_DETECTOR_MATCH,
  COUNTED_BY_CHECKIN_EXPR,
  PLANNED_GAME_EXPR,
  opponentOverrideActive,
  opponentDetectorView,
  OPP_INTENT_LABEL_PROJECTION,
  OPP_OVERRIDE_ACTIVE_EXPR,
  OPP_OVERRIDE_ACTIVE_FILTER,
  DETECTOR_OPP_STRATEGY_EXPR,
  DETECTOR_OPP_SLUG_EXPR,
  OPP_AGREES_WITH_DETECTOR_MATCH,
  OPP_COUNTED_BY_CHECKIN_EXPR,
  OPP_PLANNED_GAME_EXPR,
  isTooShortGame,
  sanitizeNotes,
};
