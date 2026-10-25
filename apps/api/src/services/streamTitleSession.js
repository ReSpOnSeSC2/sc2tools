"use strict";

const { STATS_GAME_MATCH } = require("../util/gameVisibility");

const { ladderRegionFromToonHandle } = require("../util/regionFromToonHandle");
const { resultBucket } = require("../util/parseQuery");
const RACES = new Map([["Protoss", "P"], ["Terran", "T"], ["Zerg", "Z"]]);
const LEAGUES = new Set(["Bronze", "Silver", "Gold", "Platinum", "Diamond", "Master", "Grandmaster"]);
const HISTORY_LIMIT = 512;

/** Private snapshot: shared session resolver plus one bounded indexed read.
 * No provider writes, new aggregation pipeline, detail hydration or Pulse fanout.
 * @param {{games: import('mongodb').Collection}} db
 * @param {Pick<import('./games').GamesService, 'todaySession'>} games
 * @param {string} userId
 */
async function streamTitleSession(db, games, userId) {
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
  return { schema: 1, generatedAt: now.toISOString(),
    session: { wins: session.wins, losses: session.losses },
    ...(Number.isInteger(session.mmrCurrent) ? { mmr: session.mmrCurrent } : {}),
    ...(session.league && LEAGUES.has(session.league) ? { league: session.league } : {}),
    ...(session.streak ? { streak: session.streak } : {}),
    ...(peak !== undefined ? { peak } : {}), winRates,
    history: { since: since.toISOString(), limit: HISTORY_LIMIT, sampled: rows.length,
      capped: rows.length === HISTORY_LIMIT, scope: "Recorded ladder games in the last 90 days; peak uses the current character and race." } };
}

module.exports = { streamTitleSession };
