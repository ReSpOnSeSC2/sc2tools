"use strict";

/**
 * Opponent-level drill-down for the Net MMR by matchup chart.
 *
 * This module deliberately starts with ``netMmrPairStages``. That shared
 * prefix performs the full-history window before display filters and applies
 * the exact trust, ranked-1v1, delta-cap, and result-sign rules used by the
 * parent chart. Consequently, summing every unpaginated opponent row for a
 * race reproduces that race's bar.
 */

const { netMmrPairStages } = require("./trendsNetMmr");

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const SORT_FIELDS = /** @type {Readonly<Record<string, string>>} */ (Object.freeze({
  net_mmr: "netMmr",
  netmmr: "netMmr",
  mmr_won: "mmrWon",
  mmrwon: "mmrWon",
  mmr_lost: "mmrLost",
  mmrlost: "mmrLost",
  pairs: "pairs",
  games: "pairs",
  win_rate: "winRate",
  winrate: "winRate",
  avg_delta: "avgDelta",
  avgdelta: "avgDelta",
  last_played: "lastPlayed",
  lastplayed: "lastPlayed",
  name: "name",
}));

/**
 * @typedef {import('./trendsNetMmr').Deps} Deps
 * @typedef {{
 *   opponentRace?: 'P'|'T'|'Z'|'R'|'U',
 *   search?: string,
 *   minPairs?: number,
 *   sort?: string,
 *   order?: 'asc'|'desc',
 *   limit?: number,
 *   offset?: number,
 * }} NetMmrOpponentOptions
 */

/**
 * @param {any} field Mongo field expression.
 * @returns {Record<string, any>}
 */
function trimmedString(field) {
  return {
    $trim: {
      input: {
        $convert: {
          input: field,
          to: "string",
          onError: "",
          onNull: "",
        },
      },
    },
  };
}

/** @param {any} value */
function isNonEmpty(value) {
  return { $ne: [value, ""] };
}

/**
 * Stable identity when available, conservative per-game identity otherwise.
 * We never merge every nameless replay into one synthetic "Unknown" player.
 */
function opponentIdentityExpr() {
  return {
    $switch: {
      branches: [
        {
          case: isNonEmpty("$_toonHandle"),
          then: { $concat: ["opponent:", { $toLower: "$_toonHandle" }] },
        },
        {
          // pulseId is the canonical toon handle in current rows. Give the
          // aliases the same prefix so mixed-generation rows still merge.
          case: isNonEmpty("$_pulseId"),
          then: { $concat: ["opponent:", { $toLower: "$_pulseId" }] },
        },
        {
          case: isNonEmpty("$_pulseCharacterId"),
          then: {
            $concat: ["character:", { $toLower: "$_pulseCharacterId" }],
          },
        },
      ],
      default: { $concat: ["game:", { $toString: "$gameId" }] },
    },
  };
}

/**
 * Return accepted deltas grouped by opponent identity.
 *
 * Search and minimum-pair filtering happen after grouping. Summary leaders
 * are calculated before pagination, so headline cards remain correct while
 * the user pages or limits the table.
 *
 * @param {Deps} deps
 * @param {string} userId
 * @param {object} filters
 * @param {NetMmrOpponentOptions} [opts]
 */
async function netMmrByOpponent(deps, userId, filters, opts = {}) {
  const opponentRace = pickOpponentRace(opts.opponentRace);
  const search = String(opts.search || "").trim().slice(0, 128);
  const minPairs = clampPositiveInt(opts.minPairs, 1, 1_000_000);
  const limit = clampPositiveInt(opts.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const offset = clampNonNegativeInt(opts.offset, 0);
  const sort = pickOpponentSort(opts.sort, opts.order);

  /** @type {Array<Record<string, any>>} */
  const pipeline = [
    ...netMmrPairStages(deps, userId, filters),
    {
      $match: {
        _pairCandidate: true,
        _withinDeltaCap: true,
        _resultSignMatches: true,
      },
    },
  ];
  if (opponentRace) {
    pipeline.push({ $match: { _oppRace: opponentRace } });
  }
  pipeline.push(
    {
      $addFields: {
        _pulseId: trimmedString("$opponent.pulseId"),
        _toonHandle: trimmedString("$opponent.toonHandle"),
        _pulseCharacterId: trimmedString("$opponent.pulseCharacterId"),
        _displayName: trimmedString("$opponent.displayName"),
      },
    },
    { $addFields: { _opponentIdentity: opponentIdentityExpr() } },
    // Make the identity fields selected by $last deterministic and current.
    { $sort: { date: 1, gameId: 1 } },
    {
      $group: {
        _id: "$_opponentIdentity",
        // IDs are stable labels, not time-series values. $max retains a
        // known ID if a newer legacy row happens to omit that field.
        pulseId: { $max: "$_pulseId" },
        toonHandle: { $max: "$_toonHandle" },
        pulseCharacterId: { $max: "$_pulseCharacterId" },
        displayName: { $last: "$_displayName" },
        opponentRace: { $last: "$_oppRace" },
        netMmr: { $sum: "$_delta" },
        mmrWon: {
          $sum: { $cond: [{ $gt: ["$_delta", 0] }, "$_delta", 0] },
        },
        mmrLost: {
          $sum: {
            $cond: [
              { $lt: ["$_delta", 0] },
              { $multiply: ["$_delta", -1] },
              0,
            ],
          },
        },
        pairs: { $sum: 1 },
        wins: {
          $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] },
        },
        losses: {
          $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] },
        },
        avgDelta: { $avg: "$_delta" },
        firstPlayed: { $min: "$date" },
        lastPlayed: { $max: "$date" },
      },
    },
    {
      $project: {
        _id: 0,
        _identityKey: "$_id",
        pulseId: {
          $cond: [isNonEmpty("$pulseId"), "$pulseId", null],
        },
        toonHandle: {
          $cond: [isNonEmpty("$toonHandle"), "$toonHandle", null],
        },
        pulseCharacterId: {
          $cond: [
            isNonEmpty("$pulseCharacterId"),
            "$pulseCharacterId",
            null,
          ],
        },
        displayName: {
          $cond: [isNonEmpty("$displayName"), "$displayName", null],
        },
        name: {
          $switch: {
            branches: [
              { case: isNonEmpty("$displayName"), then: "$displayName" },
              { case: isNonEmpty("$toonHandle"), then: "$toonHandle" },
              { case: isNonEmpty("$pulseId"), then: "$pulseId" },
            ],
            default: "Unknown opponent",
          },
        },
        opponentRace: 1,
        netMmr: 1,
        mmrWon: 1,
        mmrLost: 1,
        pairs: 1,
        wins: 1,
        losses: 1,
        winRate: {
          $cond: [
            { $gt: ["$pairs", 0] },
            { $divide: ["$wins", "$pairs"] },
            0,
          ],
        },
        avgDelta: 1,
        firstPlayed: 1,
        lastPlayed: 1,
      },
    },
  );

  if (search) {
    const regex = escapeRegex(search);
    pipeline.push({
      $match: {
        $or: [
          { name: { $regex: regex, $options: "i" } },
          { displayName: { $regex: regex, $options: "i" } },
          { pulseId: { $regex: regex, $options: "i" } },
          { toonHandle: { $regex: regex, $options: "i" } },
          { pulseCharacterId: { $regex: regex, $options: "i" } },
        ],
      },
    });
  }
  if (minPairs > 1) {
    pipeline.push({ $match: { pairs: { $gte: minPairs } } });
  }

  pipeline.push({
    $facet: {
      totals: [
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            netMmr: { $sum: "$netMmr" },
            mmrWon: { $sum: "$mmrWon" },
            mmrLost: { $sum: "$mmrLost" },
            pairs: { $sum: "$pairs" },
          },
        },
      ],
      mostMmrGainedFrom: [
        { $match: { mmrWon: { $gt: 0 } } },
        { $sort: { mmrWon: -1, netMmr: -1, name: 1, _identityKey: 1 } },
        { $limit: 1 },
      ],
      mostMmrLostTo: [
        { $match: { mmrLost: { $gt: 0 } } },
        { $sort: { mmrLost: -1, netMmr: 1, name: 1, _identityKey: 1 } },
        { $limit: 1 },
      ],
      items: [
        { $sort: sort },
        { $skip: offset },
        { $limit: limit },
      ],
    },
  });

  const [root = {}] = await deps.games.aggregate(pipeline).toArray();
  const totals = root.totals?.[0] || {};
  const items = (root.items || []).map(serializeOpponentRow);
  const mostMmrGainedFrom = root.mostMmrGainedFrom?.[0]
    ? serializeOpponentRow(root.mostMmrGainedFrom[0])
    : null;
  const mostMmrLostTo = root.mostMmrLostTo?.[0]
    ? serializeOpponentRow(root.mostMmrLostTo[0])
    : null;
  const total = totals.total || 0;

  return {
    items,
    totalOpponents: total,
    // Generic alias follows the other offset-paginated aggregation APIs.
    total,
    limit,
    offset,
    summary: {
      netMmr: Math.round(totals.netMmr || 0),
      mmrWon: Math.round(totals.mmrWon || 0),
      mmrLost: Math.round(totals.mmrLost || 0),
      pairs: totals.pairs || 0,
      opponents: total,
      mostMmrGainedFrom,
      mostMmrLostTo,
    },
  };
}

/** @param {Record<string, any>} row */
function serializeOpponentRow(row) {
  const pairs = row.pairs || 0;
  // Current ingest uses the toon handle as pulseId. Older rows may carry
  // only one alias; return the known alias in both slots so this result can
  // join the existing Opponents list instead of becoming an orphaned stat.
  const pulseId = row.pulseId || row.toonHandle || null;
  const toonHandle = row.toonHandle || row.pulseId || null;
  return {
    pulseId,
    name: row.name || "Unknown opponent",
    displayName: row.displayName || row.name || "Unknown opponent",
    toonHandle,
    pulseCharacterId: row.pulseCharacterId || null,
    opponentRace: row.opponentRace || "U",
    netMmr: Math.round(row.netMmr || 0),
    mmrWon: Math.round(row.mmrWon || 0),
    mmrLost: Math.round(row.mmrLost || 0),
    pairs,
    // Compatibility with the existing matchup response terminology.
    games: pairs,
    wins: row.wins || 0,
    losses: row.losses || 0,
    winRate: pairs ? (row.wins || 0) / pairs : 0,
    avgDelta: Math.round((row.avgDelta || 0) * 10) / 10,
    firstPlayed: row.firstPlayed || null,
    lastPlayed: row.lastPlayed || null,
  };
}

/** @param {unknown} raw */
function pickOpponentRace(raw) {
  const value = String(raw || "").trim().toUpperCase();
  return ["P", "T", "Z", "R", "U"].includes(value) ? value : undefined;
}

/** @param {unknown} rawSort @param {unknown} rawOrder */
function pickOpponentSort(rawSort, rawOrder) {
  const key = String(rawSort || "net_mmr").trim().toLowerCase();
  const field = SORT_FIELDS[key] || "netMmr";
  const defaultDirection = field === "name" ? 1 : -1;
  const order = String(rawOrder || "").trim().toLowerCase();
  const direction = order === "asc" ? 1 : order === "desc" ? -1 : defaultDirection;
  if (field === "name") return { name: direction, _identityKey: 1 };
  return { [field]: direction, name: 1, _identityKey: 1 };
}

/** @param {unknown} raw @param {number} fallback @param {number} max */
function clampPositiveInt(raw, fallback, max) {
  const value = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, max);
}

/** @param {unknown} raw @param {number} fallback */
function clampNonNegativeInt(raw, fallback) {
  const value = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

/** @param {unknown} value */
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  netMmrByOpponent,
  pickOpponentRace,
  pickOpponentSort,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
