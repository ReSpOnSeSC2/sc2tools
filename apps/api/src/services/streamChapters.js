"use strict";

const { gamesMatchStage } = require("../util/parseQuery");
const facts = require("./reportFacts");
const { gameStartMs } = require("./gameVods");

/**
 * One chapter per game for the stream's video: "0:42:10 Game 4 · PvZ win vs 5.1k".
 *
 * Text carries the game number, matchup, result and the opponent's rating
 * rounded to 100, never a name (ADR 0075). YouTube turns a description into
 * chapters only when the list starts at 0:00, holds at least three entries and
 * keeps them ten seconds apart, so a list that breaks a rule is not written.
 */

const GAME_LIMIT = 300;
const MIN_CHAPTERS = 3;
const MIN_GAP_MS = 10_000;
const DESCRIPTION_BYTES = 5000;
const BLOCK_START = "-- SC2Tools game chapters --";
const BLOCK_END = "-- end of SC2Tools game chapters --";
const BLOCK = new RegExp(`${BLOCK_START}[\\s\\S]*?${BLOCK_END}`);

const MESSAGES = Object.freeze({
  no_games: "No games since the stream start you marked, so there is nothing to copy yet.",
  not_enabled: "Game chapters for YouTube are not switched on for this server, so nothing was written.",
  too_few: "YouTube needs at least three chapters, so nothing was written. Play more games before ending the stream.",
  too_close: "Two games started less than ten seconds apart, so nothing was written.",
  no_start: "Press Start new session when you go live so chapters know where the stream began.",
  too_long: "The description has no room for the chapters, so nothing was written.",
  no_broadcast: "No YouTube broadcast made by SC2Tools was on air during this stream.",
  failed: "YouTube did not take the chapters. Copy them from the Stream Dock instead.",
});

/** @param {number} ms */
function formatOffset(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** "5.1k" for a rating rounded to the nearest 100. @param {unknown} mmr */
function roundedRating(mmr) {
  if (typeof mmr !== "number" || !Number.isFinite(mmr) || mmr <= 0) return null;
  const hundreds = Math.round(mmr / 100) * 100;
  return hundreds >= 1000 ? `${(hundreds / 1000).toFixed(1)}k` : String(hundreds);
}

/**
 * The fields of a stored game that a chapter reads.
 * @typedef {{
 *   result?: string,
 *   myRace?: string,
 *   opponent?: {race?: string, mmr?: number},
 *   startedAt?: Date|string,
 *   date?: Date|string,
 *   durationSec?: number,
 * }} ChapterGame
 */

/** @param {ChapterGame} row @param {number} number */
function chapterText(row, number) {
  const result = facts.outcome(row);
  const rating = roundedRating(row.opponent?.mmr);
  return `Game ${number} · ${facts.matchupOf(row)}${result ? ` ${result}` : ""}${rating ? ` vs ${rating}` : ""}`;
}

/**
 * @param {ChapterGame[]} rows games with startedAt or date (the replay end) and durationSec
 * @param {number} originMs where the 0:00 of the video is
 * @param {{endMs?: number, youtube?: boolean}} [window] endMs: where the video ends, so later games get no chapter;
 *   youtube: apply the three-chapter and ten-second rules of YouTube (a text copy for Twitch or Kick has none)
 * @returns {{lines: string[]}|{reason: "too_few"|"too_close"|"no_games"}}
 */
function chapterLines(rows, originMs, { endMs = Infinity, youtube = true } = {}) {
  const starts = rows
    .map((row) => ({ row, at: (gameStartMs(row) ?? NaN) - originMs }))
    .filter((game) => Number.isFinite(game.at))
    .sort((a, b) => a.at - b.at)
    .map((game, index) => ({ at: game.at, text: chapterText(game.row, index + 1) }))
    .filter((game) => game.at >= 0 && game.at + originMs < endMs);
  if (!starts.length) return { reason: youtube ? "too_few" : "no_games" };
  const chapters = starts[0].at >= MIN_GAP_MS ? [{ at: 0, text: "Stream start" }, ...starts] : [{ ...starts[0], at: 0 }, ...starts.slice(1)];
  if (youtube && chapters.length < MIN_CHAPTERS) return { reason: "too_few" };
  if (youtube && chapters.some((chapter, index) => index > 0 && chapter.at - chapters[index - 1].at < MIN_GAP_MS)) return { reason: "too_close" };
  return { lines: chapters.map((chapter) => `${formatOffset(chapter.at)} ${chapter.text}`) };
}

/** Replace our block, or add it after the streamer's own text; their words are never touched.
 * @param {string} description @param {string[]} lines */
function withChapterBlock(description, lines) {
  const block = [BLOCK_START, ...lines, BLOCK_END].join("\n");
  if (BLOCK.test(description)) return description.replace(BLOCK, () => block);
  const own = description.replace(/\s+$/, "");
  return own ? `${own}\n\n${block}` : block;
}

class StreamChaptersService {
  /** @param {{games: import('mongodb').Collection, youtube?: {archiveDescriptions: Function}|null, enabled?: boolean,
   *   receipts?: {record: (userId: string, receipts: Array<{id: string, state: string, reason?: string}>) => Promise<void>}|null}} deps */
  constructor(deps) {
    this.games = deps.games;
    this.youtube = deps.youtube || null;
    this.enabled = deps.enabled === true;
    this.receipts = deps.receipts || null;
  }

  /**
   * The stream's games, oldest first, projected to the fields a chapter reads.
   * @param {string} userId @param {number} fromMs @param {number} toMs
   * @returns {Promise<ChapterGame[]>}
   */
  async rows(userId, fromMs, toMs) {
    const games = await this.games.find(gamesMatchStage(userId, { since: new Date(fromMs), until: new Date(toMs) }), { projection: {
      _id: 0, date: 1, result: 1, myRace: 1, "opponent.race": 1, "opponent.mmr": 1, durationSec: 1, startedAt: 1,
    } }).sort({ date: 1 }).limit(GAME_LIMIT).toArray();
    return /** @type {ChapterGame[]} */ (games);
  }

  /** Lines for the Dock's copy button, counted from the stream start the Dock marked.
   * @param {string} userId @param {number|null} startMs @param {number} nowMs */
  async copyable(userId, startMs, nowMs) {
    if (startMs === null) return { lines: [], message: MESSAGES.no_start };
    const found = chapterLines(await this.rows(userId, startMs, nowMs), startMs, { youtube: false });
    return "lines" in found ? { lines: found.lines, message: "" } : { lines: [], message: MESSAGES[found.reason] };
  }

  /**
   * Write the chapters into each YouTube archive that was on air. Never throws:
   * the Dock shows the answer next to the End stream result.
   * @param {string} userId @param {number|null} startMs @param {number} endMs
   * @returns {Promise<{state: "written"|"skipped"|"failed", message: string}>}
   */
  async writeToYoutube(userId, startMs, endMs) {
    if (!this.enabled) return { state: "skipped", message: MESSAGES.not_enabled };
    if (startMs === null) return { state: "skipped", message: MESSAGES.no_start };
    try {
      if (!this.youtube) return { state: "skipped", message: MESSAGES.no_broadcast };
      const rows = await this.rows(userId, startMs, endMs);
      /** @type {Array<keyof typeof MESSAGES>} */
      const refusals = [];
      const compose = (/** @type {number} */ originMs, /** @type {string} */ description, /** @type {number} */ videoEndMs) => {
        const found = chapterLines(rows, originMs, { endMs: videoEndMs });
        if (!("lines" in found)) { refusals.push(found.reason); return { skip: found.reason }; }
        const next = withChapterBlock(description, found.lines);
        if (Buffer.byteLength(next, "utf8") > DESCRIPTION_BYTES) { refusals.push("too_long"); return { skip: "too_long" }; }
        return { description: next };
      };
      const receipts = await this.youtube.archiveDescriptions(userId, { fromMs: startMs, toMs: endMs, compose });
      await this.receipts?.record(userId, receipts).catch(() => {});
      return summarize(receipts, refusals[0] || "too_few");
    } catch {
      return { state: "failed", message: MESSAGES.failed };
    }
  }
}

/** @param {Array<{state: string}>} receipts @param {keyof typeof MESSAGES} refusal */
function summarize(receipts, refusal) {
  const written = receipts.filter((receipt) => receipt.state === "written").length;
  if (written) {
    const note = receipts.length > written ? " Another video could not be updated." : "";
    return { state: /** @type {const} */ ("written"), message: `Added the game chapters to ${written === 1 ? "the YouTube archive" : `${written} YouTube archives`}.${note}` };
  }
  if (!receipts.length) return { state: /** @type {const} */ ("skipped"), message: MESSAGES.no_broadcast };
  if (receipts.some((receipt) => receipt.state === "failed")) return { state: /** @type {const} */ ("failed"), message: MESSAGES.failed };
  return { state: /** @type {const} */ ("skipped"), message: MESSAGES[refusal] };
}

module.exports = { StreamChaptersService, chapterLines, withChapterBlock, formatOffset, roundedRating, BLOCK_START, BLOCK_END, MESSAGES };
