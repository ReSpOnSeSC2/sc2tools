"use strict";

const { createHash } = require("node:crypto");

const CUSTOM_BUILD_PAGE_SIZE = 50;
const CUSTOM_BUILD_MAX_PAGE_SIZE = 100;
const CUSTOM_BUILD_CLASSIFIER_BATCH_SIZE = 50;

/** @param {string} message */
function invalidPage(message) {
  return Object.assign(new Error(message), { status: 400, code: "invalid_custom_build_page" });
}

/** @param {unknown} input @param {string} name @param {number} max */
function textOption(input, name, max) {
  if (input === undefined || input === null || input === "") return "";
  if (typeof input !== "string" || input.length > max) throw invalidPage(`Invalid ${name}.`);
  return input.trim();
}

/** @param {Record<string, any>} [raw] */
function parseBuildPageOptions(raw = {}) {
  if (raw.limit !== undefined && typeof raw.limit !== "string" && typeof raw.limit !== "number") throw invalidPage("Invalid page size.");
  const limit = raw.limit === undefined ? CUSTOM_BUILD_PAGE_SIZE : Number(raw.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > CUSTOM_BUILD_MAX_PAGE_SIZE) {
    throw invalidPage(`Page size must be between 1 and ${CUSTOM_BUILD_MAX_PAGE_SIZE}.`);
  }
  const sort = textOption(raw.sort, "sort", 20) || "updated";
  if (!["updated", "name", "games", "winRate"].includes(sort)) throw invalidPage("Invalid build sort.");
  const matchup = textOption(raw.matchup, "matchup", 10);
  if (matchup && matchup !== "All" && !/^[PTZ]v[PTZ]$/.test(matchup)) throw invalidPage("Invalid matchup.");
  const hideEmpty = raw.hideEmpty === true || raw.hideEmpty === "true";
  if (raw.hideEmpty !== undefined && ![true, false, "true", "false"].includes(raw.hideEmpty)) throw invalidPage("Invalid hideEmpty.");
  const view = textOption(raw.view, "view", 20);
  if (view && view !== "summary") throw invalidPage("Invalid build view.");
  const includeGeneric = raw.includeGeneric === true || raw.includeGeneric === "true";
  if (raw.includeGeneric !== undefined && ![true, false, "true", "false"].includes(raw.includeGeneric)) throw invalidPage("Invalid includeGeneric.");
  return {
    limit, sort, matchup: matchup === "All" ? "" : matchup, hideEmpty, view, includeGeneric,
    search: textOption(raw.search, "search", 200),
    name: textOption(raw.name, "name", 200),
    normalizedName: textOption(raw.normalizedName, "normalizedName", 200),
    cursor: textOption(raw.cursor, "cursor", 2048),
  };
}

/** @param {string} value */
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Matches the analyzer's display-name normalization without rewriting identity. @param {string} value */
function normalizedNameRegex(value) {
  const name = value.replace(/^[TPZR]v[TPZR]\s*(?:[-–—:]\s*)?/i, "").trim();
  return `^(?:[TPZR]v[TPZR]\\s*(?:[-–—:]\\s*)?)?\\s*${name.split(/\s+/).map(escapeRegex).join("\\s+")}\\s*$`;
}

/** @param {string} userId @param {ReturnType<typeof parseBuildPageOptions>} opts */
function pageScope(userId, opts) {
  return createHash("sha256").update(JSON.stringify({ userId, ...opts, cursor: "" })).digest("hex");
}

/** @param {string} cursor @param {string} scope @param {string} sort */
function decodePageCursor(cursor, scope, sort) {
  if (!cursor) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (value.v !== 1 || value.scope !== scope || typeof value.slug !== "string" || value.slug.length > 80) throw new Error();
    if (sort === "name" ? typeof value.order !== "string" || value.order.length > 200 : typeof value.order !== "number" || !Number.isFinite(value.order)) throw new Error();
    return value;
  } catch { throw invalidPage("This build page has expired or does not match the selected filters."); }
}

/** @param {any} games @param {string} userId */
function buildStatsStages(games, userId) {
  const bucket = { $toLower: { $ifNull: ["$result", ""] } };
  return [
    ...["you", "opponent"].map((perspective) => ({
      $lookup: {
        from: games.collectionName,
        let: { slug: "$slug", perspective: { $cond: [{ $eq: ["$perspective", "opponent"] }, "opponent", "you"] } },
        pipeline: [
          { $match: {
            userId, isResumedFromReplay: { $ne: true },
            $expr: { $and: [
              { $eq: [perspective === "you" ? "$_customBuildSlug" : "$_customOpponentStrategySlug", "$$slug"] },
              { $eq: ["$$perspective", perspective] },
            ] },
          } },
          { $group: {
            _id: null, total: { $sum: 1 },
            wins: { $sum: { $cond: [{ $in: [bucket, ["win", "victory"]] }, 1, 0] } },
            losses: { $sum: { $cond: [{ $in: [bucket, ["loss", "defeat"]] }, 1, 0] } },
          } },
        ],
        as: perspective === "you" ? "_youStats" : "_opponentStats",
      },
    })),
    { $set: { _stats: { $ifNull: [
      { $arrayElemAt: [{ $concatArrays: ["$_youStats", "$_opponentStats"] }, 0] },
      { total: 0, wins: 0, losses: 0 },
    ] } } },
    { $unset: ["_youStats", "_opponentStats"] },
  ];
}

/**
 * Pagination, searching and ordering happen in Mongo; only a bounded page of
 * bounded build documents reaches the API process. A cursor belongs to one
 * account/filter/sort scope and uses the unique slug as its final tie breaker.
 * @param {any} collection
 * @param {any} games
 * @param {string} userId
 * @param {Record<string, any>} raw
 * @param {Record<string, any>} projection
 */
async function listBuildPage(collection, games, userId, raw, projection) {
  const opts = parseBuildPageOptions(raw);
  const scope = pageScope(userId, opts);
  const cursor = decodePageCursor(opts.cursor, scope, opts.sort);
  const match = { userId, deletedAt: { $exists: false } };
  /** @type {Record<string, any>[]} */
  const stages = [{ $match: match }, { $project: projection }];
  /** @type {Record<string, any>[]} */
  const conditions = [];
  if (opts.name) conditions.push({ $or: [{ name: opts.name }, { slug: opts.name }] });
  if (opts.normalizedName) conditions.push({ $or: ["name", "slug"].map((field) => ({ [field]: { $regex: normalizedNameRegex(opts.normalizedName), $options: "i" } })) });
  if (opts.matchup) {
    const races = { P: "Protoss", T: "Terran", Z: "Zerg" };
    const mine = opts.matchup[0];
    const theirs = opts.matchup[2];
    conditions.push({ race: { $regex: `^(?:${mine}|${races[/** @type {keyof typeof races} */ (mine)]})$`, $options: "i" } });
    const vs = { vsRace: { $regex: `^(?:${theirs}|${races[/** @type {keyof typeof races} */ (theirs)]})$`, $options: "i" } };
    conditions.push(opts.includeGeneric ? { $or: [vs, { vsRace: null }, { vsRace: { $in: ["Any", "any", ""] } }] } : vs);
  }
  if (opts.search) {
    const query = escapeRegex(opts.search);
    conditions.push({ $or: [
      ...["name", "slug", "description", "notes", "race", "vsRace"].map((field) => ({ [field]: { $regex: query, $options: "i" } })),
      { $expr: { $regexMatch: { input: { $concat: [
        { $substrCP: [{ $ifNull: ["$race", ""] }, 0, 1] }, "v",
        { $substrCP: [{ $ifNull: ["$vsRace", ""] }, 0, 1] },
      ] }, regex: query, options: "i" } } },
    ] });
  }
  if (conditions.length) stages.push({ $match: { $and: conditions } });
  const filteredStages = [...stages];
  if (opts.hideEmpty || opts.sort === "games" || opts.sort === "winRate") {
    stages.push(...buildStatsStages(games, userId));
    if (opts.hideEmpty) stages.push({ $match: { "_stats.total": { $gt: 0 } } });
  }
  const order = opts.sort === "name" ? { $toLower: { $ifNull: ["$name", ""] } }
    : opts.sort === "games" ? "$_stats.total"
      : opts.sort === "winRate" ? { $cond: [
        { $gt: [{ $add: ["$_stats.wins", "$_stats.losses"] }, 0] },
        { $divide: ["$_stats.wins", { $add: ["$_stats.wins", "$_stats.losses"] }] }, 0,
      ] }
        : { $convert: { input: { $convert: { input: "$updatedAt", to: "date", onError: null, onNull: null } }, to: "long", onError: 0, onNull: 0 } };
  const direction = opts.sort === "name" ? 1 : -1;
  /** @type {Record<string, any>[]} */
  const pageStages = [...stages, { $set: { _pageOrder: order } }];
  if (cursor) pageStages.push({ $match: { $or: [
    { _pageOrder: { [direction === 1 ? "$gt" : "$lt"]: cursor.order } },
    { _pageOrder: cursor.order, slug: { $gt: cursor.slug } },
  ] } });
  pageStages.push({ $sort: { _pageOrder: direction, slug: 1 } }, { $limit: opts.limit + 1 });
  if (opts.view === "summary") pageStages.push({ $project: {
    _id: 0, slug: 1, name: 1, race: 1, vsRace: 1, perspective: 1,
    updatedAt: 1, description: 1, sourceGameId: 1, _pageOrder: 1,
  } });
  const libraryCount = collection.countDocuments(match);
  const filteredCount = conditions.length === 0 && !opts.hideEmpty
    ? libraryCount
    : collection.aggregate([
      ...(opts.hideEmpty ? stages : filteredStages), { $count: "total" },
    ], { allowDiskUse: true }).toArray().then((/** @type {any[]} */ counts) => counts[0]?.total || 0);
  const [rows, total, libraryTotal] = await Promise.all([
    collection.aggregate(pageStages, { allowDiskUse: true }).toArray(),
    filteredCount,
    libraryCount,
  ]);
  const items = rows.slice(0, opts.limit);
  const last = items[items.length - 1];
  const nextCursor = rows.length > opts.limit && last
    ? Buffer.from(JSON.stringify({ v: 1, scope, order: last._pageOrder, slug: last.slug })).toString("base64url")
    : null;
  for (const item of items) { delete item._pageOrder; delete item._stats; }
  return { items, total, libraryTotal, limit: opts.limit, nextCursor, truncated: false };
}

module.exports = {
  CUSTOM_BUILD_PAGE_SIZE, CUSTOM_BUILD_MAX_PAGE_SIZE, CUSTOM_BUILD_CLASSIFIER_BATCH_SIZE,
  parseBuildPageOptions, listBuildPage, invalidPage,
};
