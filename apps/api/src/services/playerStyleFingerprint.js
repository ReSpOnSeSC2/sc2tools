"use strict";

/**
 * Replay-derived playstyle fingerprint.
 *
 * Three tendencies, not grades or percentiles:
 *   Build repertoire  — how many distinct plans you actually lean on
 *   Game length       — where your games get decided
 *   Matchup edge      — this matchup against your own other two
 *
 * Only slim `games` fields are read. Missing evidence stays missing; no
 * benchmark, estimate, or mock value is substituted.
 *
 * The replay window honours the analyzer's global filter bar through the same
 * `gamesMatchStage` every other analytics service uses — see
 * {@link fingerprintFilters} for the filters that are deliberately overridden
 * or dropped on the way in.
 *
 * Two measurement choices are load-bearing and easy to undo by accident:
 *
 *  - Repertoire bands read Shannon perplexity, `exp(-sum(p * ln(p)))`, not the
 *    raw distinct count. Rare one-offs still count, but repeated plans carry
 *    the weight that determines the effective-build tier.
 *  - Pace checks distribution signatures before falling back to the mean. A
 *    player with substantial sub-five and post-fifteen-minute tails must not
 *    be averaged into the generic Flexible Pacer label.
 *
 * `axis.value` is a stable public contract: repertoire reports a raw build
 * count and pace reports a duration in seconds, because `tickerFacts` renders
 * both positionally into the overlay ticker. Everything derived lives under
 * `axis.detail`.
 */

const { gamesMatchStage } = require("../util/parseQuery");

const WINDOW_GAMES = 50;
/**
 * Row cap used when the caller supplied a date range. The flat 50-game
 * window is a "latest N" heuristic; once a range is explicit, "last 90 days"
 * and "all time" must not collapse to the same 50 rows. 500 rows x 3 matchups
 * x 5 slim fields stays far under the 2,000-row list reads in games.js.
 */
const RANGE_ROW_CAP = 500;
const MIN_BUILD_SAMPLE = 10;
const MIN_DURATION_SAMPLE = 10;
/**
 * Decided games needed per matchup before the matchup track rates. Ten in
 * every matchup meant a narrow date range essentially never qualified once
 * filters started applying; eight is still a defensible floor.
 */
const MIN_MATCHUP_GAMES = 8;

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
/** Below this on every axis, no trait is worth naming a player after. */
const NEUTRAL_MAX_DISTINCTIVENESS = 0.15;
const THRESHOLD_EPSILON = 1e-9;

const RACE_LETTERS = Object.freeze(["P", "T", "Z"]);

/**
 * Per-category vocabulary. `noun` supplies the core of a composed archetype
 * name, `adjective` the modifier. The two pools are disjoint by construction —
 * asserted in tests — so "Creative Creative" cannot be generated.
 *
 * This replaces a hand-authored lookup table. Five repertoire bands by seven
 * pace profiles by five matchup tiers would otherwise require 175 names;
 * composition stays compact and lets the response own the vocabulary.
 */
const AXIS_VOCABULARY = Object.freeze({
  repertoire: Object.freeze({
    one_trick: {
      label: "Build-Order One-Trick",
      noun: "Purist",
      adjective: "Devoted",
      blurb:
        "Your build mix has the Shannon diversity of 1.5 or fewer equally used builds, showing a deeply rehearsed primary plan.",
      thresholdText: "1.5 or fewer effective builds",
    },
    signature: {
      label: "Signature Pilot",
      noun: "Pilot",
      adjective: "Signature",
      blurb:
        "You center your games on a small signature pool while retaining a real alternate plan.",
      thresholdText: "more than 1.5, up to 2.5 effective builds",
    },
    grinder: {
      label: "Consistent Grinder",
      noun: "Grinder",
      adjective: "Disciplined",
      blurb:
        "You repeat a dependable core of builds and sharpen their branches through regular use.",
      thresholdText: "more than 2.5, up to 5 effective builds",
    },
    adaptive: {
      label: "Adaptive Strategist",
      noun: "Strategist",
      adjective: "Adaptive",
      blurb:
        "You maintain a broad working repertoire without changing plans merely for novelty.",
      thresholdText: "more than 5, fewer than 10 effective builds",
    },
    creative: {
      label: "Creative Genius",
      noun: "Inventor",
      adjective: "Creative",
      blurb:
        "Your games carry the diversity of at least ten equally used builds, making variety a defining weapon.",
      thresholdText: "10 or more effective builds",
    },
  }),
  pace: Object.freeze({
    cheeser: {
      label: "Cheeser",
      noun: "Ambusher",
      adjective: "All-In",
      blurb:
        "After the stronger distribution signatures are checked, your average game still ends before 5:00.",
      thresholdText: "average under 5:00",
    },
    timing_attacker: {
      label: "Timing Attacker",
      noun: "Striker",
      adjective: "Clockwork",
      blurb:
        "At least 80% of your games end from 5:00 through 7:00, revealing a concentrated timing window.",
      thresholdText: "80%+ of games from 5:00 through 7:00",
    },
    flexible: {
      label: "Flexible Pacer",
      noun: "Operator",
      adjective: "Flexible",
      blurb:
        "No stronger timing signature dominates, and your average sits inclusively from 5:00 through 15:00.",
      thresholdText: "average from 5:00 through 15:00",
    },
    mid_late_master: {
      label: "Mid/Late-Game Master",
      noun: "Navigator",
      adjective: "Transitional",
      blurb:
        "At least 80% of your games last beyond 7:00, showing repeatable comfort through the mid game and later transitions.",
      thresholdText: "80%+ of games over 7:00",
    },
    late_game: {
      label: "Long-Game Lean",
      noun: "Endurer",
      adjective: "Long-Game",
      blurb:
        "Your average runs beyond 15:00, but the 80% mastery signatures did not fire, so this is a lean rather than a mastery claim.",
      thresholdText: "average over 15:00",
    },
    late_game_master: {
      label: "Late-Game Master",
      noun: "Commander",
      adjective: "Endgame",
      blurb:
        "At least 80% of your games individually last beyond 15:00, making deep late-game play a repeatable pattern.",
      thresholdText: "80%+ of games over 15:00",
    },
    two_speed: {
      label: "Two-Speed Player",
      noun: "Switchblade",
      adjective: "Two-Speed",
      blurb:
        "At least a quarter of your games end before 5:00 and another quarter last beyond 15:00, exposing two distinct tempo gears.",
      thresholdText: "25%+ under 5:00 and 25%+ over 15:00",
    },
  }),
  matchup_edge: Object.freeze({
    specialist: {
      label: "Matchup Specialist",
      noun: "Ace",
      adjective: "Dominant",
      blurb:
        "This selected matchup wins at least 10 percentage points more often than your qualifying comparison matchups.",
      thresholdText: "10+ point selected-matchup advantage",
      score: 2,
      trackPosition: 0,
    },
    matchup_edge: {
      label: "Matchup Edge",
      noun: "Hunter",
      adjective: "Favored",
      blurb:
        "This selected matchup is on the strength side without reaching the 10-point specialist endpoint; 7.5 points is its scoring anchor.",
      thresholdText: "strength-side result below the 10-point endpoint",
      score: 1,
      trackPosition: 25,
    },
    universalist: {
      label: "Matchup Universalist",
      noun: "Universalist",
      adjective: "Even-Handed",
      blurb:
        "All three qualifying matchup win rates are within 5 percentage points, so no selected matchup is singled out.",
      thresholdText: "all three matchup rates within 5 points",
      score: 0,
      trackPosition: 50,
    },
    matchup_hurdle: {
      label: "Matchup Hurdle",
      noun: "Climber",
      adjective: "Battle-Tested",
      blurb:
        "This selected matchup is on the weakness side without reaching the 10-point blind-spot endpoint; 7.5 points is its scoring anchor.",
      thresholdText: "weakness-side result below the 10-point endpoint",
      score: -1,
      trackPosition: 75,
    },
    blind_spot: {
      label: "Matchup Blind Spot",
      noun: "Underdog",
      adjective: "Fault-Line",
      blurb:
        "This selected matchup wins at least 10 percentage points less often than your qualifying comparison matchups.",
      thresholdText: "10+ point selected-matchup deficit",
      score: -2,
      trackPosition: 100,
    },
  }),
});

/** Axis order, also the deterministic tie-break for equal distinctiveness. */
const AXIS_ORDER = Object.freeze(["repertoire", "pace", "matchup_edge"]);

const AXIS_META = Object.freeze({
  repertoire: {
    label: "Build variety",
    description:
      "Shannon effective diversity weights every recognized build by how often you actually use it.",
    leftLabel: "Build-Order One-Trick",
    centerLabel: "Consistent Grinder",
    rightLabel: "Creative Genius",
  },
  pace: {
    label: "Game length",
    description: "Whether your games end early, in the mid game, or late — and whether you do both.",
    leftLabel: "Cheeser",
    centerLabel: "Flexible Pacer",
    rightLabel: "Late-Game Master",
  },
  matchup_edge: {
    label: "Matchup edge",
    description:
      "This matchup's win rate against the average of your other two. Unlike the other tracks, this one is about results, not style.",
    leftLabel: "Matchup Specialist",
    centerLabel: "Matchup Universalist",
    rightLabel: "Matchup Blind Spot",
  },
});

/**
 * Hand-authored names worth keeping, consulted before composition. Keys are
 * the full ordered tuple `repertoire|pace|matchup_edge`. Every key must resolve
 * to a reachable combination — asserted in tests, so a typo cannot sit here
 * silently never firing.
 */
const ARCHETYPE_OVERRIDES = Object.freeze({
  "one_trick|cheeser|specialist": "Precision Ambusher",
  "one_trick|flexible|specialist": "Matchup Technician",
  "one_trick|late_game_master|specialist": "Fortress Specialist",
  "signature|flexible|universalist": "Reliable All-Rounder",
  "grinder|late_game_master|universalist": "Macro Machine",
  "adaptive|two_speed|matchup_edge": "Tempo Trickster",
  "adaptive|flexible|matchup_hurdle": "Strategic Soft Spot",
  "creative|cheeser|universalist": "Chaos Architect",
  "creative|timing_attacker|specialist": "Matchup Inventor",
  "creative|late_game_master|universalist": "Strategic Polymath",
});

/** Name used when no axis is distinctive enough to name a player after. */
const NEUTRAL_ARCHETYPE_NAME = "Balanced All-Rounder";

/** Flat category -> display label map, kept for `axis.categoryLabel`. */
const TRAIT_LABELS = Object.freeze(
  Object.fromEntries(
    Object.values(AXIS_VOCABULARY).flatMap((categories) =>
      Object.entries(categories).map(([key, entry]) => [key, entry.label]),
    ),
  ),
);

/**
 * Global filters that must not reach the fingerprint's replay window, with the
 * wire name used to explain the omission to the client.
 *
 * ``build`` would make the repertoire axis tautological — every row would
 * carry the one selected build, so the player is always a one-trick. The MMR,
 * opponent-strategy, leak and macro-score filters all select a slice of
 * *opponents* or of *individual games*, which biases every win-rate-derived
 * measure and would make a macro axis circular with its own filter.
 */
const STRIPPED_FILTER_KEYS = Object.freeze([
  "build",
  "mmrMin",
  "mmrMax",
  "oppStrategy",
  "leak",
  "macroMin",
  "macroMax",
  "groupByRacePlayed",
]);

const STRIPPED_FILTER_LABELS = Object.freeze({
  build: "build",
  mmrMin: "mmr_min",
  mmrMax: "mmr_max",
  oppStrategy: "opp_strategy",
  leak: "leak",
  macroMin: "macro_min",
  macroMax: "macro_max",
  groupByRacePlayed: "group_by_race_played",
});

/**
 * Narrow a parsed global filter object down to the subset the fingerprint can
 * honour, and force the parts it owns.
 *
 * Kept: ``since`` / ``until`` (the point of the exercise), plus ``map``,
 * ``mapPool``, ``regions`` and ``excludeTooShort`` — all real cohort choices
 * that do not redefine any axis. ``excludeTooShort`` in particular finally
 * agrees with {@link validBuildName}, which has always dropped "Game Too
 * Short" builds locally.
 *
 * Forced: ``race`` / ``oppRace`` come from the card's own matchup picker,
 * which is authoritative over the global race filters, and ``gameSize`` is
 * pinned to 1v1 because the fingerprint is only defined there.
 *
 * @param {Record<string, any> | null | undefined} filters Parsed by `parseFilters`.
 * @param {string} matchup Canonical matchup, e.g. "PvZ".
 * @returns {{filters: Record<string, any>, strippedFilters: string[]}}
 */
function fingerprintFilters(filters, matchup) {
  const source = filters && typeof filters === "object" ? filters : {};
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue;
    if (STRIPPED_FILTER_KEYS.includes(key)) continue;
    out[key] = value;
  }
  const labels = /** @type {Record<string, string>} */ (STRIPPED_FILTER_LABELS);
  const strippedFilters = STRIPPED_FILTER_KEYS.filter(
    (key) => source[key] !== undefined && source[key] !== null,
  ).map((key) => labels[key]);

  // Report an overridden race filter too — a user who set race=Z globally and
  // is looking at PvZ deserves to know why the card ignored half of it.
  if (source.race && source.race !== matchup[0]) strippedFilters.push("race");
  if (source.oppRace && source.oppRace !== matchup[2]) {
    strippedFilters.push("opp_race");
  }

  out.race = matchup[0];
  out.oppRace = matchup[2];
  out.gameSize = "1v1";
  return { filters: out, strippedFilters };
}

/** @param {Record<string, any> | null | undefined} filters */
function hasDateRange(filters) {
  return Boolean(filters && (filters.since || filters.until));
}

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
   * Repertoire and pace use the selected matchup. The matchup-edge axis
   * compares it against independent windows for the same race's other two
   * matchups, which is what makes the archetype differ between PvT, PvP and
   * PvZ — the race-wide balance shape it replaced was identical for all three
   * by construction.
   *
   * Returns `null` only when the cohort is empty — a thin cohort still yields
   * a 200 with per-axis nulls and a `reason`, because a partial profile plus
   * "3 of 10 replays" is a far better answer than a dead-end 404.
   *
   * @param {string} userId
   * @param {{ matchup?: string, filters?: Record<string, any> | null }} [args]
   * @returns {Promise<Record<string, any> | null>}
   */
  async compute(userId, { matchup, filters } = {}) {
    if (typeof userId !== "string" || !userId) return null;
    const mu = normalizeMatchup(matchup);
    if (!mu) return null;

    const { strippedFilters } = fingerprintFilters(filters, mu);
    // An explicit date range replaces "latest N" as the window definition, so
    // the cap has to rise or "last 90 days" and "all time" return the same 50
    // rows for an active player — the original bug, reported a second time.
    const ranged = hasDateRange(filters);
    const windowMode = ranged ? "range" : "recent";
    const rowCap = ranged ? RANGE_ROW_CAP : WINDOW_GAMES;

    const selectedRows = await loadWindow(this.games, userId, mu, filters, rowCap);
    if (selectedRows.length === 0) return null;

    const windows = await Promise.all(
      RACE_LETTERS.map((opponentRace) => {
        const candidate = `${mu[0]}v${opponentRace}`;
        return candidate === mu
          ? Promise.resolve(selectedRows)
          : loadWindow(this.games, userId, candidate, filters, rowCap);
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
    // Race-wide shape is retained purely as evidence: it populates the three
    // win-rate cards and `matchupSummary`, which tickerFacts reads directly.
    const balance = matchupBalanceAxis(mu[0], rowsByMatchup);
    const edge = matchupEdgeAxis(mu, balance.matchups);

    const axes = [
      publicAxis("repertoire", AXIS_META.repertoire.label, repertoire),
      publicAxis("pace", AXIS_META.pace.label, pace),
      publicAxis("matchup_edge", AXIS_META.matchup_edge.label, edge),
    ];
    const archetype = deriveArchetype([
      { key: "repertoire", ...repertoire },
      { key: "pace", ...pace },
      { key: "matchup_edge", ...edge },
    ]);

    const ratedAxes = axes.filter((axis) => axis.category).length;
    const status = archetype.complete
      ? "complete"
      : ratedAxes > 0
        ? "partial"
        : "insufficient";

    return {
      matchup: mu,
      race: mu[0],
      games: selectedRows.length,
      windowGames: rowCap,
      windowMode,
      windowTruncated: windows.some((rows) => rows.length >= rowCap),
      strippedFilters,
      status,
      axes,
      playstyle: archetype.name,
      archetype,
      taxonomy: buildTaxonomy(),
      buildOrders: repertoire.builds,
      repertoireSummary: repertoire.summary,
      paceSummary: pace.summary,
      matchupWinRates: balance.matchups,
      matchupSummary: {
        spread: balance.value,
        leaderGap: balance.leaderGap,
        weakGap: balance.weakGap,
        selectedMatchup: mu,
        selectedWinRate: edge.detail?.winRate ?? null,
        comparatorWinRate: edge.detail?.comparatorWinRate ?? null,
        comparedAgainst: edge.detail?.comparedAgainst ?? [],
        signedEdge: edge.detail?.signedEdge ?? null,
        tierScore: edge.detail?.tierScore ?? null,
        strongestMatchup: balance.strongestMatchup,
        weakestMatchup: balance.weakestMatchup,
      },
    };
  }
}

/**
 * The full trait taxonomy, shipped inside every response.
 *
 * Embedding it rather than serving it from `/v1/definitions` keeps the payload
 * self-describing: a separately cached taxonomy can go stale against the
 * categories in the same response, and the drift is invisible. This is what
 * lets the web app hold zero thresholds and zero archetype names.
 */
function buildTaxonomy() {
  return {
    axes: AXIS_ORDER.map((axisKey) => {
      const meta = /** @type {Record<string, any>} */ (AXIS_META)[axisKey];
      const categories = /** @type {Record<string, any>} */ (AXIS_VOCABULARY)[
        axisKey
      ];
      return {
        key: axisKey,
        ...meta,
        categories: Object.entries(categories).map(([key, entry]) => ({
          key,
          label: entry.label,
          noun: entry.noun,
          adjective: entry.adjective,
          blurb: entry.blurb,
          thresholdText: entry.thresholdText,
          ...(typeof entry.score === "number" ? { score: entry.score } : {}),
          ...(typeof entry.trackPosition === "number"
            ? { trackPosition: entry.trackPosition }
            : {}),
        })),
      };
    }),
  };
}

/**
 * Serialise one axis. `reason` / `have` / `needed` travel with an unrated axis
 * so the client can explain the gap without duplicating a threshold across the
 * boundary — the old client-side "We need 10 recent replays" copy drifted the
 * moment any minimum moved.
 *
 * @param {string} key
 * @param {string} label
 * @param {Record<string, any>} result
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
    detail: result.detail || null,
    reason: result.category ? null : result.reason || null,
    have: result.category ? null : result.sampleSize,
    needed: result.category ? null : (result.needed ?? null),
  };
}

/**
 * Build variety, measured as the perplexity of the build distribution:
 * `N_eff = exp(H)` over build shares. A uniform k-build player scores exactly
 * k; concentration pulls the score down toward 1 no matter how long the tail
 * of one-off builds is.
 *
 * `value` stays the raw distinct count — tickerFacts renders it as
 * "{n} PvZ build orders" and the card as "{n} builds".
 *
 * @param {Array<Record<string, any>>} rows
 */
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
  const rawEffectiveBuilds = perplexity(builds.map((item) => item.games));
  // Six decimals keep displayed evidence on the same side of every category
  // boundary while still avoiding a noisy floating-point payload.
  const effectiveBuilds = round6(rawEffectiveBuilds);
  const summary = {
    method: "shannon_perplexity",
    formula: "exp(-sum(p_i * ln(p_i)))",
    distinctBuilds,
    effectiveBuilds,
    topBuildShare:
      sampleSize > 0 && builds.length > 0
        ? round3(builds[0].games / sampleSize)
        : null,
  };
  if (sampleSize < MIN_BUILD_SAMPLE || distinctBuilds === 0) {
    return {
      position: null,
      value: distinctBuilds,
      category: null,
      categoryLabel: null,
      sampleSize,
      reason: "needs_more_classified_builds",
      needed: MIN_BUILD_SAMPLE,
      detail: summary,
      builds,
      summary,
    };
  }
  const category = repertoireCategory(rawEffectiveBuilds);
  return {
    // Log scale: 1 -> 2 effective builds is a much larger playstyle change
    // than 8 -> 9, so a linear track would bury the focused tiers near zero.
    position: linearPosition(
      Math.log(rawEffectiveBuilds),
      Math.log(ONE_TRICK_MAX_EFFECTIVE_BUILDS),
      Math.log(CREATIVE_MIN_EFFECTIVE_BUILDS),
    ),
    value: distinctBuilds,
    category,
    categoryLabel: TRAIT_LABELS[category],
    sampleSize,
    detail: summary,
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

/**
 * Game length uses distribution signatures first and a raw-mean fallback.
 * `value` remains the mean duration in seconds for tickerFacts; the complete
 * bucket distribution and median travel in `detail` / `paceSummary`.
 *
 * @param {Array<Record<string, any>>} rows
 */
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
  const rawAverage = sampleSize ? mean(durations) : null;
  const value = rawAverage === null ? null : round2(rawAverage);
  const summary = durationDistributionSummary(durations, value);
  if (sampleSize < MIN_DURATION_SAMPLE) {
    return {
      position: null,
      value,
      category: null,
      categoryLabel: null,
      sampleSize,
      reason: "needs_more_timed_games",
      needed: MIN_DURATION_SAMPLE,
      detail: summary,
      summary,
    };
  }
  const category = paceCategory(
    /** @type {number} */ (rawAverage),
    summary,
    sampleSize,
  );
  return {
    position: linearPosition(
      /** @type {number} */ (rawAverage),
      FIVE_MIN_SEC,
      FIFTEEN_MIN_SEC,
    ),
    value,
    category,
    categoryLabel: TRAIT_LABELS[category],
    sampleSize,
    detail: summary,
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
 * Classify the selected matchup against the unweighted mean of whichever
 * other matchup windows meet the eight-decided-game comparator floor.
 *
 * Universalist is deliberately stricter than "delta near zero": all three
 * matchups must qualify and their total range must be at most five points. A
 * middle-ranked selected matchup in a wide 60/50/40 shape is therefore an
 * Edge (the deterministic zero-delta tie direction), not a Universalist.
 *
 * @param {string} matchup Selected matchup, e.g. "PvZ".
 * @param {Array<{matchup:string,wins:number,decidedGames:number}>} matchups
 */
function matchupEdgeAxis(matchup, matchups) {
  const rows = Array.isArray(matchups) ? matchups : [];
  const selected = rows.find((row) => row.matchup === matchup);
  const selectedDecided = selected ? selected.decidedGames : 0;
  if (!selected || selectedDecided < MIN_MATCHUP_GAMES) {
    return {
      position: null,
      value: null,
      category: null,
      categoryLabel: null,
      sampleSize: selectedDecided,
      reason: "needs_more_decided_games",
      needed: MIN_MATCHUP_GAMES,
    };
  }

  const comparators = rows.filter(
    (row) => row.matchup !== matchup && row.decidedGames >= MIN_MATCHUP_GAMES,
  );
  if (comparators.length === 0) {
    return {
      position: null,
      value: null,
      category: null,
      categoryLabel: null,
      sampleSize: selectedDecided,
      reason: "no_comparison_matchup",
      needed: MIN_MATCHUP_GAMES,
    };
  }

  const selectedRate = (100 * selected.wins) / selected.decidedGames;
  const comparatorRate =
    comparators.reduce(
      (sum, row) => sum + (100 * row.wins) / row.decidedGames,
      0,
    ) / comparators.length;
  const delta = selectedRate - comparatorRate;

  const qualified = rows.filter(
    (row) => row.decidedGames >= MIN_MATCHUP_GAMES,
  );
  const allMatchupSpread = qualified.length === RACE_LETTERS.length
    ? Math.max(
        ...qualified.map((row) => (100 * row.wins) / row.decidedGames),
      ) -
      Math.min(
        ...qualified.map((row) => (100 * row.wins) / row.decidedGames),
      )
    : null;

  let category;
  if (
    allMatchupSpread !== null &&
    atMostThreshold(allMatchupSpread, BALANCED_MAX_SPREAD)
  ) category = "universalist";
  else if (atLeastThreshold(delta, SPECIALIST_MIN_LEAD)) {
    category = "specialist";
  }
  else if (delta <= -BLIND_SPOT_MIN_GAP + THRESHOLD_EPSILON) {
    category = "blind_spot";
  }
  else category = delta >= -THRESHOLD_EPSILON
    ? "matchup_edge"
    : "matchup_hurdle";

  const tierScore = {
    specialist: 2,
    matchup_edge: 1,
    universalist: 0,
    matchup_hurdle: -1,
    blind_spot: -2,
  }[category];

  return {
    position: matchupPosition(category, Math.abs(delta)),
    value: round3(delta),
    category,
    categoryLabel: TRAIT_LABELS[category],
    sampleSize: selectedDecided,
    detail: {
      winRate: round3(selectedRate),
      comparatorWinRate: round3(comparatorRate),
      comparedAgainst: comparators.map((row) => row.matchup),
      signedEdge: round3(delta),
      tierScore,
      allMatchupSpread:
        allMatchupSpread === null ? null : round3(allMatchupSpread),
    },
  };
}

/**
 * Race-wide win-rate shape across all three matchups. Retained strictly as
 * evidence for the matchup cards and ticker; it does not choose the selected
 * matchup category or the archetype.
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
      reason: "needs_more_decided_games",
      needed: MIN_MATCHUP_GAMES,
      matchups,
      leaderGap: null,
      weakGap: null,
      strongestMatchup: null,
      weakestMatchup: null,
    };
  }

  const ranked = matchups
    .map((entry) => ({
      matchup: entry,
      rawWinRate: (100 * entry.wins) / entry.decidedGames,
    }))
    .sort((a, b) => b.rawWinRate - a.rawWinRate);
  const [best, middle, worst] = ranked;

  return {
    position: null,
    value: round3(best.rawWinRate - worst.rawWinRate),
    category: null,
    categoryLabel: null,
    sampleSize,
    matchups,
    leaderGap: round3(best.rawWinRate - middle.rawWinRate),
    weakGap: round3(middle.rawWinRate - worst.rawWinRate),
    strongestMatchup: best.matchup.matchup,
    weakestMatchup: worst.matchup.matchup,
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
 * Five named matchup tiers share one continuous track. Moderate profiles move
 * from center toward their endpoint as the absolute selected-vs-comparator
 * delta travels from 5 to 10 percentage points. The 7.5-point midpoint lands
 * at 25 (edge) or 75 (hurdle). Endpoints remain reserved for raw 10+ point
 * gaps, while 50 remains reserved for universalists.
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

/**
 * How far from unremarkable an axis sits, on 0..1. Drives which two traits get
 * to name the player, so the name describes what is *unusual* about them —
 * that is what stops the modal player from being handed the modal name.
 *
 * Not simply `|position - 50|`: `two_speed` sits at the centre of the pace
 * track by construction and would otherwise score zero despite being one of
 * the most distinctive timing patterns.
 *
 * @param {string} axisKey
 * @param {Record<string, any>} result
 */
function axisDistinctiveness(axisKey, result) {
  if (!result || !result.category || typeof result.position !== "number") {
    return 0;
  }
  if (axisKey === "pace" && result.category === "two_speed") {
    const detail = result.detail || {};
    const earlyShare = (detail.belowFive?.percent ?? 0) / 100;
    const lateShare = (detail.aboveFifteen?.percent ?? 0) / 100;
    const weaker = Math.min(earlyShare, lateShare);
    const threshold = TWO_SPEED_MIN_PERCENT / 100;
    return clamp01((weaker - threshold) / (0.5 - threshold));
  }
  return clamp01(Math.abs(result.position - 50) / 50);
}

/**
 * Compose the archetype from the rated axes.
 *
 * Selection, not enumeration: rank the axes by how distinctive they are, name
 * the player after the top two, and fall back to a neutral name when nothing
 * stands out. A fixed lookup table cannot do this — it maps every player onto
 * the same cell whenever their measurements are ordinary, which is how a
 * single name ended up on most profiles.
 *
 * @param {Array<Record<string, any> & {key: string}>} axisResults
 */
function deriveArchetype(axisResults) {
  const results = Array.isArray(axisResults) ? axisResults : [];
  /** @type {Map<string, Record<string, any>>} */
  const byKey = new Map(results.map((entry) => [entry.key, entry]));
  /** @type {Array<Record<string, any>>} */
  const ordered = [];
  for (const axisKey of AXIS_ORDER) {
    const entry = byKey.get(axisKey);
    if (entry) ordered.push(entry);
  }
  const rated = ordered.filter((entry) => Boolean(entry.category));
  const complete =
    ordered.length === AXIS_ORDER.length && rated.length === AXIS_ORDER.length;

  const categories = AXIS_ORDER.map(
    (axisKey) => (byKey.get(axisKey) || {}).category || "?",
  );
  const key = complete
    ? categories.join("|")
    : `partial:${categories.join("|")}`;

  if (rated.length === 0) {
    return {
      key,
      name: "Profile Still Forming",
      description:
        "More replay evidence is needed before a player archetype can be assigned.",
      complete: false,
      components: [],
    };
  }

  const ranked = rated
    .map((entry) => ({
      axis: entry.key,
      category: entry.category,
      distinctiveness: axisDistinctiveness(entry.key, entry),
      vocab: vocabularyFor(entry.key, entry.category),
    }))
    .sort(
      (a, b) =>
        b.distinctiveness - a.distinctiveness ||
        AXIS_ORDER.indexOf(a.axis) - AXIS_ORDER.indexOf(b.axis),
    );

  const overrides = /** @type {Record<string, string>} */ (ARCHETYPE_OVERRIDES);
  const neutral = ranked.every(
    (entry) => entry.distinctiveness < NEUTRAL_MAX_DISTINCTIVENESS,
  );

  let name;
  let components;
  if (complete && overrides[key]) {
    name = overrides[key];
    components = ranked.map((entry, index) => componentOf(entry, index));
  } else if (neutral) {
    name = NEUTRAL_ARCHETYPE_NAME;
    components = ranked.map((entry) => componentOf(entry, -1));
  } else {
    const core = ranked[0];
    const modifier = ranked[1];
    name = modifier
      ? `${modifier.vocab.adjective} ${core.vocab.noun}`
      : core.vocab.noun;
    components = ranked.map((entry, index) => componentOf(entry, index));
  }

  const described = neutral ? ranked : ranked.slice(0, 2);
  const description = described
    .map((entry) => entry.vocab.blurb)
    .filter(Boolean)
    .join(" ");

  return { key, name, description, complete, components };
}

/**
 * @param {{axis:string,category:string,distinctiveness:number}} entry
 * @param {number} index Rank in the distinctiveness ordering; -1 when unused.
 */
function componentOf(entry, index) {
  return {
    axis: entry.axis,
    category: entry.category,
    distinctiveness: round3(entry.distinctiveness),
    role: index === 0 ? "core" : index === 1 ? "modifier" : "supporting",
  };
}

/** @param {string} axisKey @param {string} category */
function vocabularyFor(axisKey, category) {
  const axis = /** @type {Record<string, any>} */ (AXIS_VOCABULARY)[axisKey];
  return (axis && axis[category]) || { noun: "Competitor", adjective: "Balanced", blurb: "" };
}

/**
 * Latest qualifying 1v1 rows for one matchup. The projection contains only
 * slim ingest fields, never a build log or game-details payload.
 *
 * The predicate comes from the shared `gamesMatchStage`, so the fingerprint
 * sees the same cohort as every other analyzer card. With no filters supplied
 * this reduces to exactly the hand-rolled predicate this function used before
 * the filter bar was wired in, which is the path `tickerFacts` still takes.
 *
 * Each matchup is queried separately rather than partitioning one race-wide
 * read: a single capped query would starve the rare matchup for a player who
 * is, say, 80% PvZ.
 *
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @param {string} matchup
 * @param {Record<string, any> | null | undefined} filters
 * @param {number} limit
 */
function loadWindow(games, userId, matchup, filters, limit) {
  const { filters: scoped } = fingerprintFilters(filters, matchup);
  return games
    .find(gamesMatchStage(userId, scoped), {
      projection: {
        _id: 0,
        myBuild: 1,
        durationSec: 1,
        result: 1,
        date: 1,
      },
      sort: { date: -1, _id: -1 },
      limit,
    })
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
 * Convert a real game count into an auditable count-and-percentage bucket.
 * @param {number} games @param {number} total
 */
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
  const middleGames = total - belowFiveGames - aboveFifteenGames;
  return {
    averageSec,
    meanSec: averageSec,
    medianSec: total > 0 ? round2(median(durations)) : null,
    earlyShare: total > 0 ? round3(belowFiveGames / total) : null,
    midShare: total > 0 ? round3(middleGames / total) : null,
    lateShare: total > 0 ? round3(aboveFifteenGames / total) : null,
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

/**
 * Perplexity `exp(-sum p*ln p)` of a count distribution — the "effective
 * number" of builds. Uniform over k counts returns exactly k.
 *
 * @param {number[]} counts
 */
function perplexity(counts) {
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return 0;
  let entropy = 0;
  for (const count of counts) {
    if (count <= 0) continue;
    const share = count / total;
    entropy -= share * Math.log(share);
  }
  return Math.exp(entropy);
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

/** @param {number} value */
function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

/** @param {number[]} values */
function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** @param {number[]} values */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
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
  fingerprintFilters,
  buildTaxonomy,
  repertoireAxis,
  repertoireCategory,
  paceAxis,
  paceCategory,
  matchupBalanceAxis,
  matchupEdgeAxis,
  axisDistinctiveness,
  perplexity,
  AXIS_ORDER,
  AXIS_VOCABULARY,
  ARCHETYPE_OVERRIDES,
  NEUTRAL_ARCHETYPE_NAME,
  TRAIT_LABELS,
  WINDOW_GAMES,
  RANGE_ROW_CAP,
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
  NEUTRAL_MAX_DISTINCTIVENESS,
};
