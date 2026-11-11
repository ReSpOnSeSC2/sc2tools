"use strict";

const { ObjectId } = require("mongodb");
const { replayCursorContinuationBranches } = require("./replayLibraryCursor");
const { buildOrderSigningKey, chargeBuildOrderQuota, prepareBuildOrderRequest, unavailable } = require("./buildOrderExportPolicy");
const { csvCell } = require("./replayCsv");
const { REPLAY_SEARCH_COMMENT } = require("../middleware/searchQueryPrivacy");

const PAGE_GAMES = 2000;
const DETAIL_CONCURRENCY = 4;
const MAX_LOG_LINES = 5000;
const MAX_LOG_LINE_CHARS = 256;
const MAX_ROW_BYTES = 4096;
/** @type {Array<['me'|'opponent','buildLog'|'oppBuildLog']>} */
const SIDES = [["me", "buildLog"], ["opponent", "oppBuildLog"]];

/** @typedef {ReturnType<typeof prepareBuildOrderRequest> & {includeExactSupply:boolean}} ExportRequest */
/** @typedef {{_id:import('mongodb').ObjectId,date:Date|string|number|null,gameId:string}} Metadata */
/** @typedef {{buildLog:string[],oppBuildLog:string[],buildLogSupply?:unknown}} BuildOrderDetail */

class BuildOrderExportService {
  /** @type {import('crypto').KeyObject} */ #signingKey;
  /** @param {{games:import('mongodb').Collection,users:import('mongodb').Collection}} db
   * @param {{gameDetails:Pick<import('./gameDetails').GameDetailsService,'findMany'>,pepper:Buffer}} opts */
  constructor(db, opts) { this.db = db; this.gameDetails = opts.gameDetails; this.#signingKey = buildOrderSigningKey(opts.pepper); }

  /** Pure validation/signature verification, before reserving work or charging quota.
   * @param {string} owner @param {Record<string,unknown>} query @param {'csv'|'ndjson'} format @param {boolean} [acceptsExactSupply] */
  request(owner, query, format, acceptsExactSupply = false) {
    return { ...prepareBuildOrderRequest(owner, query, format, this.#signingKey),
      includeExactSupply: format === "csv" || acceptsExactSupply };
  }

  /** @param {ExportRequest} request @param {AbortSignal} signal */
  async prepare(request, signal) {
    await chargeBuildOrderQuota(this.db.users, request.owner, signal);
    signal.throwIfAborted();
    const rows = await readMetadata(this.db.games, request, signal);
    signal.throwIfAborted();
    const hasMore = rows.length > PAGE_GAMES;
    const page = rows.slice(0, PAGE_GAMES);
    const continuation = hasMore ? request.next(page[page.length - 1]) : null;
    return { hasMore, continuation, games: page.length, stream: this.stream(request, page, continuation, signal) };
  }

  /** @param {ExportRequest} request @param {Metadata[]} page @param {string|null} continuation @param {AbortSignal} signal */
  async *stream(request, page, continuation, signal) {
    let events = 0;
    signal.throwIfAborted();
    if (request.format === "ndjson") yield jsonLine({ type: "metadata", format: "sc2tools-build-order-export", version: 1,
      fields: ["gameId", "side", "time", "supply", "name"], games: page.length });
    else yield "\uFEFFgameId,side,time,supply,name\r\n";
    for (let offset = 0; offset < page.length; offset += DETAIL_CONCURRENCY) {
      signal.throwIfAborted();
      const batch = page.slice(offset, offset + DETAIL_CONCURRENCY);
      // Each call owns exactly one backend worker. A failure aborts siblings
      // immediately, and no release/next batch can race their actual cleanup.
      const details = await readBatch(this.gameDetails, request.owner, batch, request.includeExactSupply, signal);
      for (let index = 0; index < batch.length; index++) {
        const game = batch[index], detail = details[index];
        const alignedSupply = request.includeExactSupply && Array.isArray(detail.buildLogSupply) && detail.buildLogSupply.length === detail.buildLog.length
          ? detail.buildLogSupply : [];
        for (const [side, key] of SIDES) {
          for (const [step, line] of detail[key].entries()) {
            signal.throwIfAborted();
            const supply = side === "me" ? alignedSupply[step] : null;
            const row = { gameId: game.gameId, side, ...parseLogLine(line, supply) };
            yield request.format === "ndjson" ? jsonLine(row)
              : boundedRow(`${[row.gameId, row.side, row.time, row.supply, row.name].map(csvCell).join(",")}\r\n`);
            events++;
          }
        }
      }
    }
    signal.throwIfAborted();
    if (request.format === "ndjson") yield jsonLine({ type: "complete", games: page.length, events, continuation });
  }
}

/** Metadata only, one document per batch, sentinel never gets a detail read.
 * @param {import('mongodb').Collection} games @param {ExportRequest} request @param {AbortSignal} signal */
async function readMetadata(games, request, signal) {
  const match = request.position ? { $and: [request.match, { $or: replayCursorContinuationBranches(request.position) }] } : request.match;
  const cursor = games.find(match, { projection: { _id: 1, date: 1, gameId: 1 }, signal, maxTimeMS: 30_000, comment: REPLAY_SEARCH_COMMENT })
    .sort({ date: -1, _id: -1 }).limit(PAGE_GAMES + 1).batchSize(1);
  /** @type {Metadata[]} */ const rows = [];
  try {
    for await (const row of cursor) {
      signal.throwIfAborted();
      if (rows.length >= PAGE_GAMES + 1) throw unavailable();
      rows.push(metadata(row));
    }
  } finally { await cursor.close(); }
  signal.throwIfAborted();
  return rows;
}

/** Validate/copy before retaining a historical projected row.
 * @param {Record<string,any>} row @returns {Metadata} */
function metadata(row) {
  if (!row || !(row._id instanceof ObjectId) || typeof row.gameId !== "string" || !row.gameId || row.gameId.length > 200
    || /[\u0000-\u001f\u007f]/u.test(row.gameId) || Buffer.from(row.gameId).toString("utf8") !== row.gameId) throw unavailable();
  const date = row.date ?? null;
  if (!(date === null || (date instanceof Date && Number.isFinite(date.getTime())) || (typeof date === "string" && date.length <= 64)
    || (typeof date === "number" && Number.isFinite(date)))) throw unavailable();
  if (typeof date === "string" && (/[\u0000-\u001f\u007f]/u.test(date) || Buffer.from(date).toString("utf8") !== date)) throw unavailable();
  return { _id: new ObjectId(row._id.toHexString()), gameId: row.gameId, date: date instanceof Date ? new Date(date.getTime()) : date };
}

/** @param {Pick<import('./gameDetails').GameDetailsService,'findMany'>} service @param {string} owner @param {Metadata[]} batch @param {boolean} includeExactSupply @param {AbortSignal} signal */
async function readBatch(service, owner, batch, includeExactSupply, signal) {
  const fields = includeExactSupply ? ["buildLog", "oppBuildLog", "buildLogSupply"] : ["buildLog", "oppBuildLog"];
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const tasks = batch.map(async game => {
    try {
      controller.signal.throwIfAborted();
      const found = await service.findMany(owner, [game.gameId], { fields, strict: true, concurrency: 1, signal: controller.signal });
      controller.signal.throwIfAborted();
      const detail = found.get(game.gameId);
      validateLogs(detail);
      return /** @type {BuildOrderDetail} */ (detail);
    } catch { controller.abort(); throw unavailable(); }
  });
  try {
    const outcomes = await Promise.allSettled(tasks);
    signal.throwIfAborted();
    if (outcomes.some(result => result.status === "rejected")) throw unavailable();
    return outcomes.map(result => /** @type {PromiseFulfilledResult<BuildOrderDetail>} */ (result).value);
  } finally { controller.abort(); signal.removeEventListener("abort", abort); }
}

/** @param {Record<string,any>|undefined} detail */
function validateLogs(detail) {
  for (const key of ["buildLog", "oppBuildLog"]) {
    const lines = detail?.[key];
    if (!Array.isArray(lines) || lines.length > MAX_LOG_LINES) throw unavailable();
    for (const line of lines) parseLogLine(line);
  }
}

/** Preserve names, order and duplicates. Supply is optional and aligned by the caller.
 * @param {unknown} line @param {unknown} [supply] */
function parseLogLine(line, supply) {
  if (typeof line !== "string" || line.length > MAX_LOG_LINE_CHARS || /[\u0000-\u001f\u007f]/u.test(line)
    || Buffer.from(line).toString("utf8") !== line) throw unavailable();
  const match = /^\[(\d+):([0-5]\d)\] (.+)$/u.exec(line);
  if (!match || !match[3].trim()) throw unavailable();
  const time = Number(match[1]) * 60 + Number(match[2]);
  if (!Number.isSafeInteger(time) || time < 0) throw unavailable();
  const exact = typeof supply === "number" && Number.isFinite(supply) && supply >= 0 && supply <= 2000;
  return { time, supply: exact ? supply : null, name: match[3] };
}

/** @param {Record<string,any>} row */
function jsonLine(row) { return boundedRow(`${JSON.stringify(row)}\n`); }
/** @param {string} row */
function boundedRow(row) { if (Buffer.byteLength(row, "utf8") > MAX_ROW_BYTES) throw unavailable(); return row; }

module.exports = { BuildOrderExportService };
