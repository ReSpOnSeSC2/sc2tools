"use strict";

const { gamesMatchStage } = require("../util/parseQuery");
const { REGION_LABELS } = require("../util/regionFromToonHandle");
const { readArchiveOverview } = require("./replayArchiveSummary");
const { decodeReplayLibraryCursor, encodeReplayLibraryCursor, replayCursorContinuationBranches, replayNeighborBranches, invalidReplayLibraryCursor } = require("./replayLibraryCursor");
const {
  BUILD_INTENT_LABEL_PROJECTION,
  OPP_INTENT_LABEL_PROJECTION,
  detectorView,
  opponentDetectorView,
} = require("./buildIntentShape");
const {
  detectorLabelMatch,
  opponentDetectorLabelMatch,
  ownerBuildFlags,
} = require("./buildIntentReaders");

// A replay-library page is a human-facing table, not an analysis corpus.
// A modest default keeps first paint quick; the hard ceiling prevents a
// hand-edited URL from turning the endpoint into a complete-history export.
const REPLAY_LIBRARY_LIST_DEFAULT = 50;
const REPLAY_LIBRARY_LIST_LIMIT = 100;
const REPLAY_LIBRARY_SEARCH_MAX_CHARS = 100;

const RACE_LETTERS = new Set(["P", "T", "Z", "R"]);
// Every region label the global filter accepts, PTR included, so a
// saved PTR selection reaches gamesMatchStage instead of being dropped.
const REGION_CODES = new Set(REGION_LABELS);

// Inclusion-only projection for both list and detail reads. Dotted opponent
// and replay-file paths are deliberate: old rows can contain arbitrary large
// children, object-store hashes/keys, or internal identity fields that must
// never be materialised merely because a user opened a replay library.
const REPLAY_LIBRARY_PROJECTION = Object.freeze({
  _id: 1,
  gameId: 1,
  date: 1,
  startedAt: 1,
  result: 1,
  map: 1,
  durationSec: 1,
  playerCount: 1,
  matchFormat: 1,
  // Patch era, with ``date`` (util/patchEra): the macro panel prices units
  // by the replay's own client version, not the date it was played.
  gameVersion: 1,
  gameBuild: 1,
  myRace: 1,
  myMmr: 1,
  myBuild: 1,
  macroScore: 1,
  myToonHandle: 1,
  "opponent.displayName": 1,
  "opponent.race": 1,
  "opponent.mmr": 1,
  "opponent.strategy": 1,
  // These two values are private orchestration inputs. They are copied only
  // into `sourceGames`, which routes must use server-side for VOD resolution
  // and omit from JSON. They never enter the public item serializer below.
  "opponent.toonHandle": 1,
  "opponent.pulseCharacterId": 1,
  // Project only the minimum proof needed to derive the public availability
  // booleans. In particular, never project sha256, md5, upload ids, or keys.
  "replayFile.storedAt": 1,
  "replayFile.sizeBytes": 1,
  // Build check-in label fields only (never notes): owner rows derive
  // ``buildPlanned`` / ``detectedBuild`` and ``oppStrategyPlanned`` /
  // ``detectedOppStrategy``, detector-view rows the classifier's labels.
  // The serializer never copies the subdocument itself.
  ...BUILD_INTENT_LABEL_PROJECTION,
  ...OPP_INTENT_LABEL_PROJECTION,
});

/** @typedef {"owner"|"detector"} ReplayLibraryView */

/**
 * Compact replay-library reads shared by the authenticated and shareable
 * routes. Privacy/visibility gates stay in the route layer; this service
 * always scopes reads to the resolved owner id and emits the same safe DTO.
 */
class ReplayLibraryService {
  /** @param {{games: import('mongodb').Collection}} db */
  constructor(db) {
    if (!db || !db.games) {
      throw new Error("ReplayLibraryService requires db.games");
    }
    this.db = db;
    this.archiveFacets = new Map();
  }

  /**
   * List one deterministic page, newest first.
   *
   * `view: "detector"` (the public archive) labels, filters and searches rows
   * by the classifier's build and opponent strategy, never a build check-in
   * or an opponent correction; the default owner view shows the effective
   * labels plus `buildPlanned` / `detectedBuild` and `oppStrategyPlanned` /
   * `detectedOppStrategy`.
   *
   * @param {string} userId
   * @param {{
   *   filters?: import('../util/parseQuery').GlobalFilters,
   *   result?: unknown,
   *   matchup?: unknown,
   *   search?: unknown,
   *   limit?: unknown,
   *   cursor?: unknown,
   *   sort?: unknown,
   *   view?: ReplayLibraryView,
   *   withSummary?: boolean,
   * }} [opts]
   * @returns {Promise<{
   *   items: Array<Record<string, any>>,
   *   nextCursor: string|null,
   *   hasMore: boolean,
   *   sourceGames: Array<Record<string, any>>,
   *   summary?: any, facets?: any,
   * }>}
   */
  async list(userId, opts = {}) {
    const ownerId = cleanOwnerId(userId);
    if (!ownerId) {
      return {
        items: [],
        nextCursor: null,
        hasMore: false,
        sourceGames: [],
      };
    }

    const limit = clampListLimit(opts.limit);
    const sort = opts.sort === "date_asc" ? "date_asc" : "date_desc";
    const cursor = decodeReplayLibraryCursor(opts.cursor);
    if (cursor && cursor.sort !== sort) throw invalidReplayLibraryCursor();
    const view = replayLibraryView(opts.view);
    const summaryMatch = buildReplayLibraryMatch(ownerId, opts);
    const match = cursor ? { $and: [summaryMatch, { $or: replayCursorContinuationBranches(cursor) }] } : summaryMatch;
    /** @type {[Array<Record<string, any>>, Record<string, any>]} */
    const [rows, overview] = await Promise.all([this.db.games
      .find(match, { projection: REPLAY_LIBRARY_PROJECTION })
      .sort(
        sort === "date_asc"
          ? { date: 1, _id: 1 }
          : { date: -1, _id: -1 },
      )
      .limit(limit + 1)
      .toArray(), opts.withSummary ? readArchiveOverview(this.db.games, ownerId, summaryMatch, this.archiveFacets, buildReplayLibraryMatch(ownerId, { view })) : Promise.resolve({})]);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map((row) => serializeReplayLibraryGame(row, view)),
      nextCursor: hasMore && last
        ? encodeReplayLibraryCursor(last.date, last._id, sort)
        : null,
      hasMore,
      sourceGames: page.map((row) => serializeReplayVodSource(row, view)),
      ...overview,
    };
  }

  /**
   * Return metadata for one replay. Heavy build logs, macro timelines, map
   * playback, and VOD links deliberately remain separate route/service reads.
   * `view` as in `list`.
   *
   * @param {string} userId
   * @param {string} gameId
   * @param {{ view?: ReplayLibraryView }} [opts]
   * @returns {Promise<{
   *   game: Record<string, any>,
   *   sourceGame: Record<string, any>,
   * }|null>}
   */
  async getDetail(userId, gameId, opts = {}) {
    const ownerId = cleanOwnerId(userId);
    const replayId = cleanGameId(gameId);
    if (!ownerId || !replayId) return null;
    const row = await this.db.games.findOne(
      {
        userId: ownerId,
        gameId: replayId,
        isResumedFromReplay: { $ne: true },
      },
      { projection: REPLAY_LIBRARY_PROJECTION },
    );
    const view = replayLibraryView(opts.view);
    return row
      ? {
        game: serializeReplayLibraryGame(row, view),
        sourceGame: serializeReplayVodSource(row, view),
      }
      : null;
  }

  /** Two indexed directional reads after verifying the current filtered position.
   * @param {string} userId @param {string} gameId
   * @param {{filters?:import('../util/parseQuery').GlobalFilters,result?:unknown,matchup?:unknown,search?:unknown}} [opts] */
  async neighbors(userId, gameId, opts = {}) {
    const ownerId = cleanOwnerId(userId); const replayId = cleanGameId(gameId);
    const empty = { olderGameId: null, newerGameId: null };
    if (!ownerId || !replayId) return empty;
    const match = buildReplayLibraryMatch(ownerId, { ...opts, view: "detector" });
    const current = await this.db.games.findOne({ $and: [match, { gameId: replayId }] }, { projection: { _id: 1, date: 1 } });
    if (!current) return empty;
    const read = (/** @type {'date_desc'|'date_asc'} */ sort) => this.db.games.findOne(
      { $and: [match, { $or: replayNeighborBranches(current.date, current._id, sort) }] },
      { projection: { _id: 0, gameId: 1 }, sort: sort === "date_asc" ? { date: 1, _id: 1 } : { date: -1, _id: -1 } },
    );
    const [older, newer] = await Promise.all([read("date_desc"), read("date_asc")]);
    return { olderGameId: cleanGameId(older?.gameId), newerGameId: cleanGameId(newer?.gameId) };
  }
}

/** One eligibility/filter builder for pages, filtered summaries and neighbors.
 * @param {string} ownerId @param {any} opts @returns {Record<string, any>} */
function buildReplayLibraryMatch(ownerId, opts) {
  const view = replayLibraryView(opts.view); const filters = sanitizeGlobalFilters(opts.filters);
  const detectorBuild = view === "detector" ? filters.build : undefined;
  const detectorStrategy = view === "detector" ? filters.oppStrategy : undefined;
  if (detectorBuild !== undefined) delete filters.build;
  if (detectorStrategy !== undefined) delete filters.oppStrategy;
  const clauses = [gamesMatchStage(ownerId, filters)];
  if (detectorBuild !== undefined) clauses.push(detectorLabelMatch("name", detectorBuild));
  if (detectorStrategy !== undefined) clauses.push(opponentDetectorLabelMatch("name", detectorStrategy));
  for (const clause of [resultMatchClause(opts.result), matchupMatchClause(opts.matchup), replaySearchClause(opts.search, view)]) if (clause) clauses.push(clause);
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

/**
 * Copy only the GlobalFilters fields that gamesMatchStage understands. The
 * route normally supplies parseFilters output, but the public endpoint is an
 * unauthenticated input surface, so the service retains its own allow-list
 * and primitive bounds rather than trusting a caller-created object.
 *
 * @param {unknown} raw
 * @returns {import('../util/parseQuery').GlobalFilters}
 */
function sanitizeGlobalFilters(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? /** @type {Record<string, any>} */ (raw)
    : {};
  /** @type {Record<string, any>} */
  const out = {};

  const since = validDate(source.since);
  const until = validDate(source.until);
  if (since) out.since = since;
  if (until) out.until = until;
  if (source.patchEra === "after" || source.patchEra === "before") {
    out.patchEra = source.patchEra;
  }

  const race = filterRaceLetter(source.race);
  const oppRace = filterRaceLetter(source.oppRace);
  if (race) out.race = race;
  if (oppRace) out.oppRace = oppRace;

  const map = boundedFilterString(source.map, 128);
  const oppStrategy = boundedFilterString(source.oppStrategy, 200);
  const build = boundedFilterString(source.build, 200);
  const leak = boundedFilterString(source.leak, 120);
  if (map) out.map = map.toLowerCase();
  if (oppStrategy) out.oppStrategy = oppStrategy;
  if (build) out.build = build;
  if (leak) out.leak = leak;

  copyFiniteFilter(out, source, "mmrMin", -100_000, 100_000);
  copyFiniteFilter(out, source, "mmrMax", -100_000, 100_000);
  copyFiniteFilter(out, source, "macroMin", -1_000, 1_000);
  copyFiniteFilter(out, source, "macroMax", -1_000, 1_000);
  copyFiniteFilter(out, source, "minMinutes", 0, 600);
  copyFiniteFilter(out, source, "maxMinutes", 0, 600);

  if (source.excludeTooShort === true) out.excludeTooShort = true;
  if (source.mapPool === "ladder" || source.mapPool === "nonladder") {
    out.mapPool = source.mapPool;
  }
  if (source.gameSize === "1v1" || source.gameSize === "team") {
    out.gameSize = source.gameSize;
  }

  if (Array.isArray(source.regions)) {
    const regions = [];
    const seen = new Set();
    for (const value of source.regions.slice(0, REGION_CODES.size * 2)) {
      const code = typeof value === "string" ? value.trim().toUpperCase() : "";
      if (!REGION_CODES.has(code) || seen.has(code)) continue;
      seen.add(code);
      regions.push(code);
    }
    if (regions.length > 0) out.regions = regions;
  }

  return /** @type {import('../util/parseQuery').GlobalFilters} */ (out);
}

/** @param {Record<string, any>} out @param {Record<string, any>} source @param {string} key @param {number} min @param {number} max */
function copyFiniteFilter(out, source, key, min, max) {
  if (typeof source[key] !== "number" || !Number.isFinite(source[key])) return;
  out[key] = Math.max(min, Math.min(max, Math.trunc(source[key])));
}

/** @param {unknown} raw @returns {Record<string, any>|null} */
function resultMatchClause(raw) {
  if (typeof raw !== "string") return null;
  switch (raw.trim().toLowerCase()) {
    case "win":
    case "victory":
      return { result: /^(?:Victory|Win)$/i };
    case "loss":
    case "defeat":
      return { result: /^(?:Defeat|Loss)$/i };
    case "tie":
    case "draw":
      return { result: /^(?:Tie|Draw)$/i };
    default:
      return null;
  }
}

/** @param {unknown} raw @returns {Record<string, any>|null} */
function matchupMatchClause(raw) {
  if (typeof raw !== "string") return null;
  const match = /^([PTZR])v([PTZR])$/i.exec(raw.trim());
  if (!match) return null;
  return {
    myRace: new RegExp(`^${match[1]}`, "i"),
    "opponent.race": new RegExp(`^${match[2]}`, "i"),
  };
}

/**
 * @param {unknown} raw
 * @returns {ReplayLibraryView}
 */
function replayLibraryView(raw) {
  return raw === "detector" ? "detector" : "owner";
}

/**
 * @param {unknown} raw
 * @param {ReplayLibraryView} [view] "detector" matches the classifier's build
 *   and opponent labels
 * @returns {Record<string, any>|null}
 */
function replaySearchClause(raw, view = "owner") {
  if (typeof raw !== "string") return null;
  const query = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, REPLAY_LIBRARY_SEARCH_MAX_CHARS);
  if (!query) return null;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(escaped, "i");
  return {
    $or: [
      { map: pattern },
      { "opponent.displayName": pattern },
      view === "detector" ? detectorLabelMatch("name", pattern) : { myBuild: pattern },
      view === "detector"
        ? opponentDetectorLabelMatch("name", pattern)
        : { "opponent.strategy": pattern },
    ],
  };
}

/**
 * Strict client serializer. The returned object is intentionally constructed
 * field-by-field; never spread a Mongo row or nested opponent/replay object.
 * Owner rows carry the effective labels plus `buildPlanned` /
 * `detectedBuild` and `oppStrategyPlanned` / `detectedOppStrategy`;
 * detector-view rows carry only the classifier's labels.
 *
 * @param {Record<string, any>} row
 * @param {ReplayLibraryView} [view]
 * @returns {Record<string, any>}
 */
function serializeReplayLibraryGame(row, view = "owner") {
  const opponent = objectOrEmpty(row?.opponent);
  const replayFile = objectOrEmpty(row?.replayFile);
  const replaySizeBytes = safePositiveInteger(replayFile.sizeBytes);
  const myRace = boundedOutputString(row?.myRace, 24);
  const opponentRace = boundedOutputString(opponent.race, 24);
  return {
    gameId: cleanGameId(row?.gameId),
    date: outputDate(row?.date),
    result: boundedOutputString(row?.result, 24),
    map: boundedOutputString(row?.map, 200),
    durationSec: safeBoundedNumber(row?.durationSec, 0, 24 * 60 * 60, true),
    playerCount: safeBoundedNumber(row?.playerCount, 1, 16, true),
    matchFormat: replayMatchFormat(row?.matchFormat),
    gameVersion: replayGameVersion(row?.gameVersion),
    gameBuild: safePositiveInteger(row?.gameBuild),
    myRace,
    myMmr: safeBoundedNumber(row?.myMmr, 0, 9_999, true),
    ...replayBuildLabel(row, view),
    macroScore: safeBoundedNumber(row?.macroScore, 0, 100, false),
    opponent: {
      displayName: boundedOutputString(opponent.displayName, 80),
      race: opponentRace,
      mmr: safeBoundedNumber(opponent.mmr, 0, 9_999, true),
      strategy: boundedOutputString(replayOpponentStrategy(row, view), 200),
    },
    matchup: matchupLabel(myRace, opponentRace),
    replayAvailable:
      replaySizeBytes !== null && validDateLike(replayFile.storedAt),
    replaySizeBytes,
  };
}

/**
 * @param {Record<string, any>} row
 * @param {ReplayLibraryView} view
 * @returns {Record<string, any>}
 */
function replayBuildLabel(row, view) {
  if (view === "detector") {
    return { myBuild: boundedOutputString(detectorView(row).myBuild, 200) };
  }
  const flags = ownerBuildFlags(row);
  return {
    myBuild: boundedOutputString(row?.myBuild, 200),
    buildPlanned: flags.buildPlanned,
    detectedBuild: boundedOutputString(flags.detectedBuild, 200),
    oppStrategyPlanned: flags.oppStrategyPlanned,
    detectedOppStrategy: boundedOutputString(flags.detectedOppStrategy, 200),
  };
}

/**
 * The opponent strategy a row shows: the classifier's label in the detector
 * view, the effective (possibly corrected) one for the owner.
 *
 * @param {Record<string, any>} row
 * @param {ReplayLibraryView} view
 * @returns {unknown}
 */
function replayOpponentStrategy(row, view) {
  return view === "detector"
    ? opponentDetectorView(row).strategy
    : objectOrEmpty(row?.opponent).strategy;
}

/** @param {unknown} raw */
function replayMatchFormat(raw) {
  return raw === "1v1" || raw === "team" || raw === "ffa" || raw === "other"
    ? raw
    : null;
}

/**
 * The replay's four-part release string ("5.0.16.97425"), in the shape the
 * ingest schema accepts; anything else on a legacy row reads as absent.
 *
 * @param {unknown} raw
 */
function replayGameVersion(raw) {
  return typeof raw === "string" && raw.length <= 40 && /^\d+(?:\.\d+){3}$/.test(raw)
    ? raw
    : null;
}

/**
 * Private, primitives-only VOD input. This is not a second public DTO: it
 * includes the minimum toon/Pulse identity needed by the VOD services and
 * therefore must never be sent to a browser. Labels follow `view` as in
 * `serializeReplayLibraryGame`.
 *
 * @param {Record<string, any>} row
 * @param {ReplayLibraryView} [view]
 * @returns {Record<string, any>}
 */
function serializeReplayVodSource(row, view = "owner") {
  const opponent = objectOrEmpty(row?.opponent);
  return {
    gameId: cleanGameId(row?.gameId),
    date: sourceDate(row?.date),
    startedAt: sourceDate(row?.startedAt),
    durationSec: safeBoundedNumber(row?.durationSec, 0, 24 * 60 * 60, true),
    map: boundedOutputString(row?.map, 200),
    myToonHandle: boundedIdentityString(row?.myToonHandle, 64),
    opponent: {
      displayName: boundedOutputString(opponent.displayName, 80),
      race: boundedOutputString(opponent.race, 24),
      mmr: safeBoundedNumber(opponent.mmr, 0, 9_999, true),
      strategy: boundedOutputString(replayOpponentStrategy(row, view), 200),
      toonHandle: boundedIdentityString(opponent.toonHandle, 64),
      pulseCharacterId: numericIdentity(opponent.pulseCharacterId, 32),
    },
  };
}

/** @param {unknown} raw @returns {number} */
function clampListLimit(raw) {
  const value = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value) || value <= 0) return REPLAY_LIBRARY_LIST_DEFAULT;
  return Math.min(Math.trunc(value), REPLAY_LIBRARY_LIST_LIMIT);
}

/** @param {unknown} raw */
function cleanOwnerId(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value && value.length <= 128 ? value : null;
}

/** @param {unknown} raw */
function cleanGameId(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value && value.length <= 200 ? value : null;
}

/** @param {unknown} raw */
function filterRaceLetter(raw) {
  if (typeof raw !== "string") return null;
  const letter = raw.trim().charAt(0).toUpperCase();
  return RACE_LETTERS.has(letter) ? letter : null;
}

/** @param {unknown} raw @param {number} max */
function boundedFilterString(raw, max) {
  if (typeof raw !== "string") return null;
  const value = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return value || null;
}

/** @param {unknown} raw @param {number} max */
function boundedOutputString(raw, max) {
  if (typeof raw !== "string") return null;
  const value = raw
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
  return value || null;
}

/** @param {unknown} raw @param {number} max */
function boundedIdentityString(raw, max) {
  if (typeof raw !== "string") return null;
  const value = raw.trim().slice(0, max);
  return value && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

/** @param {unknown} raw @param {number} max */
function numericIdentity(raw, max) {
  const value = boundedIdentityString(raw, max);
  return value && /^\d+$/.test(value) ? value : null;
}

/** @param {unknown} raw @returns {Date|null} */
function validDate(raw) {
  let value;
  if (raw instanceof Date) {
    value = new Date(raw.getTime());
  } else if (typeof raw === "string" || typeof raw === "number") {
    value = new Date(raw);
  } else {
    return null;
  }
  return Number.isNaN(value.getTime()) ? null : value;
}

/** @param {unknown} raw */
function validDateLike(raw) {
  if (raw === null || raw === undefined || raw === "") return false;
  return validDate(raw) !== null;
}

/** @param {unknown} raw */
function outputDate(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = validDate(raw);
  return value ? value.toISOString() : null;
}

/** @param {unknown} raw */
function sourceDate(raw) {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return new Date(raw.getTime());
  }
  if (typeof raw === "string") return raw.slice(0, 64);
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  return null;
}

/** @param {unknown} raw */
function safePositiveInteger(raw) {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0
    ? raw
    : null;
}

/** @param {unknown} raw @param {number} min @param {number} max @param {boolean} integer */
function safeBoundedNumber(raw, min, max, integer) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < min || raw > max) return null;
  return integer ? Math.trunc(raw) : raw;
}

/** @param {unknown} raw @returns {Record<string, any>} */
function objectOrEmpty(raw) {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

/** @param {unknown} myRace @param {unknown} opponentRace */
function matchupLabel(myRace, opponentRace) {
  const mine = filterRaceLetter(myRace);
  const theirs = filterRaceLetter(opponentRace);
  return mine && theirs ? `${mine}v${theirs}` : null;
}

module.exports = {
  resultMatchClause,
  ReplayLibraryService,
  REPLAY_LIBRARY_LIST_DEFAULT,
  REPLAY_LIBRARY_LIST_LIMIT,
  REPLAY_LIBRARY_PROJECTION,
  _internals: {
    sanitizeGlobalFilters,
    serializeReplayLibraryGame,
    serializeReplayVodSource,
    decodeReplayLibraryCursor,
    encodeReplayLibraryCursor,
    replaySearchClause,
    replayCursorContinuationBranches,
    matchupMatchClause,
    resultMatchClause,
  },
};
