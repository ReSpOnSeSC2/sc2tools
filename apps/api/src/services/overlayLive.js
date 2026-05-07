"use strict";

const { buildSamplePayload } = require("./overlayLiveSamples");

/**
 * OverlayLiveService — derives the cloud's authoritative
 * ``LiveGamePayload`` for the OBS overlay.
 *
 * The legacy SPA's overlay required a local agent to push pre/post-game
 * data into the overlay socket room. In the cloud architecture every
 * widget except the session card historically sat blank because the
 * agent's ``push_overlay_live`` helper was wired but never called.
 *
 * This service closes that loop server-side: each time the agent
 * uploads a fresh game, we synthesise the same payload the legacy
 * pipeline would have pushed, then broadcast it to the user's overlay
 * sockets. Widgets render real data without the agent ever opening a
 * socket connection of its own.
 *
 * It also produces synthetic sample payloads for the Settings →
 * Overlay "Test" button, so streamers can validate their OBS layout
 * without waiting for a real ladder match.
 *
 * Field shape mirrors ``apps/web/components/overlay/types.ts`` exactly
 * — every key the renderer reads must come from here in the same case.
 */

/**
 * Strategy keywords that the cheese widget should highlight. Lowercase
 * match against ``opponent.strategy`` (substring) so variants like
 * "6 Pool" / "Pool first" / "Proxy 2 Gate" all light up. The threshold
 * the widget renders against (``cheeseProbability >= 0.4``) means we
 * pick a probability that comfortably crosses it — 0.7 — for any hit.
 * Non-matches get a baseline 0.1 so the widget hides itself.
 */
const CHEESE_KEYWORDS = [
  "cheese",
  "proxy",
  "cannon rush",
  "pool first",
  "6 pool",
  "8 pool",
  "all-in",
  "allin",
  "all in",
  "bunker rush",
  "worker rush",
];

/**
 * Map a numeric MMR to a Blizzard ladder league name + tier guess.
 * Boundaries follow Blizzard's published season cutoffs (approximate —
 * tiers within a league shift by a few hundred MMR each season). When
 * an upstream rank-resolver feeds us a real league later we can swap
 * this for the canonical mapping; for now this keeps the rank widget
 * rendering something plausible the second a game lands.
 */
function leagueFromMmr(mmr) {
  if (typeof mmr !== "number" || !Number.isFinite(mmr)) return null;
  if (mmr >= 6500) return { league: "Grandmaster", tier: 1 };
  if (mmr >= 5400) return { league: "Master", tier: 1 };
  if (mmr >= 5000) return { league: "Master", tier: 2 };
  if (mmr >= 4600) return { league: "Master", tier: 3 };
  if (mmr >= 4200) return { league: "Diamond", tier: 1 };
  if (mmr >= 3900) return { league: "Diamond", tier: 2 };
  if (mmr >= 3600) return { league: "Diamond", tier: 3 };
  if (mmr >= 3300) return { league: "Platinum", tier: 1 };
  if (mmr >= 3000) return { league: "Platinum", tier: 2 };
  if (mmr >= 2700) return { league: "Platinum", tier: 3 };
  if (mmr >= 2400) return { league: "Gold", tier: 1 };
  if (mmr >= 2100) return { league: "Gold", tier: 2 };
  if (mmr >= 1800) return { league: "Gold", tier: 3 };
  if (mmr >= 1500) return { league: "Silver", tier: 1 };
  if (mmr >= 1200) return { league: "Silver", tier: 2 };
  if (mmr >= 900) return { league: "Silver", tier: 3 };
  if (mmr >= 600) return { league: "Bronze", tier: 1 };
  return { league: "Bronze", tier: 3 };
}

function bucketResult(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (s === "win" || s === "victory") return "win";
  if (s === "loss" || s === "defeat") return "loss";
  return null;
}

/**
 * Format a duration in seconds as `m:ss`. Matches the SPA's
 * `formatMatchDuration` for the scouting card's recent-games list.
 *
 * @param {number} sec
 * @returns {string}
 */
function formatLengthText(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const m = Math.floor(n / 60);
  const s = Math.round(n % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

/**
 * Title-case an internal result tag for the scouting widget's chip
 * text. The SPA stored "Win" / "Loss" / "Tie" — we map the cloud's
 * "Victory" / "Defeat" to those so the widget can stay rendering-only.
 *
 * @param {string|undefined|null} raw
 * @returns {"Win"|"Loss"|"Tie"|null}
 */
function chipResult(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (s === "win" || s === "victory") return "Win";
  if (s === "loss" || s === "defeat") return "Loss";
  if (s === "tie") return "Tie";
  return null;
}

/**
 * Escape user-controlled chars before splicing into a regex anchor.
 * Race initials never carry regex metachars in practice but the
 * defensive helper keeps the lookup safe if the agent ever uploads a
 * non-canonical race string.
 *
 * @param {string} s
 * @returns {string}
 */
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchupLabel(myRace, oppRace) {
  const m = (myRace || "").charAt(0).toUpperCase();
  const o = (oppRace || "").charAt(0).toUpperCase();
  if (!m || !o) return undefined;
  return `${m}v${o}`;
}

function cheeseProbability(strategy) {
  if (!strategy) return 0.1;
  const s = String(strategy).toLowerCase();
  for (const k of CHEESE_KEYWORDS) {
    if (s.includes(k)) return 0.7;
  }
  return 0.1;
}

class OverlayLiveService {
  /**
   * @param {{
   *   games: import('mongodb').Collection,
   *   opponents: import('mongodb').Collection,
   * }} db
   * @param {{
   *   opponents?: any,
   * }} [services]
   */
  constructor(db, services = {}) {
    this.db = db;
    this.opponents = services.opponents || null;
  }

  /**
   * Build a complete ``LiveGamePayload`` from one freshly-ingested
   * game, hydrating cross-cutting fields (H2H, MMR delta, streak, top
   * builds) from the user's broader history.
   *
   * Returns ``null`` when the game is too thin to meaningfully populate
   * the overlay — e.g. a stub with no opponent and no result. The
   * caller should skip the broadcast in that case.
   *
   * @param {string} userId
   * @param {Record<string, any>} game
   * @returns {Promise<object | null>}
   */
  async buildFromGame(userId, game) {
    if (!game || !userId) return null;
    const opp = game.opponent || null;
    const myRace = game.myRace || undefined;
    const oppRace = opp?.race || undefined;
    /** @type {Record<string, any>} */
    const payload = {};
    if (myRace) payload.myRace = myRace;
    if (oppRace) payload.oppRace = oppRace;
    if (opp?.displayName) payload.oppName = opp.displayName;
    if (game.map) payload.map = game.map;
    const matchup = matchupLabel(myRace, oppRace);
    if (matchup) payload.matchup = matchup;
    const bucket = bucketResult(game.result);
    if (bucket) payload.result = bucket;
    if (Number.isFinite(Number(game.durationSec))) {
      payload.durationSec = Number(game.durationSec);
    }
    if (Number.isFinite(Number(opp?.mmr))) payload.oppMmr = Number(opp.mmr);
    if (Number.isFinite(Number(game.myMmr))) payload.myMmr = Number(game.myMmr);

    // Head-to-head from the opponents row, when the agent supplied a
    // pulseId. The opponents row is the cheap pre-aggregated counter;
    // a falsy lookup just means we skip the H2H/Rival/Rematch widgets
    // for this payload, never blocks the broadcast.
    const oppRow = opp?.pulseId
      ? await this.db.opponents
          .findOne(
            { userId, pulseId: opp.pulseId },
            {
              projection: {
                _id: 0,
                gameCount: 1,
                wins: 1,
                losses: 1,
                lastSeen: 1,
                openings: 1,
              },
            },
          )
          .catch(() => null)
      : null;

    if (oppRow) {
      const wins = Number(oppRow.wins) || 0;
      const losses = Number(oppRow.losses) || 0;
      payload.headToHead = { wins, losses };
      // Rival = repeat opponent (≥3 prior encounters). The widget
      // hides itself for casual one-off opponents — only flag the row
      // once the streamer has crossed paths enough to justify the
      // panel real estate.
      const games = Number(oppRow.gameCount) || wins + losses;
      if (games >= 3) {
        payload.rival = {
          name: opp?.displayName || undefined,
          headToHead: { wins, losses },
        };
      }
      // Rematch = same opponent within the last 24h, more than once.
      const lastSeen = oppRow.lastSeen
        ? new Date(oppRow.lastSeen).getTime()
        : null;
      if (
        lastSeen !== null
        && games >= 2
        && Date.now() - lastSeen <= 24 * 60 * 60 * 1000
      ) {
        payload.rematch = { isRematch: true, lastResult: bucket || undefined };
      }
      // Fav opening — most-frequent opening row stored in ``openings``.
      const openings = oppRow.openings && typeof oppRow.openings === "object"
        ? oppRow.openings
        : null;
      if (openings) {
        const entries = Object.entries(openings).filter(
          ([, v]) => Number.isFinite(Number(v)) && Number(v) > 0,
        );
        if (entries.length > 0) {
          entries.sort((a, b) => Number(b[1]) - Number(a[1]));
          const [name, count] = entries[0];
          const total = entries.reduce((acc, [, v]) => acc + Number(v), 0);
          payload.favOpening = {
            name,
            share: total > 0 ? Number(count) / total : 0,
            samples: Number(count),
          };
        }
      }
    }

    // Cheese alert — lit by the opponent's stored strategy.
    const cp = cheeseProbability(opp?.strategy);
    if (cp >= 0.4) payload.cheeseProbability = cp;

    // Predicted strategies — naive in-row weighting from the openings
    // map. The dashboard's recency-weighted predictor is richer but it
    // requires hydrating the full per-opponent game list; the overlay
    // panel only renders the top 3, so the openings counts are a
    // proportional-enough signal.
    if (oppRow?.openings) {
      const total = Object.values(oppRow.openings).reduce(
        (acc, v) => acc + Number(v || 0),
        0,
      );
      if (total > 0) {
        const preds = Object.entries(oppRow.openings)
          .map(([name, v]) => ({
            name,
            weight: Number(v) / total,
          }))
          .sort((a, b) => b.weight - a.weight)
          .slice(0, 3);
        if (preds.length > 0) payload.predictedStrategies = preds;
        // Scouting tells: project the same predictions but with a
        // confidence column so the scouting widget can render "look
        // for X by Y minutes".
        payload.scouting = preds.map((p) => ({
          label: p.name,
          confidence: p.weight,
        }));
      }
    }

    // Streak — walk the most-recent N games and count the current run.
    const streak = await this._computeStreak(userId);
    if (streak) payload.streak = streak;

    // MMR delta — compare against the previous game's myMmr if both
    // are populated. Otherwise leave undefined so the widget hides.
    if (Number.isFinite(Number(game.myMmr))) {
      const prev = await this._previousGameMmr(userId, game.gameId, game.date);
      if (prev !== null) {
        payload.mmrDelta = Number(game.myMmr) - prev;
      }
    }

    // Rank — derived from the just-played game's myMmr.
    if (Number.isFinite(Number(game.myMmr))) {
      const lg = leagueFromMmr(Number(game.myMmr));
      payload.rank = {
        ...(lg || {}),
        mmr: Number(game.myMmr),
      };
    }

    // Top builds the streamer has used in this matchup.
    if (matchup) {
      const top = await this._topBuildsForMatchup(userId, myRace, oppRace);
      if (top.length > 0) payload.topBuilds = top;
    }

    // Last N games vs this opponent in this matchup. Drives the
    // scouting card's "LAST GAMES" rows. We exclude the just-uploaded
    // game from the list so the widget shows *prior* meetings — the
    // current game's result is surfaced separately by match-result/
    // post-game widgets.
    if (opp) {
      const recent = await this._recentGamesForOpponent(
        userId,
        opp,
        myRace,
        oppRace,
        game.gameId,
      );
      if (recent.length > 0) payload.recentGames = recent;
    }

    // Best answer — for the opponent's most-likely opening, the
    // streamer's myBuild with the highest winRate (≥3 games for noise).
    const favOpeningStrategy = payload.favOpening?.name;
    if (favOpeningStrategy && myRace && oppRace) {
      const ans = await this._bestAnswerVsStrategy(
        userId,
        myRace,
        oppRace,
        favOpeningStrategy,
      );
      if (ans) payload.bestAnswer = ans;
    }

    // Meta — top opening shares for this matchup across the user's
    // own history. (A true ladder-wide meta would need a cross-user
    // aggregation; that's a separate project — for now we surface the
    // streamer's own match sample as "what's been working in this MU".)
    if (matchup) {
      const meta = await this._metaForMatchup(userId, myRace, oppRace);
      if (meta) payload.meta = { matchup, topBuilds: meta };
    }

    return payload;
  }

  /**
   * Synthetic full / per-widget payload for the Settings → Overlay
   * Test button. Implementation lives in ``overlayLiveSamples`` to
   * keep this file focused on production derivation logic; the static
   * passthrough preserves the existing call site shape used by the
   * /v1/overlay-events/test route + unit tests.
   *
   * @param {string} [widget]
   * @returns {object}
   */
  static buildSamplePayload(widget) {
    return buildSamplePayload(widget);
  }

  /**
   * Walk the most recent games and report the current win/loss run.
   * Returns null when the streak count is below 3 — the widget hides
   * itself anyway, no point pushing a payload it'll discard.
   *
   * @param {string} userId
   * @returns {Promise<{kind: 'win'|'loss', count: number} | null>}
   */
  async _computeStreak(userId) {
    const recent = await this.db.games
      .find({ userId }, { projection: { _id: 0, result: 1, date: 1 } })
      .sort({ date: -1 })
      .limit(20)
      .toArray()
      .catch(() => []);
    if (recent.length === 0) return null;
    /** @type {'win'|'loss'|null} */
    let kind = null;
    let count = 0;
    for (const r of recent) {
      const b = bucketResult(r.result);
      if (!b) continue;
      if (kind === null) {
        kind = b;
        count = 1;
        continue;
      }
      if (b !== kind) break;
      count += 1;
    }
    if (kind && count >= 3) return { kind, count };
    return null;
  }

  /**
   * Find the most recently dated game (other than ``excludeGameId``)
   * for this user that carries a numeric ``myMmr``. Used to compute the
   * MMR delta for the just-uploaded game.
   *
   * @param {string} userId
   * @param {string} [excludeGameId]
   * @param {Date|string} [beforeDate]
   * @returns {Promise<number|null>}
   */
  async _previousGameMmr(userId, excludeGameId, beforeDate) {
    /** @type {Record<string, any>} */
    const filter = {
      userId,
      myMmr: { $type: "number" },
    };
    if (excludeGameId) filter.gameId = { $ne: excludeGameId };
    if (beforeDate) {
      const d = beforeDate instanceof Date ? beforeDate : new Date(beforeDate);
      if (!Number.isNaN(d.getTime())) filter.date = { $lte: d };
    }
    const prev = await this.db.games
      .find(filter, { projection: { _id: 0, myMmr: 1, date: 1 } })
      .sort({ date: -1 })
      .limit(1)
      .toArray()
      .catch(() => []);
    if (prev.length === 0) return null;
    const m = Number(prev[0].myMmr);
    return Number.isFinite(m) ? m : null;
  }

  /**
   * Last N games against this opponent in this matchup, newest first.
   * Excludes the just-uploaded game so the scouting widget shows
   * *prior* meetings — the current game is what the streamer is about
   * to play, surfaced through the match-result/post-game widgets.
   *
   * Match precedence: pulseId (when the agent supplied one — most
   * stable, survives BattleTag renames) → displayName fallback. We
   * filter to the same `myRace`/`oppRace` matchup so a streamer who
   * once ZvT'd the opponent doesn't see those rows during a current
   * PvZ.
   *
   * @param {string} userId
   * @param {Record<string, any>} opp
   * @param {string|undefined} myRace
   * @param {string|undefined} oppRace
   * @param {string|undefined} excludeGameId
   * @returns {Promise<Array<{
   *   result: 'Win'|'Loss'|'Tie',
   *   lengthText: string,
   *   map?: string,
   *   myBuild?: string,
   *   oppBuild?: string,
   *   oppRace?: string,
   *   date?: string,
   * }>>}
   */
  async _recentGamesForOpponent(userId, opp, myRace, oppRace, excludeGameId) {
    if (!opp) return [];
    /** @type {Record<string, any>} */
    const filter = { userId };
    if (opp.pulseId) {
      filter["opponent.pulseId"] = opp.pulseId;
    } else if (opp.displayName) {
      filter["opponent.displayName"] = opp.displayName;
    } else {
      return [];
    }
    if (excludeGameId) filter.gameId = { $ne: excludeGameId };
    if (myRace) {
      filter.myRace = { $regex: `^${escapeRegex(String(myRace).charAt(0))}`, $options: "i" };
    }
    if (oppRace) {
      filter["opponent.race"] = {
        $regex: `^${escapeRegex(String(oppRace).charAt(0))}`,
        $options: "i",
      };
    }
    const rows = await this.db.games
      .find(filter, {
        projection: {
          _id: 0,
          result: 1,
          durationSec: 1,
          map: 1,
          myBuild: 1,
          "opponent.strategy": 1,
          "opponent.race": 1,
          date: 1,
        },
      })
      .sort({ date: -1 })
      .limit(5)
      .toArray()
      .catch(() => []);
    /** @type {Array<{result: 'Win'|'Loss'|'Tie', lengthText: string, map?: string, myBuild?: string, oppBuild?: string, oppRace?: string, date?: string}>} */
    const out = [];
    for (const r of rows) {
      const chip = chipResult(r.result);
      if (!chip) continue;
      /** @type {{result: 'Win'|'Loss'|'Tie', lengthText: string, map?: string, myBuild?: string, oppBuild?: string, oppRace?: string, date?: string}} */
      const row = {
        result: chip,
        lengthText: formatLengthText(Number(r.durationSec) || 0),
      };
      if (r.map) row.map = String(r.map);
      if (r.myBuild) row.myBuild = String(r.myBuild);
      if (r.opponent && r.opponent.strategy) row.oppBuild = String(r.opponent.strategy);
      if (r.opponent && r.opponent.race) row.oppRace = String(r.opponent.race);
      if (r.date instanceof Date) row.date = r.date.toISOString();
      else if (typeof r.date === "string") row.date = r.date;
      out.push(row);
    }
    return out;
  }

  /**
   * Top ``myBuild`` rows for a matchup, sorted by total games. Returns
   * up to 3 rows to match the widget's column budget. Ignores rows
   * with no ``myBuild`` so the panel doesn't surface "Unknown" at the
   * top of the list.
   *
   * @param {string} userId
   * @param {string} myRace
   * @param {string} oppRace
   * @returns {Promise<Array<{name: string, total: number, winRate: number}>>}
   */
  async _topBuildsForMatchup(userId, myRace, oppRace) {
    if (!myRace || !oppRace) return [];
    const myInitial = String(myRace).charAt(0).toUpperCase();
    const oppInitial = String(oppRace).charAt(0).toUpperCase();
    /** @type {any[]} */
    const pipeline = [
      {
        $match: {
          userId,
          myBuild: { $type: "string", $ne: "" },
          $expr: {
            $and: [
              {
                $eq: [
                  { $toUpper: { $substrCP: ["$myRace", 0, 1] } },
                  myInitial,
                ],
              },
              {
                $eq: [
                  { $toUpper: { $substrCP: ["$opponent.race", 0, 1] } },
                  oppInitial,
                ],
              },
            ],
          },
        },
      },
      {
        $group: {
          _id: "$myBuild",
          wins: {
            $sum: {
              $cond: [
                {
                  $in: [
                    { $toLower: { $ifNull: ["$result", ""] } },
                    ["victory", "win"],
                  ],
                },
                1,
                0,
              ],
            },
          },
          total: { $sum: 1 },
        },
      },
      // ``$sort`` then ``$limit`` is intentional: a streamer with a
      // long matchup history could have dozens of distinct myBuilds,
      // and the panel only renders the top 3.
      { $sort: { total: -1 } },
      { $limit: 3 },
    ];
    const rows = await this.db.games
      .aggregate(pipeline)
      .toArray()
      .catch(() => []);
    return rows.map((r) => ({
      name: String(r._id),
      total: r.total || 0,
      winRate: r.total > 0 ? (r.wins || 0) / r.total : 0,
    }));
  }

  /**
   * Streamer's best ``myBuild`` against a specific opponent strategy
   * inside a matchup. Used by the "Best Answer" widget.
   *
   * @param {string} userId
   * @param {string} myRace
   * @param {string} oppRace
   * @param {string} strategy
   * @returns {Promise<{build: string, winRate: number, total: number} | null>}
   */
  async _bestAnswerVsStrategy(userId, myRace, oppRace, strategy) {
    if (!strategy) return null;
    const myInitial = String(myRace).charAt(0).toUpperCase();
    const oppInitial = String(oppRace).charAt(0).toUpperCase();
    /** @type {any[]} */
    const pipeline = [
      {
        $match: {
          userId,
          myBuild: { $type: "string", $ne: "" },
          "opponent.strategy": strategy,
          $expr: {
            $and: [
              {
                $eq: [
                  { $toUpper: { $substrCP: ["$myRace", 0, 1] } },
                  myInitial,
                ],
              },
              {
                $eq: [
                  { $toUpper: { $substrCP: ["$opponent.race", 0, 1] } },
                  oppInitial,
                ],
              },
            ],
          },
        },
      },
      {
        $group: {
          _id: "$myBuild",
          wins: {
            $sum: {
              $cond: [
                {
                  $in: [
                    { $toLower: { $ifNull: ["$result", ""] } },
                    ["victory", "win"],
                  ],
                },
                1,
                0,
              ],
            },
          },
          total: { $sum: 1 },
        },
      },
      // The 3-game floor protects against the "100% in a 1-game sample"
      // noise that would otherwise put a flukey opener at the top.
      { $match: { total: { $gte: 3 } } },
      { $sort: { wins: -1, total: -1 } },
      { $limit: 1 },
    ];
    const rows = await this.db.games
      .aggregate(pipeline)
      .toArray()
      .catch(() => []);
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      build: String(r._id),
      total: r.total || 0,
      winRate: r.total > 0 ? (r.wins || 0) / r.total : 0,
    };
  }

  /**
   * Top opening shares (by share-of-encounters) the streamer has seen
   * from opponents in this matchup. Used by the "Meta snapshot" widget.
   *
   * @param {string} userId
   * @param {string} myRace
   * @param {string} oppRace
   * @returns {Promise<Array<{name: string, share: number}>>}
   */
  async _metaForMatchup(userId, myRace, oppRace) {
    if (!myRace || !oppRace) return [];
    const myInitial = String(myRace).charAt(0).toUpperCase();
    const oppInitial = String(oppRace).charAt(0).toUpperCase();
    /** @type {any[]} */
    const pipeline = [
      {
        $match: {
          userId,
          "opponent.strategy": { $type: "string", $ne: "" },
          $expr: {
            $and: [
              {
                $eq: [
                  { $toUpper: { $substrCP: ["$myRace", 0, 1] } },
                  myInitial,
                ],
              },
              {
                $eq: [
                  { $toUpper: { $substrCP: ["$opponent.race", 0, 1] } },
                  oppInitial,
                ],
              },
            ],
          },
        },
      },
      { $group: { _id: "$opponent.strategy", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
    ];
    const rows = await this.db.games
      .aggregate(pipeline)
      .toArray()
      .catch(() => []);
    if (rows.length === 0) return [];
    const total = rows.reduce((acc, r) => acc + (r.count || 0), 0);
    if (total === 0) return [];
    return rows.map((r) => ({
      name: String(r._id),
      share: (r.count || 0) / total,
    }));
  }
}

module.exports = {
  OverlayLiveService,
  leagueFromMmr,
  cheeseProbability,
  matchupLabel,
  bucketResult,
};
