"use strict";

/**
 * Replay-derived playstyle fingerprint.
 *
 * The three measurements are tendencies, not grades or percentiles:
 *   Build-Order One-Trick <-> Creative Genius
 *   Cheeser <-> Late-Game Master (with distribution-aware tempo profiles)
 *   Matchup Master <-> Matchup Blind Spot
 *
 * Only slim `games` fields are read. Missing evidence stays missing; no
 * benchmark, estimate, or mock value is substituted.
 */

const WINDOW_GAMES = 50;
const MIN_GAMES = 10;
const MIN_BUILD_SAMPLE = 10;
const MIN_DURATION_SAMPLE = 10;
const MIN_MATCHUP_GAMES = 10;

const ONE_TRICK_MAX_EFFECTIVE_BUILDS = 1.5;
const SIGNATURE_MAX_EFFECTIVE_BUILDS = 2.5;
const GRINDER_MAX_EFFECTIVE_BUILDS = 5;
const CREATIVE_MIN_EFFECTIVE_BUILDS = 10;
const MIN_VALID_DURATION_SEC = 45;
const FIVE_MIN_SEC = 5 * 60;
const SEVEN_MIN_SEC = 7 * 60;
const FIFTEEN_MIN_SEC = 15 * 60;
const TWO_SPEED_MIN_PERCENT = 25;
const DOMINANT_TIMEFRAME_MIN_PERCENT = 80;
const BALANCED_MAX_SPREAD = 5;
const MODERATE_MATCHUP_ANCHOR = 7.5;
const SPECIALIST_MIN_LEAD = 10;
const BLIND_SPOT_MIN_GAP = 10;
const THRESHOLD_EPSILON = 1e-9;

const RACE_LETTERS = Object.freeze(["P", "T", "Z"]);

const ARCHETYPE_CORE_NAMES = Object.freeze({
  one_trick: Object.freeze({
    cheeser: "Pocket-Knife Ambusher",
    timing_attacker: "Clockwork Attacker",
    flexible: "Signature-Plan Pilot",
    mid_late_master: "One-Line Commander",
    late_game: "Fortress Devotee",
    late_game_master: "Endgame Purist",
    two_speed: "Binary Switchblade",
  }),
  signature: Object.freeze({
    cheeser: "Opening Loyalist",
    timing_attacker: "Timing Craftsman",
    flexible: "Comfort-Pool Captain",
    mid_late_master: "Core-Plan Commander",
    late_game: "Scaling Loyalist",
    late_game_master: "Endgame Artisan",
    two_speed: "Dual-Gear Duelist",
  }),
  grinder: Object.freeze({
    cheeser: "Repetition Raider",
    timing_attacker: "Timing Technician",
    flexible: "Disciplined Operator",
    mid_late_master: "Macro Mechanic",
    late_game: "Endurance Engineer",
    late_game_master: "Siege Architect",
    two_speed: "Tempo Gearbox",
  }),
  adaptive: Object.freeze({
    cheeser: "Counter-Build Hunter",
    timing_attacker: "Timing Shapeshifter",
    flexible: "Adaptive Competitor",
    mid_late_master: "Strategic Navigator",
    late_game: "Scaling Strategist",
    late_game_master: "Endgame Generalist",
    two_speed: "Two-Gear Tactician",
  }),
  creative: Object.freeze({
    cheeser: "Lab-Crafted Ambusher",
    timing_attacker: "Timing Inventor",
    flexible: "Build-Lab Explorer",
    mid_late_master: "Transition Alchemist",
    late_game: "Late-Game Visionary",
    late_game_master: "Strategic Polymath",
    two_speed: "Chaos Switchboard",
  }),
});

const MATCHUP_ARCHETYPE_PREFIXES = Object.freeze({
  specialist: "Apex",
  matchup_edge: "Favored",
  universalist: "Universal",
  matchup_hurdle: "Battle-Tested",
  blind_spot: "Fault-Line",
});

const ARCHETYPE_NAMES = Object.freeze(buildArchetypeNames());

const TRAIT_LABELS = Object.freeze({
  one_trick: "Build-Order One-Trick",
  signature: "Signature Pilot",
  grinder: "Consistent Grinder",
  adaptive: "Adaptive Strategist",
  creative: "Creative Genius",
  cheeser: "Cheeser",
  timing_attacker: "Timing Attacker",
  flexible: "Flexible Pacer",
  mid_late_master: "Mid/Late-Game Master",
  late_game: "Long-Game Lean",
  late_game_master: "Late-Game Master",
  two_speed: "Two-Speed Player",
  specialist: "Matchup Master",
  matchup_edge: "Matchup Edge",
  universalist: "All-Matchup Ace",
  matchup_hurdle: "Matchup Hurdle",
  blind_spot: "Matchup Blind Spot",
});

const TRAIT_DESCRIPTIONS = Object.freeze({
  one_trick:
    "Your build usage has the diversity of 1.5 or fewer equally played builds, showing a deeply rehearsed primary plan.",
  signature:
    "Your build usage has the diversity of more than 1.5 and at most 2.5 equally played builds, centered on a small signature pool.",
  grinder:
    "Your build usage has the diversity of more than 2.5 and at most 5 equally played builds, favoring repetition with a few dependable branches.",
  adaptive:
    "Your build usage has the diversity of more than 5 but fewer than 10 equally played builds, giving you a broad but still focused pool.",
  creative:
    "Your build usage has the diversity of 10 or more equally played builds, so variety is a defining part of your approach.",
  cheeser:
    "Your average game ends before 5:00 after the stronger distribution patterns are checked, pointing to consistently early decisions.",
  timing_attacker:
    "At least 80% of your games end from 5:00 through 7:00, revealing a concentrated timing-attack window.",
  flexible:
    "Your duration mix has no stronger specialist pattern and its average sits from 5:00 through 15:00.",
  mid_late_master:
    "At least 80% of your games last beyond 7:00, showing dependable comfort through the mid game and later transitions.",
  late_game:
    "Your average game lasts beyond 15:00, but fewer than 80% individually cross that mark, so this is a long-game lean rather than a mastery claim.",
  late_game_master:
    "At least 80% of your games last beyond 15:00, making deep late-game play a repeatable pattern.",
  two_speed:
    "At least 25% of your games end before 5:00 and at least 25% last beyond 15:00, showing two distinct tempo gears.",
  specialist:
    "One matchup has a dominant win-rate lead of at least 10 percentage points over the next-best matchup.",
  matchup_edge:
    "Your matchup results have a moderate strength-side edge; 7.5 percentage points is the scoring anchor between balanced and dominant.",
  universalist:
    "All three matchup win rates are within 5 percentage points of each other.",
  matchup_hurdle:
    "Your matchup results have a moderate weakness-side hurdle; 7.5 percentage points is the scoring anchor between balanced and severe.",
  blind_spot:
    "One matchup has a dominant win-rate deficit of at least 10 percentage points behind the next-weakest matchup.",
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
      repertoireSummary: repertoire.summary,
      paceSummary: pace.summary,
      matchupWinRates: balance.matchups,
      matchupSummary: {
        spread: balance.value,
        leaderGap: balance.leaderGap,
        weakGap: balance.weakGap,
        signedEdge: balance.signedEdge,
        tierScore: balance.tierScore,
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
  const distinctBuilds = builds.length;
  const rawEffectiveBuilds = inverseSimpsonEffectiveCount(builds, sampleSize);
  // Six decimals keep displayed evidence on the same side of every category
  // boundary while still avoiding a noisy floating-point payload.
  const effectiveBuilds = round6(rawEffectiveBuilds);
  const summary = { distinctBuilds, effectiveBuilds };
  if (sampleSize < MIN_BUILD_SAMPLE || distinctBuilds === 0) {
    return {
      position: null,
      value: effectiveBuilds,
      category: null,
      categoryLabel: null,
      sampleSize,
      builds,
      summary,
    };
  }
  const category = repertoireCategory(rawEffectiveBuilds);
  return {
    position: linearPosition(
      rawEffectiveBuilds,
      ONE_TRICK_MAX_EFFECTIVE_BUILDS,
      CREATIVE_MIN_EFFECTIVE_BUILDS,
    ),
    value: effectiveBuilds,
    category,
    categoryLabel: TRAIT_LABELS[category],
    sampleSize,
    builds,
    summary,
  };
}

/** @param {number} effectiveBuilds */
function repertoireCategory(effectiveBuilds) {
  if (atMostThreshold(effectiveBuilds, ONE_TRICK_MAX_EFFECTIVE_BUILDS)) {
    return "one_trick";
  }
  if (atMostThreshold(effectiveBuilds, SIGNATURE_MAX_EFFECTIVE_BUILDS)) {
    return "signature";
  }
  if (atMostThreshold(effectiveBuilds, GRINDER_MAX_EFFECTIVE_BUILDS)) {
    return "grinder";
  }
  if (!atLeastThreshold(effectiveBuilds, CREATIVE_MIN_EFFECTIVE_BUILDS)) {
    return "adaptive";
  }
  return "creative";
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
  const summary = durationDistributionSummary(durations, value);
  if (sampleSize < MIN_DURATION_SAMPLE) {
    return {
      position: null,
      value,
      category: null,
      categoryLabel: null,
      sampleSize,
      summary,
    };
  }
  const category = paceCategory(
    /** @type {number} */ (rawValue),
    summary,
    sampleSize,
  );
  return {
    position: linearPosition(
      /** @type {number} */ (rawValue),
      FIVE_MIN_SEC,
      FIFTEEN_MIN_SEC,
    ),
    value,
    category,
    categoryLabel: TRAIT_LABELS[category],
    sampleSize,
    summary,
  };
}

/**
 * Distribution signatures take precedence over the fallback mean. That keeps
 * an unmistakable two-tail or 80%-dominant pattern from being averaged into a
 * generic middle label.
 *
 * @param {number} averageSec
 * @param {ReturnType<typeof durationDistributionSummary>} summary
 * @param {number} sampleSize
 */
function paceCategory(averageSec, summary, sampleSize) {
  const belowFiveGames = summary.belowFive.games;
  const fiveToSevenGames = summary.fiveToSeven.games;
  const aboveSevenGames = summary.aboveSeven.games;
  const aboveFifteenGames = summary.aboveFifteen.games;
  if (
    meetsPercentGate(belowFiveGames, sampleSize, TWO_SPEED_MIN_PERCENT) &&
    meetsPercentGate(aboveFifteenGames, sampleSize, TWO_SPEED_MIN_PERCENT)
  ) return "two_speed";
  if (
    meetsPercentGate(
      aboveFifteenGames,
      sampleSize,
      DOMINANT_TIMEFRAME_MIN_PERCENT,
    )
  ) return "late_game_master";
  if (
    meetsPercentGate(
      aboveSevenGames,
      sampleSize,
      DOMINANT_TIMEFRAME_MIN_PERCENT,
    )
  ) return "mid_late_master";
  if (
    meetsPercentGate(
      fiveToSevenGames,
      sampleSize,
      DOMINANT_TIMEFRAME_MIN_PERCENT,
    )
  ) return "timing_attacker";
  if (averageSec < FIVE_MIN_SEC) return "cheeser";
  if (averageSec > FIFTEEN_MIN_SEC) return "late_game";
  return "flexible";
}

/**
 * The larger adjacent gap chooses the strength or hurdle direction. A tie
 * deterministically favors the strength side. A dominant gap of at least 10
 * reaches an endpoint; otherwise a total spread within 5 is universalist and
 * the remaining shapes are moderate Matchup Edge / Matchup Hurdle profiles.
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
      signedEdge: null,
      tierScore: null,
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

  const strengthDirection = !meaningfullyGreater(rawWeakGap, rawLeaderGap);
  const dominantGap = strengthDirection ? rawLeaderGap : rawWeakGap;
  let category;
  if (
    strengthDirection &&
    atLeastThreshold(dominantGap, SPECIALIST_MIN_LEAD)
  ) category = "specialist";
  else if (
    !strengthDirection &&
    atLeastThreshold(dominantGap, BLIND_SPOT_MIN_GAP)
  ) category = "blind_spot";
  else if (atMostThreshold(rawSpread, BALANCED_MAX_SPREAD)) {
    category = "universalist";
  }
  else category = strengthDirection ? "matchup_edge" : "matchup_hurdle";

  const position = matchupPosition(category, dominantGap);
  const rawSignedEdge = strengthDirection ? dominantGap : -dominantGap;
  const tierScore = {
    specialist: 2,
    matchup_edge: 1,
    universalist: 0,
    matchup_hurdle: -1,
    blind_spot: -2,
  }[category];

  return {
    position,
    value: round3(rawSpread),
    category,
    leaderGap: round3(rawLeaderGap),
    weakGap: round3(rawWeakGap),
    signedEdge: round3(rawSignedEdge),
    tierScore,
    strongestMatchup: best.matchup.matchup,
    weakestMatchup: worst.matchup.matchup,
  };
}

/**
 * Five named matchup tiers share one continuous track. Moderate profiles move
 * from center toward their endpoint as the dominant adjacent gap travels from
 * 5 to 10 percentage points. The 7.5-point midpoint therefore lands at 25
 * (edge) or 75 (hurdle). Endpoints remain reserved for raw 10+ point gaps,
 * while 50 remains reserved for universalists.
 *
 * @param {string} category
 * @param {number} dominantGap
 */
function matchupPosition(category, dominantGap) {
  if (category === "specialist") return 0;
  if (category === "blind_spot") return 100;
  if (category === "universalist") return 50;
  const fraction = Math.max(
    0,
    Math.min(
      1,
      (dominantGap - BALANCED_MAX_SPREAD) /
        (2 * (MODERATE_MATCHUP_ANCHOR - BALANCED_MAX_SPREAD)),
    ),
  );
  const offset = Math.max(1, Math.min(49, Math.round(50 * fraction)));
  return category === "matchup_edge" ? 50 - offset : 50 + offset;
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

/** Build the complete 5 repertoire × 7 pace × 5 matchup name catalog. */
function buildArchetypeNames() {
  const names = /** @type {Record<string, string>} */ ({});
  for (const [repertoire, paceNames] of Object.entries(ARCHETYPE_CORE_NAMES)) {
    for (const [pace, coreName] of Object.entries(paceNames)) {
      for (const [matchup, prefix] of Object.entries(
        MATCHUP_ARCHETYPE_PREFIXES,
      )) {
        names[`${repertoire}|${pace}|${matchup}`] = `${prefix} ${coreName}`;
      }
    }
  }
  return names;
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

/**
 * Inverse Simpson diversity: one divided by the sum of squared build shares.
 * It is the number of equally frequent builds that would produce the observed
 * concentration. One-off labels therefore contribute without carrying the
 * same weight as a build the player repeats often.
 *
 * @param {Array<{games:number}>} builds
 * @param {number} sampleSize
 */
function inverseSimpsonEffectiveCount(builds, sampleSize) {
  if (!Number.isFinite(sampleSize) || sampleSize <= 0) return 0;
  const squaredShares = builds.reduce((sum, build) => {
    const share = build.games / sampleSize;
    return sum + share * share;
  }, 0);
  return squaredShares > 0 ? 1 / squaredShares : 0;
}

/** @param {number} games @param {number} total */
function durationBucket(games, total) {
  return {
    games,
    percent: total > 0 ? round2((100 * games) / total) : null,
  };
}

/**
 * @param {number[]} durations
 * @param {number|null} averageSec
 */
function durationDistributionSummary(durations, averageSec) {
  const total = durations.length;
  const belowFiveGames = durations.filter((value) => value < FIVE_MIN_SEC).length;
  const fiveToSevenGames = durations.filter(
    (value) => value >= FIVE_MIN_SEC && value <= SEVEN_MIN_SEC,
  ).length;
  const aboveSevenGames = durations.filter((value) => value > SEVEN_MIN_SEC).length;
  const sevenToFifteenGames = durations.filter(
    (value) => value > SEVEN_MIN_SEC && value <= FIFTEEN_MIN_SEC,
  ).length;
  const aboveFifteenGames = durations.filter(
    (value) => value > FIFTEEN_MIN_SEC,
  ).length;
  return {
    averageSec,
    medianSec: total > 0 ? round2(median(durations)) : null,
    belowFive: durationBucket(belowFiveGames, total),
    fiveToSeven: durationBucket(fiveToSevenGames, total),
    aboveSeven: durationBucket(aboveSevenGames, total),
    sevenToFifteen: durationBucket(sevenToFifteenGames, total),
    aboveFifteen: durationBucket(aboveFifteenGames, total),
  };
}

/**
 * Use integer cross-products so exact 25% / 80% gates never round across.
 * @param {number} games
 * @param {number} total
 * @param {number} minimumPercent
 */
function meetsPercentGate(games, total, minimumPercent) {
  return total > 0 && games * 100 >= total * minimumPercent;
}

/** @param {number} value @param {number} low @param {number} high */
function linearPosition(value, low, high) {
  if (!Number.isFinite(value) || high <= low) return 0;
  if (atMostThreshold(value, low)) return 0;
  if (atLeastThreshold(value, high)) return 100;
  return Math.max(
    1,
    Math.min(99, Math.round((100 * (value - low)) / (high - low))),
  );
}

/** @param {number[]} values */
function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** @param {number[]} values */
function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

/** @param {number} value */
function round2(value) {
  return Math.round(value * 100) / 100;
}

/** @param {number} value */
function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/** @param {number} value */
function round6(value) {
  return Math.round(value * 1000000) / 1000000;
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
  repertoireCategory,
  paceAxis,
  matchupBalanceAxis,
  ARCHETYPE_NAMES,
  ARCHETYPE_CORE_NAMES,
  MATCHUP_ARCHETYPE_PREFIXES,
  TRAIT_LABELS,
  WINDOW_GAMES,
  MIN_GAMES,
  MIN_BUILD_SAMPLE,
  MIN_DURATION_SAMPLE,
  MIN_MATCHUP_GAMES,
  ONE_TRICK_MAX_EFFECTIVE_BUILDS,
  SIGNATURE_MAX_EFFECTIVE_BUILDS,
  GRINDER_MAX_EFFECTIVE_BUILDS,
  CREATIVE_MIN_EFFECTIVE_BUILDS,
  MIN_VALID_DURATION_SEC,
  FIVE_MIN_SEC,
  SEVEN_MIN_SEC,
  FIFTEEN_MIN_SEC,
  TWO_SPEED_MIN_PERCENT,
  DOMINANT_TIMEFRAME_MIN_PERCENT,
  BALANCED_MAX_SPREAD,
  MODERATE_MATCHUP_ANCHOR,
  SPECIALIST_MIN_LEAD,
  BLIND_SPOT_MIN_GAP,
};
