"use strict";
const { ladderRegionFromToonHandle } = require("../util/regionFromToonHandle");
const LEAGUES = ["bronze", "silver", "gold", "platinum", "diamond", "master", "grandmaster"];
/** @param {unknown} value */
const number = value => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
/** @param {unknown} value */
const outcome = value => ["win", "victory"].includes(String(value).toLowerCase()) ? "win" : ["loss", "defeat"].includes(String(value).toLowerCase()) ? "loss" : null;
/** @param {unknown} value */
const text = value => typeof value === "string" ? value.replace(/<[^>]*>/g, "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 180) : "";
/** @param {Record<string,any>} game */
const eligibleGame = game => game.playerCount === 2 && game.isLadderGame !== false && ![game.excluded, game._deleted, game._deletionPending, game.isResumedFromReplay].some(value => value === true);
/** @param {Record<string,any>} game */
const recordedRating = game => game.myMmrSource === "replay" ? number(game.myMmr) : null;
/** Exact ladder account/race cohort; unknown/PTR never borrows another ladder.
 * @param {Record<string,any>} game */
function ladderContext(game) {
  const toon = game.myToonHandle, race = String(game.myLadderRace || game.myRace || "")[0]?.toUpperCase();
  if (typeof toon !== "string" || !/^[1-9][0-9]?-S2-[1-9][0-9]?-[0-9]{1,20}$/i.test(toon) || !["P", "T", "Z", "R"].includes(race)) return null;
  const region = ladderRegionFromToonHandle(toon);
  return region ? { key: `${toon.toUpperCase()}:${race}`, region } : null;
}
/** @param {Record<string,any>} a @param {Record<string,any>} b */
function sameOpponent(a, b) {
  const first = a.opponent || {}, second = b.opponent || {};
  if (first.pulseCharacterId != null && second.pulseCharacterId != null) return /^[1-9][0-9]{0,31}$/.test(String(first.pulseCharacterId)) && String(first.pulseCharacterId) === String(second.pulseCharacterId);
  const toon = first.toonHandle || first.pulseId, other = second.toonHandle || second.pulseId;
  return typeof toon === "string" && /^\d+-S2-\d+-\d+$/.test(toon) && toon === other;
}
/** Ties don't break a decided streak; unknown outcomes prevent a claim.
 * @param {Record<string,any>[]} rows @param {string} kind */
function streak(rows, kind) {
  let count = 0;
  for (const row of rows) { if (String(row.result).toLowerCase() === "tie") continue; if (outcome(row.result) !== kind) break; count++; }
  return count;
}
/** @param {unknown} value */
function league(value) { const name = text(value).toLowerCase().replace(/\s/g, ""); return LEAGUES.includes(name) ? name : null; }
/** @typedef {{kind:string,headline:string,detail:string}} Moment */
/** Pure recorded-data rules. Caller supplies one bounded, descending history
 * and a cache-only season. No inferred post-game MMR or estimated leagues.
 * @param {{game:Record<string,any>,history:Record<string,any>[],historyTruncated?:boolean,season?:{battlenetId:number,start:string}|null,pulseRank?:{source?:string,league?:string}|null,approvedChannel?:boolean,mmrStep?:number}} input
 * @returns {Moment[]} */
function deriveGameMoments(input) {
  const { game } = input, won = outcome(game.result) === "win", context = ladderContext(game);
  if (!eligibleGame(game) || outcome(game.result) === null) return [];
  const history = input.history.filter(row => row.userId === game.userId && row.gameId !== game.gameId && eligibleGame(row));
  const past = context ? history.filter(row => ladderContext(row)?.key === context.key) : [];
  /** @type {Moment[]} */ const moments = [];
  const add = (/** @type {string} */ kind, /** @type {string} */ headline, /** @type {string} */ detail) => moments.push({ kind, headline: text(headline).slice(0, 80), detail: text(detail).slice(0, 180) });
  addRatingMoments(input, past, context, add);
  addLeagueMoment(input, past, context, add);
  if (!won) return moments;
  const wins = 1 + streak(past, "win"), losses = streak(past, "loss");
  if (context && [5, 10].includes(wins)) add("winStreak", `${wins} wins in a row`, "Recorded on this ladder account and race.");
  if (context && losses >= 4) add("lossStreakBroken", "Loss streak broken", `A win after ${losses} recorded losses on this ladder account and race.`);
  const previousMeeting = past.find(row => sameOpponent(game, row));
  if (previousMeeting && outcome(previousMeeting.result) === "loss") add("revengeWin", "Revenge win", "Won the next recorded meeting against this exact opponent.");
  const own = recordedRating(game), opponent = number(game.opponent?.mmr);
  if (own !== null && opponent !== null && game.opponent?.mmrSource === "replay" && opponent - own >= 200) add("giantKiller", "Giant-killer win", `Opponent started ${opponent - own} MMR higher (${opponent} vs ${own}, replay ratings).`);
  const duration = number(game.durationSec);
  if (duration !== null && duration >= 25 * 60) add("marathonWin", "Marathon win", `Victory after ${Math.floor(duration / 60)} minutes.`);
  if (input.approvedChannel === true) add("streamerOpponentWin", "Streamer opponent defeated", "Won against an opponent with an approved exact channel identity.");
  return moments;
}
/** @param {Parameters<typeof deriveGameMoments>[0]} input @param {Record<string,any>[]} past @param {ReturnType<typeof ladderContext>} context @param {(kind:string,headline:string,detail:string)=>unknown} add */
function addRatingMoments(input, past, context, add) {
  const current = recordedRating(input.game); if (!context || current === null) return;
  const previous = past.map(recordedRating).find(value => value !== null);
  const step = input.mmrStep === 250 ? 250 : 100;
  if (previous != null && current > previous && Math.floor(current / step) > Math.floor(previous / step)) add("crossedMmrMark", `Recorded ${Math.floor(current / step) * step} MMR`, `Replay game-start rating moved from ${previous} to ${current}; not this game's awarded rating.`);
  const start = input.season?.start ? Date.parse(input.season.start) : NaN;
  const oldest = input.history.length ? Math.min(...input.history.map(row => new Date(row.date).getTime())) : Infinity;
  const at = new Date(input.game.date).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(at) || at < start || (input.historyTruncated && !(Number.isFinite(oldest) && oldest <= start))) return;
  const ratings = past.filter(row => new Date(row.date).getTime() >= start).map(recordedRating).filter(value => value !== null);
  if (ratings.length > 0 && current > Math.max(...ratings)) add("newSeasonPeak", "New recorded season peak", `${current} game-start MMR in season ${input.season?.battlenetId} on ${context.region}, this ladder account/race.`);
}
/** @param {Parameters<typeof deriveGameMoments>[0]} input @param {Record<string,any>[]} past @param {ReturnType<typeof ladderContext>} context @param {(kind:string,headline:string,detail:string)=>unknown} add */
function addLeagueMoment(input, past, context, add) {
  const current = input.pulseRank?.source === "pulse" ? league(input.pulseRank.league) : null;
  if (!context || !current || !input.season) return;
  const previous = past.map(row => row._gameMoments?.rank).find(rank => rank?.source === "pulse" && rank?.context === context.key && rank?.season === input.season?.battlenetId && league(rank?.league));
  const before = league(previous?.league);
  if (before && before !== current) add("leagueChange", LEAGUES.indexOf(current) > LEAGUES.indexOf(before) ? "League promotion" : "League changed", `Confirmed league changed from ${text(previous.league)} to ${text(input.pulseRank?.league)} on this ladder account/race.`);
}
module.exports = { deriveGameMoments, ladderContext, sameOpponent, outcome, number, league, eligibleGame, recordedRating };
