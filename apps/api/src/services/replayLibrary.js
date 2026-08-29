"use strict";

const { ObjectId } = require("mongodb");
const { gamesMatchStage } = require("../util/parseQuery");

// A replay-library page is a human-facing table, not an analysis corpus.
// A modest default keeps first paint quick; the hard ceiling prevents a
// hand-edited URL from turning the endpoint into a complete-history export.
const REPLAY_LIBRARY_LIST_DEFAULT = 50;
const REPLAY_LIBRARY_LIST_LIMIT = 100;
const REPLAY_LIBRARY_CURSOR_MAX_CHARS = 512;
const REPLAY_LIBRARY_SEARCH_MAX_CHARS = 100;

const RACE_LETTERS = new Set(["P", "T", "Z", "R"]);
const REGION_CODES = new Set(["NA", "EU", "KR", "CN", "SEA"]);

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
});

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
  }

  /**
   * List one deterministic page, newest first.
   *
   * `sourceGames` is a strict, bounded, server-only companion array for
   * GameVodLinksService. A route may pass it to that service, but must omit it
   * from its JSON response. Keeping it separate makes accidental spreading of
   * toon/Pulse identifiers into a public replay row much harder.
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
   * }} [opts]
   * @returns {Promise<{
   *   items: Array<Record<string, any>>,
   *   nextCursor: string|null,
   *   hasMore: boolean,
   *   sourceGames: Array<Record<string, any>>,
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
    const filters = sanitizeGlobalFilters(opts.filters);
    /** @type {Array<Record<string, any>>} */
    const clauses = [gamesMatchStage(ownerId, filters)];

    const resultClause = resultMatchClause(opts.result);
    if (resultClause) clauses.push(resultClause);

    const matchupClause = matchupMatchClause(opts.matchup);
    if (matchupClause) clauses.push(matchupClause);

    const searchClause = replaySearchClause(opts.search);
    if (searchClause) clauses.push(searchClause);

    if (cursor) {
      clauses.push({ $or: replayCursorContinuationBranches(cursor) });
    }

    const match = clauses.length === 1 ? clauses[0] : { $and: clauses };
    /** @type {Array<Record<string, any>>} */
    const rows = await this.db.games
      .find(match, { projection: REPLAY_LIBRARY_PROJECTION })
      .sort(
        sort === "date_asc"
          ? { date: 1, _id: 1 }
          : { date: -1, _id: -1 },
      )
      .limit(limit + 1)
      .toArray();

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map(serializeReplayLibraryGame),
      nextCursor: hasMore && last
        ? encodeReplayLibraryCursor(last.date, last._id, sort)
        : null,
      hasMore,
      sourceGames: page.map(serializeReplayVodSource),
    };
  }

  /**
   * Return metadata for one replay. Heavy build logs, macro timelines, map
   * playback, and VOD links deliberately remain separate route/service reads.
   *
   * @param {string} userId
   * @param {string} gameId
   * @returns {Promise<{
   *   game: Record<string, any>,
   *   sourceGame: Record<string, any>,
   * }|null>}
   */
  async getDetail(userId, gameId) {
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
    return row
      ? {
        game: serializeReplayLibraryGame(row),
        sourceGame: serializeReplayVodSource(row),
      }
      : null;
  }
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

/** @param {unknown} raw @returns {Record<string, any>|null} */
function replaySearchClause(raw) {
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
      { myBuild: pattern },
      { "opponent.strategy": pattern },
    ],
  };
}

/**
 * Strict client serializer. The returned object is intentionally constructed
 * field-by-field; never spread a Mongo row or nested opponent/replay object.
 *
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
 */
function serializeReplayLibraryGame(row) {
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
    myRace,
    myMmr: safeBoundedNumber(row?.myMmr, 0, 9_999, true),
    myBuild: boundedOutputString(row?.myBuild, 200),
    macroScore: safeBoundedNumber(row?.macroScore, 0, 100, false),
    opponent: {
      displayName: boundedOutputString(opponent.displayName, 80),
      race: opponentRace,
      mmr: safeBoundedNumber(opponent.mmr, 0, 9_999, true),
      strategy: boundedOutputString(opponent.strategy, 200),
    },
    matchup: matchupLabel(myRace, opponentRace),
    replayAvailable:
      replaySizeBytes !== null && validDateLike(replayFile.storedAt),
    replaySizeBytes,
  };
}

/** @param {unknown} raw */
function replayMatchFormat(raw) {
  return raw === "1v1" || raw === "team" || raw === "ffa" || raw === "other"
    ? raw
    : null;
}

/**
 * Private, primitives-only VOD input. This is not a second public DTO: it
 * includes the minimum toon/Pulse identity needed by the VOD services and
 * therefore must never be sent to a browser.
 *
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
 */
function serializeReplayVodSource(row) {
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
      strategy: boundedOutputString(opponent.strategy, 200),
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

/**
 * Cursor v2 preserves the raw sortable BSON date type. Historical imports can
 * carry ISO strings, numeric epochs, or null; explicit lower-type branches
 * keep pagination gap-free when a page crosses one of those cohorts.
 *
 * @param {unknown} raw
 * @returns {{dateType:'date'|'string'|'number'|'null',date:Date|string|number|null,id:import('mongodb').ObjectId,sort:'date_asc'|'date_desc'}|null}
 */
function decodeReplayLibraryCursor(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || raw.length > REPLAY_LIBRARY_CURSOR_MAX_CHARS) {
    throw invalidReplayLibraryCursor();
  }
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      !parsed
      || parsed.v !== 3
      || (parsed.s !== "date_asc" && parsed.s !== "date_desc")
    ) {
      throw invalidReplayLibraryCursor();
    }
    const idText = typeof parsed.i === "string" ? parsed.i.toLowerCase() : "";
    if (
      !ObjectId.isValid(idText)
      || new ObjectId(idText).toHexString() !== idText
    ) {
      throw invalidReplayLibraryCursor();
    }
    const decodedDate = decodeCursorDate(parsed.t, parsed.d);
    const sort = /** @type {'date_asc'|'date_desc'} */ (parsed.s);
    return { ...decodedDate, id: new ObjectId(idText), sort };
  } catch (err) {
    const known = /** @type {{code?:unknown}|null} */ (
      err && typeof err === "object" ? err : null
    );
    if (known && known.code === "bad_request") {
      throw err;
    }
    throw invalidReplayLibraryCursor();
  }
}

/** @param {unknown} date @param {unknown} id @param {'date_asc'|'date_desc'} [sort] @returns {string} */
function encodeReplayLibraryCursor(date, id, sort = "date_desc") {
  const encodedDate = encodeCursorDate(date);
  const objectId = id instanceof ObjectId ? id : new ObjectId(String(id));
  return Buffer.from(
    JSON.stringify({
      v: 3,
      s: sort === "date_asc" ? "date_asc" : "date_desc",
      t: encodedDate.dateType,
      d: encodedDate.value,
      i: objectId.toHexString(),
    }),
    "utf8",
  ).toString("base64url");
}

/** @param {{dateType:'date'|'string'|'number'|'null',date:Date|string|number|null,id:import('mongodb').ObjectId,sort:'date_asc'|'date_desc'}} cursor */
function replayCursorContinuationBranches(cursor) {
  if (cursor.sort === "date_asc") return replayCursorHigherBranches(cursor);
  if (cursor.dateType === "null") {
    return [{ date: null, _id: { $lt: cursor.id } }];
  }
  return [
    { date: { $lt: cursor.date } },
    { date: cursor.date, _id: { $lt: cursor.id } },
    ...lowerDateTypeBranches(cursor.dateType),
    { date: null },
  ];
}

/** @param {{dateType:'date'|'string'|'number'|'null',date:Date|string|number|null,id:import('mongodb').ObjectId}} cursor */
function replayCursorHigherBranches(cursor) {
  if (cursor.dateType === "null") {
    return [
      { date: null, _id: { $gt: cursor.id } },
      ...higherDateTypeBranches("null"),
    ];
  }
  return [
    { date: { $gt: cursor.date } },
    { date: cursor.date, _id: { $gt: cursor.id } },
    ...higherDateTypeBranches(cursor.dateType),
  ];
}

/** @param {'date'|'string'|'number'} dateType */
function lowerDateTypeBranches(dateType) {
  const numbers = { date: { $type: ["double", "int", "long", "decimal"] } };
  if (dateType === "date") return [{ date: { $type: "string" } }, numbers];
  if (dateType === "string") return [numbers];
  return [];
}

/** @param {'date'|'string'|'number'|'null'} dateType */
function higherDateTypeBranches(dateType) {
  const numbers = { date: { $type: ["double", "int", "long", "decimal"] } };
  if (dateType === "null") {
    return [numbers, { date: { $type: "string" } }, { date: { $type: "date" } }];
  }
  if (dateType === "number") {
    return [{ date: { $type: "string" } }, { date: { $type: "date" } }];
  }
  if (dateType === "string") return [{ date: { $type: "date" } }];
  return [];
}

/**
 * @param {unknown} rawType
 * @param {unknown} rawValue
 * @returns {{dateType:'date',date:Date}|{dateType:'string',date:string}|{dateType:'number',date:number}|{dateType:'null',date:null}}
 */
function decodeCursorDate(rawType, rawValue) {
  if (rawType === "date" && typeof rawValue === "string") {
    const value = validDate(rawValue);
    if (value) return { dateType: "date", date: value };
  } else if (rawType === "string" && typeof rawValue === "string") {
    return { dateType: "string", date: rawValue };
  } else if (rawType === "number" && Number.isFinite(rawValue)) {
    return { dateType: "number", date: Number(rawValue) };
  } else if (rawType === "null" && rawValue === null) {
    return { dateType: "null", date: null };
  }
  throw invalidReplayLibraryCursor();
}

/** @param {unknown} raw */
function encodeCursorDate(raw) {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return { dateType: "date", value: raw.toISOString() };
  }
  if (typeof raw === "string") return { dateType: "string", value: raw };
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { dateType: "number", value: raw };
  }
  if (raw === null || raw === undefined) {
    return { dateType: "null", value: null };
  }
  throw new Error("replay_library_cursor_date_invalid");
}

/** @returns {Error & {status:number,code:string}} */
function invalidReplayLibraryCursor() {
  const error = /** @type {Error & {status:number,code:string}} */ (
    new Error("invalid replay library cursor")
  );
  error.status = 400;
  error.code = "bad_request";
  return error;
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
