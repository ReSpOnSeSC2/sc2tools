"use strict";

const { STATS_GAME_MATCH } = require("../util/gameVisibility");
const { BuildIntentError, gameMatchup } = require("./buildIntentCommon");
const { randomizerPool } = require("./buildIntentPrefs");

const WATERMARK = "preferences.randomizerChallengeStartedAt";
const RACES = ["P", "T", "Z"];
const MATCHUPS = RACES.flatMap((mine) => RACES.map((opponent) => mine + "v" + opponent));
const STATS_PROJECTION = {
  _id: 0, date: 1, startedAt: 1, durationSec: 1, myRace: 1, "opponent.race": 1, result: 1,
  "buildIntent.randomizer.key": 1, "buildIntent.build.key": 1, "buildIntent.status": 1, "buildIntent.applied": 1,
};

/** @param {Record<string,any>} row */
function playedAt(row) {
  const started = row.startedAt instanceof Date ? row.startedAt.getTime() : Date.parse(row.startedAt);
  if (Number.isFinite(started)) return started;
  const duration = Number.isFinite(row.durationSec) && row.durationSec >= 0 ? row.durationSec * 1000 : 0;
  return row.date.getTime() - duration;
}

/** @param {string} matchup @param {unknown} preferences */
function newPool(matchup, preferences) {
  const config = randomizerPool(preferences, matchup);
  const keys = new Set(config.ids.slice(0, 500));
  return {
    keys, completed: new Set(),
    counts: { matchup, enabled: config.enabled, builds: keys.size, completed: 0,
      rolled: 0, playedAsRolled: 0, wins: 0, losses: 0, lastPlayed: /** @type {string|null} */ (null) },
  };
}

/** @param {ReturnType<typeof newPool>} pool @param {Record<string,any>} row */
function countRoll(pool, row) {
  const { counts, keys, completed } = pool;
  counts.rolled += 1;
  const intent = row.buildIntent;
  const rolled = intent.randomizer.key;
  if (intent.status !== "confirmed" || intent.applied !== true || intent.build?.key !== rolled) return;
  counts.playedAsRolled += 1;
  if (row.result === "Victory") counts.wins += 1;
  if (row.result === "Defeat") counts.losses += 1;
  const day = row.date.toISOString();
  if (!counts.lastPlayed || day > counts.lastPlayed) counts.lastPlayed = day;
  if (keys.has(rolled)) completed.add(rolled);
}

/** @param {Record<string,any>|null|undefined} doc */
function startedAt(doc) {
  const value = doc?.preferences?.randomizerChallengeStartedAt;
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : null;
}

class BuildIntentRandomizerChallenge {
  /** @param {import("../db/connect").DbContext} db @param {() => number} now */
  constructor(db, now) {
    this.games = db.games;
    this.users = db.users;
    this.now = now;
  }

  /** @param {string} userId */
  async stats(userId) {
    const state = await this.users.findOne({ userId }, {
      projection: { _id: 0, [WATERMARK]: 1, "preferences.randomizer.matchups": 1 },
    });
    const since = startedAt(state);
    const pools = new Map(MATCHUPS.map((matchup) => [matchup, newPool(matchup, state?.preferences?.randomizer)]));
    const games = this.games.find({
      userId, ...STATS_GAME_MATCH, isResumedFromReplay: { $ne: true },
      date: { $type: "date", ...(since ? { $gte: since } : {}) },
      "buildIntent.randomizer.key": { $type: "string" },
    }, { projection: STATS_PROJECTION, maxTimeMS: 5000, batchSize: 500 });
    try {
      for await (const row of games) {
        if (since && playedAt(row) < since.getTime()) continue;
        const matchup = gameMatchup(row);
        const pool = matchup ? pools.get(matchup) : undefined;
        if (pool) countRoll(pool, row);
      }
    } finally { await games.close(); }
    const current = await this.users.findOne({ userId }, { projection: { _id: 0, [WATERMARK]: 1 } });
    if (since?.getTime() !== startedAt(current)?.getTime()) {
      throw new BuildIntentError(409, "challenge_reset", "The challenge was reset while these results loaded. Refresh to see the new challenge.");
    }
    return {
      challengeStartedAt: since?.toISOString() ?? null,
      pools: [...pools.values()].filter(({ counts }) => counts.builds || counts.rolled)
        .map(({ counts, completed }) => ({ ...counts, completed: completed.size })),
    };
  }

  /** @param {string} userId */
  async reset(userId) {
    const row = await this.users.findOneAndUpdate({ userId }, { $max: { [WATERMARK]: new Date(this.now()) } }, {
      returnDocument: "after", projection: { _id: 0, [WATERMARK]: 1 },
    });
    const time = startedAt(row);
    if (!time) throw new BuildIntentError(404, "challenge_account_missing", "The account was not found.");
    return { challengeStartedAt: time.toISOString() };
  }
}

module.exports = { BuildIntentRandomizerChallenge };
