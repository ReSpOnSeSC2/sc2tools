"use strict";

const { gamesMatchStage } = require("../util/parseQuery");
const { analyzeSummary, historicalMmr, historicalOpponentMmr } = require("./trendsExplorerStats");
const { analyzeDetail, milestoneLabel } = require("./trendsExplorerDetail");
const { stringExpr } = require("./adminGlobalTrendsScope");

const VIEWS = new Set(["mmr-gap", "periods", "groups", "execution", "leads", "breaks", "rematches"]);
const DETAIL_VIEWS = new Set(["execution", "leads"]);
const SUMMARY_READ_VIEWS = new Set([...DETAIL_VIEWS, "mmr-gap"]);
const SEQUENCE_VIEWS = new Set(["breaks", "rematches"]);
const DAY_MS = 86400000;
const DETAIL_BATCH_SIZE = 2000;
// A private adapter hint, never parsed from request input or serialized as a
// Mongo command field. Sequence context must retain intervening off-race games.
const EXPLORER_SEQUENCE_HISTORY = Symbol("trendsExplorerSequenceHistory");
/** @typedef {{games: import('mongodb').Collection, gameDetails?: import('mongodb').Collection}} ExplorerDb */
// Only compact source facts are read. Raw replay arrays never enter a chart
// request, including installations whose detail blobs live in object storage.
const PROJECTION = {
  _id: 0, userId: 1, gameId: 1, date: 1, startedAt: 1,
  myToonHandle: 1, myRace: 1, myLadderRace: 1, myMmr: 1, myMmrSource: 1,
  result: 1, durationSec: 1, map: 1, myBuild: 1,
  isLadderGame: 1, playerCount: 1, matchFormat: 1,
  "opponent.displayName": 1, "opponent.race": 1, "opponent.strategy": 1,
  "opponent.mmr": 1, "opponent.mmrSource": 1, "opponent.mmrLookupAttempted": 1,
  "opponent.pulseId": 1, "opponent.pulseCharacterId": 1,
  "opponent.toonHandle": 1, "opponent.region": 1,
  playerId: { $ifNull: ["$_globalPlayerId", { $cond: [
    { $ne: [stringExpr("$myToonHandle"), ""] }, stringExpr("$myToonHandle"), { $concat: ["user:", "$userId"] },
  ] }] },
};

/** @param {string} message */
function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: "invalid_trends_options", expose: true });
}

/** @param {unknown} raw @param {number} fallback @param {number} min @param {number} max */
function numeric(raw, fallback, min, max) {
  if (raw === undefined || raw === "") return fallback;
  if (typeof raw !== "string" && typeof raw !== "number") throw invalid("Invalid numeric control.");
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) throw invalid(`Enter a whole number between ${min} and ${max}.`);
  return n;
}

/** @param {unknown} value @param {string[]} values @param {string} fallback */
function choice(value, values, fallback) {
  if (value === undefined || value === "") return fallback;
  if (typeof value !== "string" || !values.includes(value)) throw invalid("Unsupported analysis control.");
  return value;
}

/** Strict calendar dates; upper endpoints include the entire selected UTC day.
 * @param {unknown} raw @param {Date} fallback @param {boolean} end */
function dateBound(raw, fallback, end) {
  if (raw === undefined || raw === "") return fallback;
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw invalid("Choose a valid comparison date.");
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== raw) throw invalid("Choose a valid comparison date.");
  return new Date(date.getTime() + (end ? DAY_MS - 1 : 0));
}

/** @param {unknown} raw */
function players(raw) {
  if (raw === undefined || raw === "") return [];
  if (typeof raw !== "string" || raw.length > 24000) throw invalid("Invalid player selection.");
  const values = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  if (values.length > 500 || values.some((v) => v.length > 180)) throw invalid("Choose at most 500 players per group.");
  return values;
}

/** Parse only this feature's controls; arbitrary query parameters never reach
 * Mongo pipelines or become unbounded cache keys.
 * @param {unknown} view @param {Record<string, unknown>} q @param {Date} [now] */
function parseExplorerOptions(view, q = {}, now = new Date()) {
  if (typeof view !== "string" || !VIEWS.has(view)) throw invalid("Unknown Trends analysis.");
  const dayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY_MS - 1);
  const aSince = dateBound(q.a_since, new Date(dayEnd.getTime() - 30 * DAY_MS + 1), false);
  const aUntil = dateBound(q.a_until, dayEnd, true);
  const duration = aUntil.getTime() - aSince.getTime() + 1;
  const bUntil = dateBound(q.b_until, new Date(aSince.getTime() - 1), true);
  const bSince = dateBound(q.b_since, new Date(bUntil.getTime() - duration + 1), false);
  if (aSince > aUntil || bSince > bUntil) throw invalid("Each comparison period must end on or after its start date.");
  const aMin = numeric(q.a_min, 0, 0, 10000);
  const aMax = numeric(q.a_max, 4000, 0, 10001);
  const bMin = numeric(q.b_min, 4000, 0, 10000);
  const bMax = numeric(q.b_max, 10001, 0, 10001);
  if (aMin >= aMax || bMin >= bMax) throw invalid("Each MMR group needs a maximum above its minimum.");
  const milestone = q.milestone === undefined ? "third-base" : q.milestone;
  if (typeof milestone !== "string" || milestone.length > 140 || !/^[\w: .'-]+$/.test(milestone)) throw invalid("Invalid execution milestone.");
  return {
    view, gapWidth: Number(choice(q.gap_width === undefined ? undefined : String(q.gap_width), ["100", "200", "500"], "200")),
    aSince, aUntil, bSince, bUntil,
    groupMode: choice(q.group_mode, ["mmr", "players"], "mmr"),
    aMin, aMax, bMin, bMax, aPlayers: players(q.a_players), bPlayers: players(q.b_players),
    weight: choice(q.weight, ["games", "players"], "games"),
    milestone,
    interval: choice(q.interval, ["auto", "week", "month"], "auto"),
    checkpoint: Number(choice(q.checkpoint === undefined ? undefined : String(q.checkpoint), ["300", "480", "720"], "480")),
    metric: choice(q.metric, ["workers", "army"], "workers"),
    after: choice(q.after, ["all", "loss", "win"], "all"),
    segment: typeof q.segment === "string" && q.segment.length <= 400 ? q.segment : undefined,
    offset: numeric(q.offset, 0, 0, 10000000), limit: numeric(q.limit, 20, 1, 100),
    games: false,
  };
}

/** @param {Record<string, any>} record */
function gameKey(record) { return `${record.userId}|${record.gameId}`; }

/** @param {ExplorerDb} db @param {string} userId
 * @param {Record<string, any>} filters @param {ReturnType<typeof parseExplorerOptions>} opts
 * @param {boolean} [history] @param {Set<string>} [milestoneIds] */
async function readRecords(db, userId, filters, opts, history = false, milestoneIds) {
  const scoped = { ...filters };
  if (opts.view === "periods") { delete scoped.since; delete scoped.until; }
  const pipeline = [{ $match: gamesMatchStage(userId, history ? {} : scoped) }];
  if (opts.view === "periods") pipeline.push({ $match: { $or: [
    { date: { $gte: opts.aSince, $lte: opts.aUntil } },
    { date: { $gte: opts.bSince, $lte: opts.bUntil } },
  ] } });
  const stages = /** @type {Array<Record<string, any>>} */ (pipeline);
  stages.push({ $project: recordProjection(opts) });
  if (SUMMARY_READ_VIEWS.has(opts.view) && !db.gameDetails) {
    stages.push({ $lookup: {
      from: "game_details", let: { uid: "$userId", gid: "$gameId" },
      pipeline: [{ $match: { $expr: { $and: [
        { $eq: ["$userId", "$$uid"] }, { $eq: ["$gameId", "$$gid"] },
      ] } } }, { $project: detailProjection(opts) }, { $limit: 1 }],
      as: "_detail",
    } }, { $set: {
      trendsExplorerDetail: { $arrayElemAt: ["$_detail.trendsExplorerDetail", 0] },
      _detailExists: { $gt: [{ $size: "$_detail" }, 0] },
      _detailPending: { $eq: [{ $arrayElemAt: ["$_detail._ready", 0] }, false] },
    } }, { $unset: "_detail" });
  }
  const aggregateOptions = { allowDiskUse: true, maxTimeMS: 25000,
    ...(history && SEQUENCE_VIEWS.has(opts.view) ? { [EXPLORER_SEQUENCE_HISTORY]: true } : {}) };
  const records = await db.games.aggregate(stages, aggregateOptions).toArray();
  if (SUMMARY_READ_VIEWS.has(opts.view) && db.gameDetails) {
    await attachCompactDetails(db.gameDetails, records, opts, milestoneIds);
  }
  return records;
}

/**
 * Correlated lookups repeatedly initialize a foreign pipeline for every game.
 * At global scale the real production join takes ~20 seconds even warm. Read
 * indexed batches instead, using identities from the already authorized and
 * deduplicated source rows. One batch is retained at a time; neither heavy
 * replay blobs nor all games' milestone catalogues enter the result graph.
 * @param {import('mongodb').Collection} collection
 * @param {Array<Record<string, any>>} records
 * @param {ReturnType<typeof parseExplorerOptions>} opts
 * @param {Set<string>} [milestoneIds]
 */
async function attachCompactDetails(collection, records, opts, milestoneIds) {
  /** @type {Map<string, Array<Record<string, any>>>} */
  const users = new Map();
  for (const record of records) {
    record._detailExists = false;
    record._detailPending = false;
    // Malformed legacy IDs cannot establish a scoped source pair. They are
    // unavailable, rather than unbounded empty-variable foreign scans.
    if (typeof record.userId !== "string" || !record.userId
      || typeof record.gameId !== "string" || !record.gameId) continue;
    if (!users.has(record.userId)) users.set(record.userId, []);
    users.get(record.userId)?.push(record);
  }
  /** @type {Record<string, any>} */
  const projection = { ...detailProjection(opts), userId: 1, gameId: 1 };
  if (milestoneIds) projection._milestoneIds = { $concatArrays: [
    { $ifNull: ["$trendsExplorerDetail.build.milestones.id", []] },
    { $ifNull: ["$trendsExplorerDetail.bases.milestones.id", []] },
  ] };
  for (const [userId, games] of users) {
    for (let offset = 0; offset < games.length; offset += DETAIL_BATCH_SIZE) {
      const batch = games.slice(offset, offset + DETAIL_BATCH_SIZE);
      /** @type {Map<string, Array<Record<string, any>>>} */
      const byGame = new Map();
      for (const record of batch) {
        if (!byGame.has(record.gameId)) byGame.set(record.gameId, []);
        byGame.get(record.gameId)?.push(record);
      }
      const rows = await collection.aggregate([
        { $match: { userId, gameId: { $in: [...byGame.keys()] } } },
        { $project: projection },
      ], { maxTimeMS: 25000 }).toArray();
      for (const row of rows) {
        // Defend the in-memory merge as well as the database predicate. A
        // coincident replay ID from another uploader never supplies facts.
        if (row.userId !== userId || !byGame.has(row.gameId)) continue;
        for (const record of byGame.get(row.gameId) || []) {
          record.trendsExplorerDetail = row.trendsExplorerDetail;
          record._detailExists = true;
          record._detailPending = row._ready === false;
        }
        if (milestoneIds && Array.isArray(row._milestoneIds)) {
          for (const id of row._milestoneIds) if (typeof id === "string") milestoneIds.add(id);
        }
      }
    }
  }
}

/** @param {ReturnType<typeof parseExplorerOptions>} opts */
function recordProjection(opts) {
  if (opts.games) return PROJECTION;
  /** @type {Record<string, any>} */
  const fields = { _id: 0, userId: 1, gameId: 1, result: 1, playerId: PROJECTION.playerId };
  if (opts.view === "leads") Object.assign(fields, { myRace: 1, "opponent.race": 1, matchFormat: 1, playerCount: 1, durationSec: 1 });
  else if (opts.view === "execution") fields.date = 1;
  else {
    Object.assign(fields, { myMmr: 1, myMmrSource: 1, durationSec: 1 });
    if (opts.view === "mmr-gap") Object.assign(fields, { "opponent.mmr": 1, "opponent.mmrSource": 1 });
    else Object.assign(fields, { date: 1, myRace: 1, "opponent.race": 1, myBuild: 1 });
    if (SEQUENCE_VIEWS.has(opts.view)) Object.assign(fields, { startedAt: 1, myLadderRace: 1, isLadderGame: 1, playerCount: 1, matchFormat: 1 });
    if (opts.view === "rematches") Object.assign(fields, { "opponent.toonHandle": 1, "opponent.pulseId": 1, "opponent.pulseCharacterId": 1, "opponent.region": 1 });
  }
  return fields;
}

/** Return only the facts used by the active analysis. Full milestone arrays
 * multiplied by a global history can otherwise exhaust a small API heap.
 * @param {ReturnType<typeof parseExplorerOptions>} opts */
function detailProjection(opts) {
  const neededBranch = opts.view === "mmr-gap" ? "ratings" : opts.view === "leads" ? "leads"
    : opts.milestone.endsWith("-base") ? "bases" : "build";
  /** @type {Record<string, any>} */
  const projection = { _id: 0, "trendsExplorerDetail.version": 1, _ready: { $and: [
    { $eq: ["$trendsExplorerDetail.version", 1] },
    { $ne: [{ $type: `$trendsExplorerDetail.${neededBranch}` }, "missing"] },
  ] } };
  if (opts.view === "mmr-gap") projection["trendsExplorerDetail.ratings"] = 1;
  else if (opts.view === "leads") {
    projection["trendsExplorerDetail.leads.available"] = 1;
    projection["trendsExplorerDetail.leads.snapshots"] = { $map: {
      input: { $filter: { input: { $ifNull: ["$trendsExplorerDetail.leads.snapshots", []] }, as: "sample", cond: { $eq: ["$$sample.second", opts.checkpoint] } } },
      as: "sample", in: { second: "$$sample.second", at: "$$sample.at", [opts.metric]: `$$sample.${opts.metric}` },
    } };
  }
  else for (const branch of ["build", "bases"]) {
    projection[`trendsExplorerDetail.${branch}.available`] = 1;
    projection[`trendsExplorerDetail.${branch}.milestones`] = { $filter: {
      input: { $ifNull: [`$trendsExplorerDetail.${branch}.milestones`, []] }, as: "milestone",
      cond: { $eq: ["$$milestone.id", { $literal: opts.milestone }] },
    } };
  }
  return projection;
}

/** Discover selectable timings inside Mongo; never retain every replay's
 * entire build catalogue in the Node process.
 * @param {{games: import('mongodb').Collection}} db @param {string} userId
 * @param {Record<string, any>} filters */
async function executionMilestones(db, userId, filters) {
  const rows = await db.games.aggregate([
    { $match: gamesMatchStage(userId, filters) },
    { $project: { userId: 1, gameId: 1 } },
    { $lookup: { from: "game_details", let: { uid: "$userId", gid: "$gameId" }, pipeline: [
      { $match: { $expr: { $and: [{ $eq: ["$userId", "$$uid"] }, { $eq: ["$gameId", "$$gid"] }] } } },
      { $project: { _id: 0, ids: { $concatArrays: [
        { $ifNull: ["$trendsExplorerDetail.build.milestones.id", []] },
        { $ifNull: ["$trendsExplorerDetail.bases.milestones.id", []] },
      ] } } },
    ], as: "detail" } },
    { $unwind: "$detail" }, { $group: { _id: "$detail.ids" } },
    { $unwind: "$_id" }, { $group: { _id: "$_id" } },
  ], { maxTimeMS: 25000, allowDiskUse: true }).toArray();
  return [...new Set(["second-base", "third-base", ...rows.map((r) => r._id)])]
    .sort().map((id) => ({ id, label: milestoneLabel(id) }));
}

/** Recover display ratings only after membership and pagination are settled.
 * The source-page identities are server-derived; both uploader and replay ID
 * stay in the join, including through the authenticated global adapter.
 * @param {{games: import('mongodb').Collection}} db @param {string} userId
 * @param {Array<Record<string, any>>} page */
async function attachPageRatings(db, userId, page) {
  const missing = page.filter((row) => !Object.prototype.hasOwnProperty.call(row.trendsExplorerDetail || {}, "ratings")
    && (historicalMmr(row) === null || historicalOpponentMmr(row) === null));
  if (!missing.length) return page;
  const rows = await db.games.aggregate([
    { $match: { ...gamesMatchStage(userId, {}), $and: [{ $or: missing.map((row) => ({ userId: row.userId, gameId: row.gameId })) }] } },
    { $project: { _id: 0, userId: 1, gameId: 1 } },
    { $lookup: { from: "game_details", let: { uid: "$userId", gid: "$gameId" }, pipeline: [
      { $match: { $expr: { $and: [{ $eq: ["$userId", "$$uid"] }, { $eq: ["$gameId", "$$gid"] }] } } },
      { $project: { _id: 0, "trendsExplorerDetail.ratings": 1 } }, { $limit: 1 },
    ], as: "detail" } },
    { $project: { userId: 1, gameId: 1, ratings: { $arrayElemAt: ["$detail.trendsExplorerDetail.ratings", 0] } } },
  ], { maxTimeMS: 25000 }).toArray();
  const ratings = new Map(rows.map((row) => [gameKey(row), row.ratings]));
  return page.map((row) => ratings.has(gameKey(row))
    ? { ...row, trendsExplorerDetail: { ...row.trendsExplorerDetail, ratings: ratings.get(gameKey(row)) } }
    : row);
}

/** @param {Record<string, any>} row */
function publicGame(row) {
  return {
    id: row.gameId, date: row.date, map: row.map || "Unknown map", result: row.result,
    playerId: row.playerId, playerName: row.playerName || (String(row.playerId).startsWith("user:") ? "Unidentified account" : row.playerId),
    opponent: row.opponent?.displayName || "Unknown opponent",
    myRace: row.myRace || "Unknown", oppRace: row.opponent?.race || "Unknown",
    myMmr: historicalMmr(row), opponentMmr: historicalOpponentMmr(row),
    build: row.myBuild || "Unknown build", durationSec: Number.isFinite(row.durationSec) ? row.durationSec : null,
  };
}

/** A separate, small admission lane bounds retained source rows. It never
 * holds a database slot while waiting for the global query executor.
 * @type {Array<() => void>} */
const waiting = [];
let active = 0;

/** @param {() => Promise<any>} work */
async function admitted(work) {
  if (active >= 1) {
    if (waiting.length >= 16) throw Object.assign(new Error("Trends is busy. Try again shortly."), { status: 503, expose: true });
    await new Promise((resolve, reject) => {
      const ready = () => { clearTimeout(timer); resolve(undefined); };
      const timer = setTimeout(() => {
        const i = waiting.indexOf(ready);
        if (i >= 0) waiting.splice(i, 1);
        reject(Object.assign(new Error("Trends is busy. Try again shortly."), { status: 503, expose: true }));
      }, 25000);
      waiting.push(ready);
    });
  } else active += 1;
  try { return await work(); } finally {
    const ready = waiting.shift();
    if (ready) ready(); else active -= 1;
  }
}

/** @param {ExplorerDb} db @param {string} userId
 * @param {Record<string, any>} filters @param {ReturnType<typeof parseExplorerOptions>} opts */
function trendsExplorer(db, userId, filters, opts) {
  return admitted(async () => {
    const milestoneIds = opts.view === "execution" && !opts.games && db.gameDetails
      ? new Set(["second-base", "third-base"]) : undefined;
    let selected = await readRecords(db, userId, filters, opts, false, milestoneIds);
    let records = selected;
    if (SEQUENCE_VIEWS.has(opts.view) && selected.length) {
      const keys = new Set(selected.map(gameKey));
      records = await readRecords(db, userId, filters, opts, true);
      for (const record of records) record.matches = keys.has(gameKey(record));
      selected = records.filter((record) => record.matches);
    }
    /** @type {Record<string, any>} */
    const analysis = DETAIL_VIEWS.has(opts.view)
      ? analyzeDetail(opts.view, records, opts)
      : analyzeSummary(opts.view, records, opts);
    if (opts.games) {
      const row = [...analysis.rows, ...(analysis.breakdown || [])].find((/** @type {any} */ r) => r.key === opts.segment);
      if (!row) throw invalid("Choose a chart segment to inspect its games.");
      const keys = new Set(row.gameKeys || []);
      const games = selected.filter((record) => keys.has(gameKey(record)))
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime() || String(a.gameId).localeCompare(String(b.gameId)));
      const page = await attachPageRatings(db, userId, games.slice(opts.offset, opts.offset + opts.limit));
      return { total: games.length, offset: opts.offset, limit: opts.limit,
        games: page.map(publicGame) };
    }
    const playerMap = new Map();
    if (opts.view === "groups") for (const row of selected) {
      if (!playerMap.has(row.playerId)) playerMap.set(row.playerId, {
        id: row.playerId, label: String(row.playerId).startsWith("user:") ? "Unidentified account" : row.playerId,
        currentMmr: null,
      });
    }
    // A historical date filter must not turn the directory's latest MMR into
    // a rating from that selected period. The global adapter replaces these
    // values with its existing source-aware current player directory.
    if (opts.view === "groups" && playerMap.size) {
      const latest = await db.games.aggregate([
        { $match: { ...gamesMatchStage(userId, {}), myMmrSource: "replay", myMmr: { $type: "number", $gt: 0, $lte: 9999 } } },
        { $project: { date: 1, myMmr: 1, playerId: PROJECTION.playerId } },
        { $sort: { date: -1 } }, { $group: { _id: "$playerId", mmr: { $first: "$myMmr" } } },
      ], { maxTimeMS: 25000 }).toArray();
      for (const row of latest) if (playerMap.has(row._id)) playerMap.get(row._id).currentMmr = row.mmr;
    }
    let builds = [];
    let milestones = analysis.options?.milestones || [];
    if (opts.view === "execution") {
      const { build: _build, ...remaining } = filters;
      builds = (await db.games.aggregate([
        { $match: gamesMatchStage(userId, remaining) },
        { $group: { _id: "$myBuild" } }, { $match: { _id: { $type: "string", $ne: "" } } }, { $sort: { _id: 1 } },
      ], { maxTimeMS: 25000 }).toArray()).map((row) => row._id);
      milestones = milestoneIds
        ? [...milestoneIds].sort().map((id) => ({ id, label: milestoneLabel(id) }))
        : await executionMilestones(db, userId, filters);
    }
    const pendingGames = selected.filter((record) => record._detailExists && record._detailPending).length;
    return {
      view: opts.view, totalGames: selected.length, eligibleGames: analysis.eligibleGames,
      rows: analysis.rows.map((/** @type {any} */ row) => { const { gameKeys: _keys, ...rest } = row; return rest; }),
      preparation: { pendingGames },
      notes: [...(analysis.notes || []), ...(pendingGames ? [`Replay summaries are being prepared for ${pendingGames.toLocaleString("en-US")} matching games. This analysis updates automatically as they become available.`] : [])],
      breakdown: (analysis.breakdown || []).map((/** @type {any} */ row) => {
        const { gameKeys: _keys, ...rest } = row; return rest;
      }),
      options: { players: [...playerMap.values()].sort((a, b) => a.label.localeCompare(b.label)),
        builds,
        milestones,
      },
    };
  });
}

module.exports = { trendsExplorer, parseExplorerOptions, readRecords, publicGame, VIEWS, EXPLORER_SEQUENCE_HISTORY };
