"use strict";

/**
 * Replay-derived playstyle fingerprint.
 *
 * Four tendencies, not grades or percentiles:
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
 *  - Repertoire bands read *effective* build count (the perplexity of the
 *    build distribution), not the raw distinct count. Ten builds where 88% of
 *    games are one build is a focused player, not a creative one.
 *  - Pace bands read the *distribution* of game lengths, not the mean. A
 *    player who splits their games between four-minute all-ins and twenty-
 *    minute macro games averages twelve minutes, and the mean called them
 *    "flexible" — the single least true label available.
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

const MIN_VALID_DURATION_SEC = 45;

/**
 * Effective-build-count band edges. Perplexity of a uniform k-build
 * distribution is exactly k, so these read naturally: two evenly played
 * builds is "focused", five is "wide", ten is "creative".
 */
const REPERTOIRE_BANDS = Object.freeze([
  { key: "one_trick", below: 1.6 },
  { key: "focused", below: 2.8 },
  { key: "adaptive", below: 4.5 },
  { key: "wide", below: 7.0 },
  { key: "creative", below: Infinity },
]);
const REPERTOIRE_POSITION_MIN = 1.6;
const REPERTOIRE_POSITION_MAX = 7.0;

/** Game-length bands, in seconds. */
const EARLY_MAX_SEC = 7 * 60;
const LATE_MIN_SEC = 14 * 60;
/** A player is two-speed once both tails carry this share of their games. */
const TWO_SPEED_MIN_SHARE = 0.3;
/** A single tail this large, with the opposite tail this small, is a commitment. */
const PACE_DOMINANT_SHARE = 0.45;
const PACE_TAIL_MAX_SHARE = 0.15;

/**
 * Win-rate points separating this matchup from the mean of the others before
 * it counts as an edge. At n≈50 per matchup the standard error on a win rate
 * is around 7 points, so the old 10-point rule was crossed rarely enough that
 * "on par" swallowed nearly everyone — which is the bug this axis exists to
 * fix. 7.5 with a hard 8-game floor is the pragmatic setting.
 */
const EDGE_MIN_DELTA = 7.5;

/** Below this on every axis, no trait is worth naming a player after. */
const NEUTRAL_MAX_DISTINCTIVENESS = 0.15;

const THRESHOLD_EPSILON = 1e-9;

const RACE_LETTERS = Object.freeze(["P", "T", "Z"]);

/**
 * Per-category vocabulary. `noun` supplies the core of a composed archetype
 * name, `adjective` the modifier. The two pools are disjoint by construction —
 * asserted in tests — so "Creative Creative" cannot be generated.
 *
 * This replaces a hand-authored 36-cell lookup table. At five repertoire bands
 * x four pace bands x three edge states the table would need 60 entries today
 * and 180 the moment a fourth axis lands; composition needs 24 words.
 */
const AXIS_VOCABULARY = Object.freeze({
  repertoire: Object.freeze({
    one_trick: {
      label: "One-Trick",
      noun: "Purist",
      adjective: "One-Track",
      blurb:
        "Effectively one build carries this matchup for you — you win by knowing it better than they do.",
      thresholdText: "under 1.6 effective builds",
    },
    focused: {
      label: "Focused Specialist",
      noun: "Technician",
      adjective: "Focused",
      blurb:
        "You lean on a small, sharpened set of builds and sharpen them through repetition.",
      thresholdText: "1.6 to 2.8 effective builds",
    },
    adaptive: {
      label: "Adaptive Strategist",
      noun: "Strategist",
      adjective: "Adaptive",
      blurb:
        "You keep a working handful of builds — options without reinventing your plan every game.",
      thresholdText: "2.8 to 4.5 effective builds",
    },
    wide: {
      label: "Wide Repertoire",
      noun: "Improviser",
      adjective: "Wide-Ranging",
      blurb:
        "You spread your games across a broad set of builds, so opponents rarely get the same game twice.",
      thresholdText: "4.5 to 7 effective builds",
    },
    creative: {
      label: "Creative Genius",
      noun: "Inventor",
      adjective: "Inventive",
      blurb:
        "You play an unusually wide spread of builds and regularly show opponents something new.",
      thresholdText: "7 or more effective builds",
    },
  }),
  pace: Object.freeze({
    cheeser: {
      label: "Cheeser",
      noun: "Ambusher",
      adjective: "All-In",
      blurb:
        "Most of your games are settled early — you commit before the opponent's economy comes online.",
      thresholdText: "45%+ of games under 7:00",
    },
    standard: {
      label: "Flexible Pacer",
      noun: "Operator",
      adjective: "Measured",
      blurb:
        "Your games mostly land in the mid game, mixing early pressure with transitions.",
      thresholdText: "most games between 7:00 and 14:00",
    },
    late_game: {
      label: "Late-Game Specialist",
      noun: "Marathoner",
      adjective: "Late-Game",
      blurb:
        "Your games run long — you are comfortable with maxed armies, upgrades, and remaxes.",
      thresholdText: "45%+ of games over 14:00",
    },
    two_speed: {
      label: "Two-Speed",
      noun: "Switchblade",
      adjective: "Two-Speed",
      blurb:
        "You genuinely play two games: a large share of quick all-ins and a large share of long macro games, with little in between.",
      thresholdText: "30%+ both under 7:00 and over 14:00",
    },
  }),
  matchup_edge: Object.freeze({
    edge_strong: {
      label: "Matchup Edge",
      noun: "Hunter",
      adjective: "Dominant",
      blurb:
        "You win this matchup clearly more often than your other two — it is the one you want to see.",
      thresholdText: "7.5+ points above your other matchups",
    },
    edge_on_par: {
      label: "On Par",
      noun: "All-Rounder",
      adjective: "Even-Handed",
      blurb:
        "This matchup tracks close to your other two — no clear strength or weakness here.",
      thresholdText: "within 7.5 points of your other matchups",
    },
    edge_weak: {
      label: "Matchup Gap",
      noun: "Underdog",
      adjective: "Uphill",
      blurb:
        "You win this matchup clearly less often than your other two — the cheapest points on your ladder are here.",
      thresholdText: "7.5+ points below your other matchups",
    },
  }),
});

/** Axis order, also the deterministic tie-break for equal distinctiveness. */
const AXIS_ORDER = Object.freeze(["repertoire", "pace", "matchup_edge"]);

const AXIS_META = Object.freeze({
  repertoire: {
    label: "Build variety",
    description: "How many different build orders you actually lean on in this matchup.",
    leftLabel: "One-Trick",
    centerLabel: "Adaptive Strategist",
    rightLabel: "Creative Genius",
  },
  pace: {
    label: "Game length",
    description: "Whether your games end early, in the mid game, or late — and whether you do both.",
    leftLabel: "Cheeser",
    centerLabel: "Flexible Pacer",
    rightLabel: "Late-Game Specialist",
  },
  matchup_edge: {
    label: "Matchup edge",
    description:
      "This matchup's win rate against the average of your other two. Unlike the other tracks, this one is about results, not style.",
    leftLabel: "Matchup Edge",
    centerLabel: "On Par",
    rightLabel: "Matchup Gap",
  },
});

/**
 * Hand-authored names worth keeping, consulted before composition. Keys are
 * the full ordered tuple `repertoire|pace|matchup_edge`. Every key must resolve
 * to a reachable combination — asserted in tests, so a typo cannot sit here
 * silently never firing.
 */
const ARCHETYPE_OVERRIDES = Object.freeze({
  "one_trick|cheeser|edge_strong": "Precision Ambusher",
  "one_trick|standard|edge_strong": "Matchup Technician",
  "one_trick|late_game|edge_strong": "Fortress Specialist",
  "focused|standard|edge_on_par": "Reliable All-Rounder",
  "focused|late_game|edge_on_par": "Macro Machine",
  "adaptive|two_speed|edge_strong": "Tempo Trickster",
  "adaptive|standard|edge_weak": "Strategic Soft Spot",
  "creative|cheeser|edge_on_par": "Chaos Architect",
  "creative|standard|edge_strong": "Matchup Inventor",
  "creative|late_game|edge_on_par": "Strategic Polymath",
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
  const value = builds.length;
  if (sampleSize < MIN_BUILD_SAMPLE || value === 0) {
    return {
      position: null,
      value,
      category: null,
      categoryLabel: null,
      sampleSize,
      reason: "needs_more_classified_builds",
      needed: MIN_BUILD_SAMPLE,
      builds,
    };
  }

  const effectiveBuilds = perplexity(builds.map((item) => item.games));
  const category = bandFor(REPERTOIRE_BANDS, effectiveBuilds);
  return {
    // Log scale: 1 -> 2 builds is a far larger change in how you play than
    // 8 -> 9, and a linear track buries every interesting player near zero.
    position: linearPosition(
      Math.log(effectiveBuilds),
      Math.log(REPERTOIRE_POSITION_MIN),
      Math.log(REPERTOIRE_POSITION_MAX),
    ),
    value,
    category,
    categoryLabel: TRAIT_LABELS[category],
    sampleSize,
    detail: {
      effectiveBuilds: round2(effectiveBuilds),
      distinctBuilds: value,
      topBuildShare: round3(builds[0].games / sampleSize),
    },
    builds,
  };
}

/**
 * Game length, measured as the share of games in each band rather than the
 * mean. `value` stays a duration in seconds for tickerFacts and the card, but
 * it is now the **median** — nine four-minute games and one forty-five-minute
 * game is a cheeser, and the mean called them a flexible pacer.
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
  const rawValue = sampleSize ? median(durations) : null;
  const value = rawValue === null ? null : round2(rawValue);
  if (sampleSize < MIN_DURATION_SAMPLE) {
    return {
      position: null,
      value,
      category: null,
      categoryLabel: null,
      sampleSize,
      reason: "needs_more_timed_games",
      needed: MIN_DURATION_SAMPLE,
    };
  }

  const early = durations.filter((d) => d < EARLY_MAX_SEC).length / sampleSize;
  const late = durations.filter((d) => d > LATE_MIN_SEC).length / sampleSize;
  const mid = 1 - early - late;

  // Order matters. A 45/10/45 player satisfies neither the cheeser nor the
  // late-game rule and would otherwise fall through to "standard" — exactly
  // the mislabel this axis was rewritten to remove.
  let category = "standard";
  if (early >= TWO_SPEED_MIN_SHARE && late >= TWO_SPEED_MIN_SHARE) {
    category = "two_speed";
  } else if (early >= PACE_DOMINANT_SHARE && late <= PACE_TAIL_MAX_SHARE) {
    category = "cheeser";
  } else if (late >= PACE_DOMINANT_SHARE && early <= PACE_TAIL_MAX_SHARE) {
    category = "late_game";
  }

  return {
    position: Math.max(0, Math.min(100, Math.round(50 + 50 * (late - early)))),
    value,
    category,
    categoryLabel: TRAIT_LABELS[category],
    sampleSize,
    detail: {
      earlyShare: round3(early),
      midShare: round3(mid),
      lateShare: round3(late),
      medianSec: value,
      meanSec: round2(mean(durations)),
    },
  };
}

/**
 * How this matchup compares with the player's own other two.
 *
 * This is the axis that makes the archetype differ across PvT / PvP / PvZ. The
 * race-wide balance shape it replaced returned an identical category for all
 * three matchups by construction, so a third of the archetype key could never
 * vary — which is half of why every matchup produced the same name.
 *
 * Unlike the other tracks this one measures results rather than style; its
 * vocabulary is deliberately framed as a matchup you hunt or one you climb,
 * not as a grade.
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

  let category = "edge_on_par";
  if (delta + THRESHOLD_EPSILON >= EDGE_MIN_DELTA) category = "edge_strong";
  else if (delta - THRESHOLD_EPSILON <= -EDGE_MIN_DELTA) category = "edge_weak";

  return {
    // Strong pulls left, matching the existing gradient direction on the card.
    position: Math.max(0, Math.min(100, Math.round(50 - delta * 2))),
    value: round3(delta),
    category,
    categoryLabel: TRAIT_LABELS[category],
    sampleSize: selectedDecided,
    detail: {
      winRate: round3(selectedRate),
      comparatorWinRate: round3(comparatorRate),
      comparedAgainst: comparators.map((row) => row.matchup),
    },
  };
}

/**
 * Race-wide win-rate shape across all three matchups.
 *
 * Retained purely as *evidence*: it populates the three win-rate cards and the
 * `matchupSummary` block that `tickerFacts.matchupDetail` reads directly. It
 * no longer contributes a category to the archetype — see
 * {@link matchupEdgeAxis}.
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
 * How far from unremarkable an axis sits, on 0..1. Drives which two traits get
 * to name the player, so the name describes what is *unusual* about them —
 * that is what stops the modal player from being handed the modal name.
 *
 * Not simply `|position - 50|`: `two_speed` sits at the centre of the pace
 * track by construction (its early and late shares cancel) and would score
 * zero despite being the most distinctive pace category there is. Any axis
 * whose centre is itself a category needs the same special case.
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
    const weaker = Math.min(detail.earlyShare ?? 0, detail.lateShare ?? 0);
    const span = PACE_DOMINANT_SHARE - TWO_SPEED_MIN_SHARE;
    return clamp01((weaker - TWO_SPEED_MIN_SHARE) / span);
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

/**
 * @param {ReadonlyArray<{key:string,below:number}>} bands
 * @param {number} value
 */
function bandFor(bands, value) {
  for (const band of bands) {
    if (value < band.below - THRESHOLD_EPSILON) return band.key;
  }
  return bands[bands.length - 1].key;
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
  paceAxis,
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
  MIN_VALID_DURATION_SEC,
  REPERTOIRE_BANDS,
  EARLY_MAX_SEC,
  LATE_MIN_SEC,
  TWO_SPEED_MIN_SHARE,
  PACE_DOMINANT_SHARE,
  PACE_TAIL_MAX_SHARE,
  EDGE_MIN_DELTA,
  NEUTRAL_MAX_DISTINCTIVENESS,
};
