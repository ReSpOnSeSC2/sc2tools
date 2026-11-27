"use strict";

const { STATS_GAME_MATCH } = require("../util/gameVisibility");

const { ladderRegionFromToonHandle } = require("../util/regionFromToonHandle");
const { resultBucket } = require("../util/parseQuery");
const { streamTitleMatch, streamTitleCompletedMatch } = require("./streamTitleMatch");
const RACES = new Map([["Protoss", "P"], ["Terran", "T"], ["Zerg", "Z"]]);
const LEAGUES = new Set(["Bronze", "Silver", "Gold", "Platinum", "Diamond", "Master", "Grandmaster"]);
const HISTORY_LIMIT = 512;
const MAP_EDITION = /\s+(le|ce)$/;
/** @param {string} name */
const mapKey = (name) => name.trim().toLowerCase().replace(MAP_EDITION, "");

/** What the channel tags need beyond the match: a running Series, and whether
 * the map is outside the ladder pool. An unknown pool never marks a game custom.
 * @param {string} userId @param {Record<string, any>|null} currentMatch
 * @param {{hasActiveSeries?:(userId:string)=>Promise<boolean>,ladderMaps?:()=>Promise<string[]>}} [extras] */
async function tagContext(userId, currentMatch, extras) {
  const series = await extras?.hasActiveSeries?.(userId).catch(() => false) === true;
  const maps = currentMatch?.map ? await extras?.ladderMaps?.().catch(() => null) : null;
  const custom = maps?.length ? !maps.some((name) => mapKey(name) === mapKey(currentMatch?.map)) : undefined;
  return { series, ...(custom === undefined ? {} : { custom }) };
}

/** Private snapshot using the shared session resolver and bounded indexed reads.
 * The optional completed game is scoped to this owner and exact replay ID.
 * @param {Pick<import('../db/connect').DbContext, 'games'|'opponents'>} db
 * @param {Pick<import('./games').GamesService, 'todaySession'>} games
 * @param {string} userId
 * @param {() => Record<string, any>|null|undefined} [liveSnapshot]
 * @param {string} [gameId]
 * @param {import('./scoutingIdentities').ScoutingIdentitiesService} [scoutingIdentities]
 * @param {Parameters<typeof tagContext>[2]} [tagExtras]
 */
async function streamTitleSession(db, games, userId, liveSnapshot, gameId, scoutingIdentities, tagExtras) {
  const session = await games.todaySession(userId, undefined, { reuseRecent: true });
  const now = new Date();
  const since = new Date(now.getTime() - 90 * 86400000);
  const rows = await db.games.find({ userId, date: { $gte: since, $lte: now },
    ...STATS_GAME_MATCH, isResumedFromReplay: { $ne: true }, isLadderGame: true }, { projection: {
    _id: 0, date: 1, myMmr: 1, myRace: 1, myToonHandle: 1, result: 1, "opponent.race": 1,
  }, maxTimeMS: 2000 }).sort({ date: -1, _id: -1 }).limit(HISTORY_LIMIT).toArray();
  /** @type {Record<string, {wins:number, losses:number}>} */
  const winRates = {};
  const latest = rows.find((row) => RACES.has(row.myRace) && typeof row.myToonHandle === "string"
    && (!session.region || ladderRegionFromToonHandle(row.myToonHandle) === session.region));
  let peak;
  for (const row of rows) {
    // Peak is one character/race in the session region; mixing ladders would
    // give the template an impressive but irrelevant number.
    if (latest && row.myToonHandle === latest.myToonHandle && row.myRace === latest.myRace
      && Number.isInteger(row.myMmr) && row.myMmr >= 0 && row.myMmr <= 9999) {
      peak = Math.max(peak ?? 0, row.myMmr);
    }
    const mine = RACES.get(row.myRace), theirs = RACES.get(row.opponent?.race);
    const result = resultBucket(row.result);
    if (!mine || !theirs || !result) continue;
    const key = `${mine}v${theirs}`;
    const counts = winRates[key] || (winRates[key] = { wins: 0, losses: 0 });
    counts[result === "win" ? "wins" : "losses"] += 1;
  }
  const completedMatch = gameId ? await streamTitleCompletedMatch(db, userId, gameId, scoutingIdentities).catch(() => null) : null;
  // Read the live cache after the awaited statistics calls, so a menu/new-game
  // transition during that work cannot leave the previous opponent in a title.
  const currentMatch = streamTitleMatch(liveSnapshot?.());
  return { schema: 1, generatedAt: now.toISOString(),
    session: { wins: session.wins, losses: session.losses },
    ...(Number.isInteger(session.mmrCurrent) ? { mmr: session.mmrCurrent } : {}),
    ...(session.league && LEAGUES.has(session.league) ? { league: session.league } : {}),
    ...(session.streak ? { streak: session.streak } : {}),
    ...(peak !== undefined ? { peak } : {}), winRates,
    ...(currentMatch ? { currentMatch, tagContext: await tagContext(userId, currentMatch, tagExtras) } : {}),
    ...(completedMatch ? { completedMatch } : {}),
    history: { since: since.toISOString(), limit: HISTORY_LIMIT, sampled: rows.length,
      capped: rows.length === HISTORY_LIMIT, scope: "Recorded ladder games in the last 90 days; peak uses the current character and race." } };
}

module.exports = { streamTitleSession };
