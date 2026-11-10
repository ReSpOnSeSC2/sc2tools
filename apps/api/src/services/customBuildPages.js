"use strict";

const { createHash } = require("node:crypto");
const { CUSTOM_BUILD_LIBRARY } = require("../config/constants");

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
  if (!["updated", "name", "games", "winRate", "lastPlayed"].includes(sort)) throw invalidPage("Invalid build sort.");
  const matchup = textOption(raw.matchup, "matchup", 10);
  if (matchup && matchup !== "All" && !/^[PTZ]v[PTZ]$/.test(matchup)) throw invalidPage("Invalid matchup.");
  const hideEmpty = raw.hideEmpty === true || raw.hideEmpty === "true";
  if (raw.hideEmpty !== undefined && ![true, false, "true", "false"].includes(raw.hideEmpty)) throw invalidPage("Invalid hideEmpty.");
  const view = textOption(raw.view, "view", 20);
  if (view && view !== "summary") throw invalidPage("Invalid build view.");
  const includeGeneric = raw.includeGeneric === true || raw.includeGeneric === "true";
  if (raw.includeGeneric !== undefined && ![true, false, "true", "false"].includes(raw.includeGeneric)) throw invalidPage("Invalid includeGeneric.");
  // Copies saved from one community build ("Save to my library").
  const forkedFrom = textOption(raw.forkedFrom, "forkedFrom", 80);
  if (forkedFrom && !/^[a-zA-Z0-9._-]+$/.test(forkedFrom)) throw invalidPage("Invalid forkedFrom.");
  return {
    limit, sort, matchup: matchup === "All" ? "" : matchup, hideEmpty, view, includeGeneric, forkedFrom,
    ...libraryFilterOptions(raw),
    search: textOption(raw.search, "search", 200),
    nameSearch: textOption(raw.nameSearch, "name search", 120),
    name: textOption(raw.name, "name", 200),
    normalizedName: textOption(raw.normalizedName, "normalizedName", 200),
    cursor: textOption(raw.cursor, "cursor", 2048),
  };
}

/**
 * Library filters: ``perspective`` (you | opponent), ``published`` (a
 * boolean), ``race`` (P | T | Z, the build's own race) and ``tags`` (comma
 * separated; a build must carry every tag). Bad values are a 400.
 * @param {Record<string, any>} raw
 */
function libraryFilterOptions(raw) {
  const perspective = textOption(raw.perspective, "perspective", 10);
  if (perspective && perspective !== "you" && perspective !== "opponent") throw invalidPage("Invalid perspective.");
  // Parsed options are parsed again by the service: null and arrays round-trip.
  if (raw.published !== undefined && raw.published !== null && ![true, false, "true", "false", "1", "0"].includes(raw.published)) {
    throw invalidPage("Invalid published.");
  }
  const published = raw.published === undefined || raw.published === null ? null
    : raw.published === true || raw.published === "true" || raw.published === "1";
  const race = textOption(raw.race, "race", 2);
  if (race && !/^[PTZ]$/.test(race)) throw invalidPage("Invalid race.");
  const rawTags = Array.isArray(raw.tags) && raw.tags.every((tag) => typeof tag === "string")
    ? raw.tags.join(",")
    : textOption(raw.tags, "tags", (CUSTOM_BUILD_LIBRARY.TAG_MAX_LENGTH + 1) * CUSTOM_BUILD_LIBRARY.TAGS_MAX);
  const tags = rawTags ? [...new Set(rawTags.split(",").map((tag) => tag.replace(/\s+/g, " ").trim()).filter(Boolean))] : [];
  if (tags.length > CUSTOM_BUILD_LIBRARY.TAGS_MAX || tags.some((tag) => tag.length > CUSTOM_BUILD_LIBRARY.TAG_MAX_LENGTH)) {
    throw invalidPage("Invalid tags.");
  }
  return { perspective, published, race, tags };
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
    if (value.v !== 2 || value.scope !== scope || typeof value.slug !== "string" || value.slug.length > 80) throw new Error();
    if (value.pinned !== 0 && value.pinned !== 1) throw new Error();
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
            lastPlayed: { $max: { $convert: { input: "$date", to: "date", onError: null, onNull: null } } },
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

/** @param {ReturnType<typeof parseBuildPageOptions>} opts */
function buildPageConditions(opts) {
  /** @type {Record<string, any>[]} */
  const conditions = [];
  if (opts.name) conditions.push({ $or: [{ name: opts.name }, { slug: opts.name }] });
  if (opts.nameSearch) conditions.push({ name: { $regex: escapeRegex(opts.nameSearch), $options: "i" } });
  if (opts.forkedFrom) conditions.push({ "forkedFrom.communitySlug": opts.forkedFrom });
  if (opts.perspective === "opponent") conditions.push({ perspective: "opponent" });
  if (opts.perspective === "you") conditions.push({ perspective: { $ne: "opponent" } });
  if (opts.published === true) conditions.push({ isPublic: true });
  if (opts.published === false) conditions.push({ isPublic: { $ne: true } });
  if (opts.race) {
    const names = { P: "Protoss", T: "Terran", Z: "Zerg" };
    conditions.push({ race: { $regex: `^(?:${opts.race}|${names[/** @type {keyof typeof names} */ (opts.race)]})$`, $options: "i" } });
  }
  if (opts.tags && opts.tags.length) {
    conditions.push({ $and: opts.tags.map((tag) => ({ tags: { $regex: `^${escapeRegex(tag)}$`, $options: "i" } })) });
  }
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
  return conditions;
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
  const conditions = buildPageConditions(opts);
  if (conditions.length) stages.push({ $match: { $and: conditions } });
  const filteredStages = [...stages];
  if (opts.hideEmpty || ["games", "winRate", "lastPlayed"].includes(opts.sort)) {
    stages.push(...buildStatsStages(games, userId));
    if (opts.hideEmpty) stages.push({ $match: { "_stats.total": { $gt: 0 } } });
  }
  const order = opts.sort === "name" ? { $toLower: { $ifNull: ["$name", ""] } }
    : opts.sort === "games" ? "$_stats.total"
      : opts.sort === "lastPlayed" ? { $convert: { input: "$_stats.lastPlayed", to: "long", onError: 0, onNull: 0 } }
      : opts.sort === "winRate" ? { $cond: [
        { $gt: [{ $add: ["$_stats.wins", "$_stats.losses"] }, 0] },
        { $divide: ["$_stats.wins", { $add: ["$_stats.wins", "$_stats.losses"] }] }, 0,
      ] }
        : { $convert: { input: { $convert: { input: "$updatedAt", to: "date", onError: null, onNull: null } }, to: "long", onError: 0, onNull: 0 } };
  const direction = opts.sort === "name" ? 1 : -1;
  // Pinned builds lead every sort; the cursor carries the pin band.
  /** @type {Record<string, any>[]} */
  const pageStages = [...stages, { $set: { _pageOrder: order, _pinned: { $cond: [{ $eq: ["$pinned", true] }, 1, 0] } } }];
  if (cursor) pageStages.push({ $match: { $or: [
    { _pinned: { $lt: cursor.pinned } },
    { _pinned: cursor.pinned, _pageOrder: { [direction === 1 ? "$gt" : "$lt"]: cursor.order } },
    { _pinned: cursor.pinned, _pageOrder: cursor.order, slug: { $gt: cursor.slug } },
  ] } });
  pageStages.push({ $sort: { _pinned: -1, _pageOrder: direction, slug: 1 } }, { $limit: opts.limit + 1 });
  if (opts.view === "summary") pageStages.push({ $project: {
    _id: 0, slug: 1, name: 1, race: 1, vsRace: 1, perspective: 1,
    updatedAt: 1, description: 1, sourceGameId: 1, "forkedFrom.communitySlug": 1, _pageOrder: 1, _pinned: 1,
  } });
  const libraryCount = collection.countDocuments(match);
  const filteredCount = conditions.length === 0 && !opts.hideEmpty
    ? libraryCount
    : collection.aggregate([
      ...(opts.hideEmpty ? stages : filteredStages), { $count: "total" },
    ], { allowDiskUse: true }).toArray().then((/** @type {any[]} */ counts) => counts[0]?.total || 0);
  const [rows, total, libraryTotal, availableTags] = await Promise.all([
    collection.aggregate(pageStages, { allowDiskUse: true }).toArray(),
    filteredCount,
    libraryCount,
    opts.view === "summary" ? Promise.resolve(undefined) : libraryTags(collection, userId),
  ]);
  const items = rows.slice(0, opts.limit);
  const last = items[items.length - 1];
  const nextCursor = rows.length > opts.limit && last
    ? Buffer.from(JSON.stringify({ v: 2, scope, pinned: last._pinned === 1 ? 1 : 0, order: last._pageOrder, slug: last.slug })).toString("base64url")
    : null;
  for (const item of items) { delete item._pageOrder; delete item._stats; delete item._pinned; }
  return {
    items, total, libraryTotal, limit: opts.limit, nextCursor, truncated: false,
    ...(availableTags ? { availableTags } : {}),
  };
}

/**
 * Every tag in the account's live library with its build count, most used
 * first (the filter bar's tag chips).
 * @param {any} collection
 * @param {string} userId
 * @returns {Promise<Array<{tag: string, count: number}>>}
 */
async function libraryTags(collection, userId) {
  const rows = await collection.aggregate([
    { $match: { userId, deletedAt: { $exists: false }, "tags.0": { $exists: true } } },
    { $project: { _id: 0, tags: { $slice: [{ $filter: { input: "$tags", cond: { $eq: [{ $type: "$$this" }, "string"] } } }, CUSTOM_BUILD_LIBRARY.TAGS_MAX] } } },
    { $unwind: "$tags" },
    // One spelling per tag, the same every time.
    { $sort: { tags: 1 } },
    { $group: { _id: { $toLower: "$tags" }, tag: { $first: "$tags" }, count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
    { $limit: CUSTOM_BUILD_LIBRARY.AVAILABLE_TAGS_MAX },
  ]).toArray();
  return rows.map((/** @type {any} */ row) => ({ tag: String(row.tag).slice(0, CUSTOM_BUILD_LIBRARY.TAG_MAX_LENGTH), count: Number(row.count) || 0 }));
}

module.exports = {
  CUSTOM_BUILD_PAGE_SIZE, CUSTOM_BUILD_MAX_PAGE_SIZE, CUSTOM_BUILD_CLASSIFIER_BATCH_SIZE,
  parseBuildPageOptions, listBuildPage, invalidPage,
};
