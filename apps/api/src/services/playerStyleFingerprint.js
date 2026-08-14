"use strict";

/**
 * Replay-derived playstyle fingerprint.
 *
 * The three measurements are tendencies, not grades or percentiles:
 *   Consistent Grinder <-> Creative Genius
 *   Cheeser <-> Late-Game Specialist
 *   Matchup Specialist <-> Matchup Blind Spot
 *
 * Only slim `games` fields are read. Missing evidence stays missing; no
 * benchmark, estimate, or mock value is substituted.
 */

const WINDOW_GAMES = 50;
const MIN_GAMES = 10;
const MIN_BUILD_SAMPLE = 10;
const MIN_DURATION_SAMPLE = 10;
const MIN_MATCHUP_GAMES = 10;

const GRINDER_MAX_BUILDS = 2;
const CREATIVE_MIN_BUILDS = 10;
const MIN_VALID_DURATION_SEC = 45;
const CHEESE_MAX_SEC = 5 * 60;
const LATE_GAME_MIN_SEC = 15 * 60;
const BALANCED_MAX_SPREAD = 1;
const NEAR_BALANCED_MAX_SPREAD = 5;
const SPECIALIST_MIN_LEAD = 10;
const BLIND_SPOT_MIN_GAP = 10;
const NEAR_BALANCED_POSITION_RADIUS = 10;
const THRESHOLD_EPSILON = 1e-9;

const RACE_LETTERS = Object.freeze(["P", "T", "Z"]);

/** Four matchup states keep the exact 1-point universalist rule visible. */
const ARCHETYPE_NAMES = Object.freeze({
  "grinder|cheeser|specialist": "Precision Ambusher",
  "grinder|cheeser|matchup_flex": "Calculated Raider",
  "grinder|cheeser|universalist": "Three-Matchup Punisher",
  "grinder|cheeser|blind_spot": "Two-Front Raider",
  "grinder|standard|specialist": "Matchup Technician",
  "grinder|standard|matchup_flex": "Disciplined Operator",
  "grinder|standard|universalist": "Reliable All-Rounder",
  "grinder|standard|blind_spot": "Two-Front Technician",
  "grinder|late_game|specialist": "Fortress Specialist",
  "grinder|late_game|matchup_flex": "Endurance Engineer",
  "grinder|late_game|universalist": "Macro Machine",
  "grinder|late_game|blind_spot": "Fault-Line Fortress",

  "adaptive|cheeser|specialist": "Counter-Build Hunter",
  "adaptive|cheeser|matchup_flex": "Tempo Trickster",
  "adaptive|cheeser|universalist": "Opening Opportunist",
  "adaptive|cheeser|blind_spot": "Two-Front Trapper",
  "adaptive|standard|specialist": "Strategic Specialist",
  "adaptive|standard|matchup_flex": "Adaptive Competitor",
  "adaptive|standard|universalist": "Versatile Tactician",
  "adaptive|standard|blind_spot": "Strategic Soft Spot",
  "adaptive|late_game|specialist": "Endgame Counterpuncher",
  "adaptive|late_game|matchup_flex": "Scaling Strategist",
  "adaptive|late_game|universalist": "Endgame Generalist",
  "adaptive|late_game|blind_spot": "Scaling Soft Spot",

  "creative|cheeser|specialist": "Lab-Crafted Ambusher",
  "creative|cheeser|matchup_flex": "Chaos Architect",
  "creative|cheeser|universalist": "Wildcard Raider",
  "creative|cheeser|blind_spot": "Two-Front Wildcard",
  "creative|standard|specialist": "Matchup Inventor",
  "creative|standard|matchup_flex": "Build Lab Explorer",
  "creative|standard|universalist": "Creative All-Rounder",
  "creative|standard|blind_spot": "Creative Soft Spot",
  "creative|late_game|specialist": "Endgame Innovator",
  "creative|late_game|matchup_flex": "Late-Game Visionary",
  "creative|late_game|universalist": "Strategic Polymath",
  "creative|late_game|blind_spot": "Endgame Soft Spot",
});

const TRAIT_LABELS = Object.freeze({
  grinder: "Consistent Grinder",
  adaptive: "Adaptive Strategist",
  creative: "Creative Genius",
  cheeser: "Cheeser",
  standard: "Flexible Pacer",
  late_game: "Late-Game Specialist",
  specialist: "Matchup Specialist",
  matchup_flex: "Matchup Flex",
  universalist: "Matchup Universalist",
  blind_spot: "Matchup Blind Spot",
});

const TRAIT_DESCRIPTIONS = Object.freeze({
  grinder:
    "You use 1-2 build orders in this matchup and sharpen them through repetition.",
  adaptive:
    "You use 3-9 build orders in this matchup, giving you options without changing plans every game.",
  creative:
    "You use 10 or more build orders in this matchup and regularly show opponents something different.",
  cheeser:
    "Your average game ends in 5:00 or less, so your games are usually decided by early aggression.",
  standard:
    "Your average game is longer than 5:00 but shorter than 15:00, mixing early pressure, mid-game play, and transitions.",
  late_game:
    "Your average game lasts 15:00 or longer, showing that you are comfortable with late-game armies and upgrades.",
  specialist:
    "One matchup is at least 10% stronger than both of your other matchups.",
  matchup_flex:
    "Your matchup win rates are not perfectly even, but no matchup stands 10% above or below both others.",
  universalist: "All three matchup win rates are within 1% of each other.",
  blind_spot:
    "One matchup is at least 10% weaker than both of your other matchups.",
});

class SkillFingerprintService {
  /**
   * @param {{ games: import('mongodb').Collection }} db
   * @param {{ logger?: import('pino').Logger | null }} [opts]
   */
  constructor(db, opts = {}) {
    this.games = db.games;
    this.logger = opts.logger || null;
  }

  /**
   * Repertoire and pace use the selected matchup. Matchup shape uses the
   * latest independent window against P, T, and Z for the selected own race.
   *
   * @param {string} userId
   * @param {{ matchup?: string }} [args]
   * @returns {Promise<Record<string, any> | null>}
   */
  async compute(userId, { matchup } = {}) {
    if (typeof userId !== "string" || !userId) return null;
    const mu = normalizeMatchup(matchup);
    if (!mu) return null;

    const selectedRows = await loadWindow(this.games, userId, mu);
    if (selectedRows.length < MIN_GAMES) return null;

    const windows = await Promise.all(
      RACE_LETTERS.map((opponentRace) => {
        const candidate = `${mu[0]}v${opponentRace}`;
        return candidate === mu
          ? Promise.resolve(selectedRows)
          : loadWindow(this.games, userId, candidate);
      }),
    );
    const rowsByMatchup = Object.fromEntries(
      RACE_LETTERS.map((opponentRace, index) => [
        `${mu[0]}v${opponentRace}`,
        windows[index],
      ]),
    );

    const repertoire = repertoireAxis(selectedRows);
    const pace = paceAxis(selectedRows);
    const balance = matchupBalanceAxis(mu[0], rowsByMatchup);
    const axes = [
      publicAxis("repertoire", "Build repertoire", repertoire),
      publicAxis("pace", "Game length", pace),
      publicAxis("matchup_balance", "Matchup shape", balance),
    ];
    const archetype = deriveArchetype({
      repertoire: repertoire.category,
      pace: pace.category,
      matchup: balance.category,
    });

    return {
      matchup: mu,
      race: mu[0],
      games: selectedRows.length,
      windowGames: WINDOW_GAMES,
      axes,
      playstyle: archetype.name,
      archetype,
      buildOrders: repertoire.builds,
      matchupWinRates: balance.matchups,
      matchupSummary: {
        spread: balance.value,
        leaderGap: balance.leaderGap,
        weakGap: balance.weakGap,
        strongestMatchup: balance.strongestMatchup,
        weakestMatchup: balance.weakestMatchup,
      },
    };
  }
}

/**
 * @param {string} key
 * @param {string} label
 * @param {{position:number|null,value:number|null,category:string|null,categoryLabel?:string|null,sampleSize:number}} result
 */
function publicAxis(key, label, result) {
  const labels = /** @type {Record<string, string>} */ (TRAIT_LABELS);
  return {
    key,
    label,
    position: result.position,
    value: result.value,
    category: result.category,
    categoryLabel:
      result.categoryLabel ||
      (result.category ? labels[result.category] || result.category : null),
    sampleSize: result.sampleSize,
  };
}

/** @param {Array<Record<string, any>>} rows */
function repertoireAxis(rows) {
  /** @type {Map<string, {name:string,games:number}>} */
  const counts = new Map();
  for (const row of rows) {
    const name = validBuildName(row && row.myBuild);
    if (!name) continue;
    const identity = name.toLocaleLowerCase("en-US");
    const existing = counts.get(identity);
    if (existing) existing.games += 1;
    else counts.set(identity, { name, games: 1 });
  }
  const builds = [...counts.values()].sort(
    (a, b) => b.games - a.games || a.name.localeCompare(b.name),
  );
  const sampleSize = builds.reduce((sum, item) => sum + item.games, 0);
  const value = builds.length;
  if (sampleSize < MIN_BUILD_SAMPLE || value === 0) {
    return {
      position: null,
      value,
      category: null,
      categoryLabel: null,
      sampleSize,
      builds,
    };
  }
  const category =
    value <= GRINDER_MAX_BUILDS
      ? "grinder"
      : value >= CREATIVE_MIN_BUILDS
        ? "creative"
        : "adaptive";
  return {
    position: linearPosition(value, GRINDER_MAX_BUILDS, CREATIVE_MIN_BUILDS),
    value,
    category,
    categoryLabel: TRAIT_LABELS[category],
    sampleSize,
    builds,
  };
}

/** @param {Array<Record<string, any>>} rows */
function paceAxis(rows) {
  const durations = rows
    .map((row) => row && row.durationSec)
    .filter(
      (value) =>
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= MIN_VALID_DURATION_SEC,
    );
  const sampleSize = durations.length;
  const rawValue = sampleSize ? mean(durations) : null;
  const value = rawValue === null ? null : round2(rawValue);
  if (sampleSize < MIN_DURATION_SAMPLE) {
    return {
      position: null,
      value,
      category: null,
      categoryLabel: null,
      sampleSize,
    };
  }
  const category =
    /** @type {number} */ (rawValue) <= CHEESE_MAX_SEC
      ? "cheeser"
      : /** @type {number} */ (rawValue) >= LATE_GAME_MIN_SEC
        ? "late_game"
        : "standard";
  return {
    position: linearPosition(
      /** @type {number} */ (rawValue),
      CHEESE_MAX_SEC,
      LATE_GAME_MIN_SEC,
    ),
    value,
    category,
    categoryLabel: TRAIT_LABELS[category],
    sampleSize,
  };
}

/**
 * Specialist is `best - middle >= 10`; Blind Spot is `middle - worst >=
 * 10`. If both happen, the larger raw gap determines the direction. An exact
 * adjacent-gap tie keeps the original heuristic's deterministic specialist
 * priority, so a wide 70/60/50 shape can never masquerade as balanced.
 *
 * @param {string} playerRace
 * @param {Record<string, Array<Record<string, any>>>} rowsByMatchup
 */
function matchupBalanceAxis(playerRace, rowsByMatchup) {
  const matchups = RACE_LETTERS.map((opponentRace) =>
    matchupResult(playerRace, opponentRace, rowsByMatchup),
  );
  const sampleSize = matchups.reduce((sum, item) => sum + item.decidedGames, 0);
  const enough = matchups.every((item) => item.decidedGames >= MIN_MATCHUP_GAMES);
  if (!enough) {
    return {
      position: null,
      value: null,
      category: null,
      categoryLabel: null,
      sampleSize,
      matchups,
      leaderGap: null,
      weakGap: null,
      strongestMatchup: null,
      weakestMatchup: null,
    };
  }

  const shape = matchupShape(matchups);
  return {
    ...shape,
    categoryLabel:
      /** @type {Record<string, string>} */ (TRAIT_LABELS)[shape.category],
    sampleSize,
    matchups,
  };
}

/**
 * @param {string} playerRace
 * @param {string} opponentRace
 * @param {Record<string, Array<Record<string, any>>>} rowsByMatchup
 */
function matchupResult(playerRace, opponentRace, rowsByMatchup) {
  const matchup = `${playerRace}v${opponentRace}`;
  const rows = Array.isArray(rowsByMatchup[matchup])
    ? rowsByMatchup[matchup]
    : [];
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const row of rows) {
    const result = resultBucket(row && row.result);
    if (result === "win") wins += 1;
    else if (result === "loss") losses += 1;
    else if (result === "tie") ties += 1;
  }
  const decidedGames = wins + losses;
  return {
    matchup,
    games: rows.length,
    decidedGames,
    wins,
    losses,
    ties,
    winRate: decidedGames ? round3((100 * wins) / decidedGames) : null,
  };
}

/**
 * Thresholds use raw rates reconstructed from wins / decided games. Returned
 * matchup percentages use three decimals so fractional boundary decisions stay
 * reconcilable with their displayed values.
 *
 * @param {Array<{matchup:string,wins:number,decidedGames:number,winRate:number|null}>} matchups
 */
function matchupShape(matchups) {
  const ranked = matchups
    .map((matchup) => ({
      matchup,
      rawWinRate: (100 * matchup.wins) / matchup.decidedGames,
    }))
    .sort((a, b) => b.rawWinRate - a.rawWinRate);
  const best = ranked[0];
  const middle = ranked[1];
  const worst = ranked[2];
  const rawSpread = best.rawWinRate - worst.rawWinRate;
  const rawLeaderGap = best.rawWinRate - middle.rawWinRate;
  const rawWeakGap = middle.rawWinRate - worst.rawWinRate;

  let category = "matchup_flex";
  if (atMostThreshold(rawSpread, BALANCED_MAX_SPREAD)) {
    category = "universalist";
  }
  else if (
    atLeastThreshold(rawLeaderGap, SPECIALIST_MIN_LEAD) &&
    !meaningfullyGreater(rawWeakGap, rawLeaderGap)
  ) category = "specialist";
  else if (
    atLeastThreshold(rawWeakGap, BLIND_SPOT_MIN_GAP) &&
    meaningfullyGreater(rawWeakGap, rawLeaderGap)
  ) category = "blind_spot";

  let position = 50;
  if (category === "specialist") position = 0;
  else if (category === "blind_spot") position = 100;
  else if (category !== "universalist") {
    position = flexMatchupPosition(
      rawSpread,
      rawLeaderGap,
      rawWeakGap,
    );
  }

  return {
    position,
    value: round3(rawSpread),
    category,
    leaderGap: round3(rawLeaderGap),
    weakGap: round3(rawWeakGap),
    strongestMatchup: best.matchup.matchup,
    weakestMatchup: worst.matchup.matchup,
  };
}

/**
 * Matchup Flex occupies the interior of the same 0-100 spectrum as the two
 * endpoint categories. A 1-5 point total spread moves zero-to-ten points away
 * from center; above five, the dominant adjacent gap moves the marker from ten
 * toward fifty points away. Equal adjacent gaps use the original specialist
 * (left) priority. Only a raw qualifying gap may claim exact 0 or 100, and 50
 * is reserved for the universalist category.
 *
 * @param {number} spread
 * @param {number} leaderGap
 * @param {number} weakGap
 */
function flexMatchupPosition(spread, leaderGap, weakGap) {
  const direction = meaningfullyGreater(weakGap, leaderGap) ? 1 : -1;
  let offset;
  if (atMostThreshold(spread, NEAR_BALANCED_MAX_SPREAD)) {
    const nearFraction = Math.max(
      0,
      Math.min(
        1,
        (spread - BALANCED_MAX_SPREAD) /
          (NEAR_BALANCED_MAX_SPREAD - BALANCED_MAX_SPREAD),
      ),
    );
    offset = NEAR_BALANCED_POSITION_RADIUS * nearFraction;
  } else {
    const dominantGap = Math.max(leaderGap, weakGap);
    const transitionFraction = Math.max(
      0,
      Math.min(
        1,
        (dominantGap - NEAR_BALANCED_MAX_SPREAD) /
          (SPECIALIST_MIN_LEAD - NEAR_BALANCED_MAX_SPREAD),
      ),
    );
    offset =
      NEAR_BALANCED_POSITION_RADIUS +
      (50 - NEAR_BALANCED_POSITION_RADIUS) * transitionFraction;
  }
  const rounded = Math.round(50 + direction * offset);
  if (rounded === 50) return 50 + direction;
  return Math.max(1, Math.min(99, rounded));
}

/** @param {number} value @param {number} threshold */
function atMostThreshold(value, threshold) {
  return value <= threshold + THRESHOLD_EPSILON;
}

/** @param {number} value @param {number} threshold */
function atLeastThreshold(value, threshold) {
  return value + THRESHOLD_EPSILON >= threshold;
}

/** @param {number} left @param {number} right */
function meaningfullyGreater(left, right) {
  return left > right + THRESHOLD_EPSILON;
}

/**
 * @param {{repertoire?:string|null,pace?:string|null,matchup?:string|null}} traits
 */
function deriveArchetype(traits) {
  const ordered = [traits.repertoire, traits.pace, traits.matchup].map(
    (value) => (typeof value === "string" && value ? value : null),
  );
  const complete = ordered.every(Boolean);
  const key = complete
    ? ordered.join("|")
    : `partial:${ordered.map((value) => value || "?").join("|")}`;
  const present = /** @type {string[]} */ (ordered.filter(Boolean));
  const names = /** @type {Record<string, string>} */ (ARCHETYPE_NAMES);
  const labels = /** @type {Record<string, string>} */ (TRAIT_LABELS);
  const descriptions = /** @type {Record<string, string>} */ (
    TRAIT_DESCRIPTIONS
  );
  const name = complete
    ? names[key]
    : present.length
      ? present.map((trait) => labels[trait] || trait).join(" · ")
      : "Profile Still Forming";
  const description = present.length
    ? present
        .map((trait) => descriptions[trait])
        .filter(Boolean)
        .join(" ")
    : "More replay evidence is needed before a player archetype can be assigned.";
  return {
    key,
    name: name || "Profile Still Forming",
    description,
    complete,
  };
}

/**
 * Latest qualifying 1v1 rows for one matchup. The projection contains only
 * slim ingest fields, never a build log or game-details payload.
 *
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @param {string} matchup
 */
function loadWindow(games, userId, matchup) {
  return games
    .find(
      {
        userId,
        isResumedFromReplay: { $ne: true },
        myRace: { $regex: `^${matchup[0]}`, $options: "i" },
        "opponent.race": { $regex: `^${matchup[2]}`, $options: "i" },
        $or: [
          { matchFormat: "1v1" },
          {
            matchFormat: { $exists: false },
            playerCount: 2,
          },
        ],
      },
      {
        projection: {
          _id: 0,
          myBuild: 1,
          durationSec: 1,
          result: 1,
          date: 1,
        },
        sort: { date: -1, _id: -1 },
        limit: WINDOW_GAMES,
      },
    )
    .toArray();
}

/** @param {unknown} raw */
function validBuildName(raw) {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) return null;
  if (/game too short/i.test(name)) return null;
  if (/unclassified/i.test(name)) return null;
  if (/^(?:unknown|unsorted|n\/?a|none)$/i.test(name)) return null;
  return name;
}

/** @param {unknown} raw */
function resultBucket(raw) {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "victory" || value === "win") return "win";
  if (value === "defeat" || value === "loss") return "loss";
  if (value === "tie" || value === "draw") return "tie";
  return null;
}

/** @param {number} value @param {number} low @param {number} high */
function linearPosition(value, low, high) {
  if (!Number.isFinite(value) || high <= low) return 0;
  if (value <= low) return 0;
  if (value >= high) return 100;
  return Math.max(
    1,
    Math.min(99, Math.round((100 * (value - low)) / (high - low))),
  );
}

/** @param {number[]} values */
function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** @param {number} value */
function round2(value) {
  return Math.round(value * 100) / 100;
}

/** @param {number} value */
function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/** @param {unknown} raw */
function normalizeMatchup(raw) {
  if (typeof raw !== "string") return null;
  const match = /^([ptz])\s*v\s*([ptz])$/i.exec(raw.trim());
  if (!match) return null;
  return `${match[1].toUpperCase()}v${match[2].toUpperCase()}`;
}

module.exports = {
  SkillFingerprintService,
  deriveArchetype,
  repertoireAxis,
  paceAxis,
  matchupBalanceAxis,
  ARCHETYPE_NAMES,
  TRAIT_LABELS,
  WINDOW_GAMES,
  MIN_GAMES,
  MIN_BUILD_SAMPLE,
  MIN_DURATION_SAMPLE,
  MIN_MATCHUP_GAMES,
  GRINDER_MAX_BUILDS,
  CREATIVE_MIN_BUILDS,
  MIN_VALID_DURATION_SEC,
  CHEESE_MAX_SEC,
  LATE_GAME_MIN_SEC,
  BALANCED_MAX_SPREAD,
  NEAR_BALANCED_MAX_SPREAD,
  SPECIALIST_MIN_LEAD,
  BLIND_SPOT_MIN_GAP,
};
