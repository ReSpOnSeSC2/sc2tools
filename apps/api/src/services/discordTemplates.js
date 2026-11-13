"use strict";

const { recordedRating } = require("./gameMomentRules");
const { LEAGUES } = require("../util/leagueBands");

const SITE = "https://sc2tools.com";
const COLORS = { win: 0x2fbf71, loss: 0xe5484d, neutral: 0x7c8a9a, brand: 0x3aa7ff };
const DEFAULT_OPTIONS = Object.freeze({ opponentNames: false, mmr: false, replayLink: false });
/** @type {Readonly<Record<string, string>>} */
const RACES = Object.freeze({ p: "Protoss", protoss: "Protoss", t: "Terran", terran: "Terran",
  z: "Zerg", zerg: "Zerg", r: "Random", rand: "Random", random: "Random" });
/** @type {Readonly<Record<string, string>>} */
const LADDER_HEADLINES = Object.freeze({
  "moment.new_season_peak": "New recorded season peak",
  "moment.loss_streak_broken": "Loss streak broken",
  "moment.revenge_win": "Revenge win",
  "moment.giant_killer": "Giant-killer win",
  "moment.marathon_win": "Marathon win",
});

/** @param {unknown} value */
function race(value) {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  return Object.hasOwn(RACES, key) ? RACES[key] : null;
}

/** @param {unknown} value */
function safeRating(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 500 && value <= 9999 ? value : null;
}

/** @param {number} value */
const num = (value) => value.toLocaleString("en-US");
/** @param {number} delta */
const signed = (delta) => `${delta >= 0 ? "+" : "−"}${num(Math.abs(delta))}`;
/** @param {{wins: number, losses: number}} r */
const wl = (r) => `${r.wins}–${r.losses}`;

/** @param {Record<string, unknown>[]} embeds */
function message(embeds) {
  return { username: "SC2 Tools", allowed_mentions: { parse: [] }, embeds };
}

/** @param {unknown} value */
function mmrConsent(value) {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value) ? value : null;
}

/** @param {{options?: {replayLink?: unknown}, mmrConsent?: unknown}} hook */
function hookOptions(hook) {
  return { opponentNames: false, mmr: mmrConsent(hook.mmrConsent) !== null, replayLink: hook.options?.replayLink === true };
}

/** @typedef {ReturnType<typeof hookOptions>} Options */
/** @param {unknown} result */
function outcome(result) {
  if (result === "Victory") return { label: "Victory", color: COLORS.win };
  if (result === "Defeat") return { label: "Defeat", color: COLORS.loss };
  return { label: "Ranked result", color: COLORS.neutral };
}

/** @param {unknown} name @param {unknown} row */
function matchupRecord(name, row) {
  if (typeof name !== "string" || name.length !== 3 || !/^[PTZR?]v[PTZR?]$/.test(name)) return [];
  const stats = /** @type {{wins:number, losses:number}} */ (row);
  return [`${name} ${wl(stats)}`];
}

/** @param {any} game @param {Options} options */
function resultMessage(game, options) {
  const { label, color } = outcome(game.result);
  const own = race(game.myRace);
  const opponent = race(game.opponent?.race);
  const rating = safeRating(recordedRating(game));
  const fields = [];
  if (opponent) fields.push({ name: "Opponent", value: opponent, inline: true });
  if (options.mmr && rating !== null) fields.push({ name: "Recorded starting MMR", value: num(rating), inline: true });
  const matchup = own && opponent ? ` · ${own[0]}v${opponent[0]}` : "";
  return message([{ title: label + matchup, color, fields, footer: { text: "SC2 Tools" } }]);
}

/** @param {{start:number,end:number,games:number}|null|undefined} values @param {Options} options */
function reportRating(values, options) {
  if (!options.mmr || !values || values.games < 2) return [];
  const start = safeRating(values.start), end = safeRating(values.end);
  return start === null || end === null ? [] : [{ name: "MMR", value: `${num(start)} → ${num(end)} (${signed(end - start)})`, inline: true }];
}

/** @param {{games: number, wins: number, losses: number, hours: number, matchups: {name:string,wins:number,losses:number}[],
 * mmr: {start:number,end:number,games:number}|null}} session @param {Options} options */
function sessionMessage(session, options) {
  const fields = [{ name: "Record", value: `${wl(session)} in ${session.games} game${session.games === 1 ? "" : "s"}`, inline: true },
    { name: "Time played", value: `${session.hours} h`, inline: true }, ...reportRating(session.mmr, options)];
  const matchups = session.matchups.slice(0, 6).flatMap(row => matchupRecord(row.name, row)).join(" · ");
  if (matchups) fields.push({ name: "Matchups", value: matchups, inline: false });
  return message([{ title: "Session summary", color: COLORS.brand, fields, footer: { text: "SC2 Tools" } }]);
}

/** @param {any} report @param {Options} options */
function weeklyMessage(report, options) {
  const t = report.totals;
  const fields = [{ name: "Record", value: `${wl(t)} in ${t.games} games`, inline: true },
    { name: "Time played", value: `${t.hours} h · ${t.sessions} session${t.sessions === 1 ? "" : "s"}`, inline: true },
    ...reportRating(report.mmr?.[0], options)];
  const matchups = (report.matchups || []).slice(0, 6).flatMap((/** @type {any} */ row) => matchupRecord(row.matchup, row)).join(" · ");
  if (matchups) fields.push({ name: "Matchups", value: matchups, inline: false });
  const week = typeof report.week === "string" && /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(report.week) ? Number(report.week.slice(6)) : null;
  return message([{ title: week === null ? "Weekly recap" : `Week ${week} recap`, color: COLORS.brand, fields, footer: { text: "SC2 Tools" } }]);
}

/** @param {{mmr: number, previousPeak: number, race: string}} milestone @param {Options} options */
function milestoneMessage(milestone, options) {
  const current = safeRating(milestone.mmr), previous = safeRating(milestone.previousPeak);
  const value = options.mmr && current !== null && previous !== null
    ? `${num(current)} MMR (previous best ${num(previous)})` : "A new personal best rating.";
  const own = race(milestone.race);
  return message([{ title: own ? `New ${own} MMR peak` : "New MMR peak", color: COLORS.win, description: value, footer: { text: "SC2 Tools" } }]);
}

/** @param {{previous:string,current:string,race:string,mmr?:number}} milestone @param {Options} options */
function promotionMessage(milestone, options) {
  const rating = safeRating(milestone.mmr);
  const fields = options.mmr && rating !== null ? [{ name: "MMR", value: num(rating), inline: true }] : [];
  const previous = LEAGUES.find(band => band.label === milestone.previous)?.label;
  const current = LEAGUES.find(band => band.label === milestone.current)?.label;
  const own = race(milestone.race);
  const description = [previous && current ? `${previous} → ${current}` : null, own].filter(Boolean).join(" · ");
  return message([{ title: current ? `Promotion · ${current}` : "League promotion", color: COLORS.win,
    ...(description ? { description } : {}), fields, footer: { text: "SC2 Tools" } }]);
}

/** @param {string} kind @param {unknown} title */
function ladderHeadline(kind, title) {
  if (kind === "moment.win_streak") return title === "5 wins in a row" || title === "10 wins in a row" ? title : null;
  if (kind === "moment.crossed_mmr_mark") return ratingHeadline(title);
  return Object.hasOwn(LADDER_HEADLINES, kind) && title === LADDER_HEADLINES[kind] ? LADDER_HEADLINES[kind] : null;
}

/** @param {unknown} title */
function ratingHeadline(title) {
  const mark = typeof title === "string" ? /^Recorded ([1-9][0-9]{2,3}) MMR$/.exec(title) : null;
  const rating = safeRating(Number(mark?.[1]));
  return mark && mark[0] === title && rating !== null && (rating % 100 === 0 || rating % 250 === 0) ? title : null;
}

/** @param {string} kind @param {string} headline @param {Options} options */
function ladderMessage(kind, headline, options) {
  const title = kind === "moment.crossed_mmr_mark" && !options.mmr ? "Recorded rating milestone" : headline;
  return message([{ title, color: COLORS.win, footer: { text: "SC2 Tools · StarCraft II 1v1 ladder" } }]);
}

function testMessage() {
  return message([{ title: "SC2 Tools is connected", color: COLORS.brand,
    description: "This channel will receive the posts you turned on in SC2 Tools. Opponent names and ratings stay private.", footer: { text: "SC2 Tools" } }]);
}

/** @param {{token: string, result: unknown}} report */
function battleReportMessage(report) {
  const { color } = outcome(report.result);
  return message([{ title: "Shared StarCraft II battle report", description: "Open the report to see the anonymized analysis.",
    color, url: `${SITE}/g/${encodeURIComponent(report.token)}#battle-report`, footer: { text: "SC2 Tools" } }]);
}

module.exports = { resultMessage, sessionMessage, weeklyMessage, milestoneMessage, promotionMessage,
  ladderHeadline, ladderMessage, testMessage, battleReportMessage, hookOptions, mmrConsent, DEFAULT_OPTIONS };
