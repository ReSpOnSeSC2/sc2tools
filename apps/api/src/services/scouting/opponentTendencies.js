"use strict";

/**
 * opponentTendencies — pure compute behind the overlay's opponent
 * scouting intel: favourite opening, predicted strategies and the
 * cheese alert, derived from the streamer's own games against one
 * opponent in one matchup.
 *
 * No I/O. ``overlayLiveAggregations.opponentTendencies`` runs the one
 * indexed games query and hands the matchup subset here; the
 * ``OverlayLiveService`` copies the result onto the live payload.
 *
 * Every number reads the streamer's own labels: a confirmed opponent
 * check-in correction counts under the build the streamer said the
 * opponent played, exactly as the dossier and the rest of the
 * personal stats count it. Predictions come from the dossier's own
 * ``recencyWeightedStrategies``, so the overlay and the dossier agree
 * on the same games.
 *
 * ``tendenciesFromLegacyOpenings`` keeps the pre-2026 ``openings``
 * frequency map on old opponents rows readable. Nothing writes that
 * map any more; it only backs opponents whose games carry no labels.
 */

const Dna = require("../dnaTimings");
const {
  TOO_SHORT_SECONDS,
  TOO_SHORT_LABEL_RE,
  opponentOverrideActive,
} = require("../buildIntentShape");

/** Fewest matchup games before any tendency is shown. */
const MIN_TENDENCY_GAMES = 2;

/** The cheese widget, the voice readout and the ticker all hide below this. */
const CHEESE_ALERT_THRESHOLD = 0.4;

/** Predicted strategies shipped on the payload (the widgets show three). */
const MAX_PREDICTIONS = 3;

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
  "12 pool",
  "all-in",
  "allin",
  "all in",
  "bunker rush",
  "worker rush",
];

/**
 * Probability the cheese widget renders for one opponent strategy
 * label. Keyword hits land at 0.7 (above the widget's 0.4 threshold);
 * everything else at the hide-me baseline 0.1.
 *
 * @param {unknown} strategy
 * @returns {number}
 */
function cheeseProbability(strategy) {
  if (!strategy) return 0.1;
  const s = String(strategy).toLowerCase();
  for (const k of CHEESE_KEYWORDS) {
    if (s.includes(k)) return 0.7;
  }
  return 0.1;
}

/** @param {unknown} strategy @returns {boolean} */
function isCheese(strategy) {
  return cheeseProbability(strategy) >= CHEESE_ALERT_THRESHOLD;
}

/**
 * The opponent's opening as the streamer's own stats count it: the
 * confirmed check-in correction when one is applied, else the stored
 * classifier label. Empty when the game was never labelled.
 *
 * Example: a row whose replay said "Zerg - Hatch First" but which the
 * streamer corrected to "Zerg - 12 Pool" → "Zerg - 12 Pool".
 *
 * @param {any} row games row projected with ``OPP_INTENT_LABEL_PROJECTION``
 * @returns {string}
 */
function personalOppStrategy(row) {
  if (opponentOverrideActive(row)) {
    return String(row.buildIntent.opponent.build.name).trim();
  }
  const s = row && row.opponent ? row.opponent.strategy : null;
  return typeof s === "string" ? s.trim() : "";
}

/**
 * Leavers and loading-screen disconnects show no opening at all, so
 * they never count toward a tendency (same 45 s cut-off as check-in).
 *
 * @param {any} row
 * @param {string} label
 * @returns {boolean}
 */
function isTooShort(row, label) {
  const duration = Number(row && row.durationSec);
  if (Number.isFinite(duration) && duration > 0 && duration < TOO_SHORT_SECONDS) {
    return true;
  }
  return TOO_SHORT_LABEL_RE.test(label);
}

/**
 * Most frequent known label; ties go to the one seen most recently.
 *
 * @param {string[]} labels newest first, "" for unlabelled games
 * @returns {{name: string, count: number} | null}
 */
function topLabel(labels) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const label of labels) {
    if (label) counts.set(label, (counts.get(label) || 0) + 1);
  }
  /** @type {{name: string, count: number} | null} */
  let best = null;
  // Map iteration follows first insertion, i.e. newest first, so a
  // strict ``>`` keeps the most recent label on a tie.
  for (const [name, count] of counts) {
    if (!best || count > best.count) best = { name, count };
  }
  return best;
}

/**
 * @typedef {{
 *   window: number,
 *   favOpening?: {name: string, share: number, samples: number, of: number},
 *   predictedStrategies?: Array<{name: string, weight: number}>,
 *   cheeseProbability?: number,
 *   cheeseHistory?: {samples: number, of: number},
 * }} OpponentTendencies
 */

/**
 * Summarise one opponent's games in one matchup.
 *
 * ``window`` is how many games the numbers come from (newest first,
 * games under 45 s left out). Below ``MIN_TENDENCY_GAMES`` nothing
 * else is returned. ``favOpening`` needs the opening at least twice;
 * ``cheeseProbability`` is the recency-weighted share of games whose
 * opening the keyword classifier calls cheese, set only at or above
 * the 0.4 alert threshold.
 *
 * Example: openings [12 Pool, Hatch First, 12 Pool] →
 *   favOpening {name: "12 Pool", share: 0.667, samples: 2, of: 3},
 *   cheeseProbability 0.667, cheeseHistory {samples: 2, of: 3}.
 *
 * @param {Array<any>} rows newest first, already scoped to the matchup
 * @returns {OpponentTendencies}
 */
function summarizeOpponentTendencies(rows) {
  const labels = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const label = personalOppStrategy(row);
    if (!isTooShort(row, label)) labels.push(label);
  }
  const window = labels.length;
  /** @type {OpponentTendencies} */
  const out = { window };
  if (window < MIN_TENDENCY_GAMES) return out;

  const top = topLabel(labels);
  if (top && top.count >= MIN_TENDENCY_GAMES) {
    out.favOpening = {
      name: top.name,
      share: top.count / window,
      samples: top.count,
      of: window,
    };
  }

  // The dossier's predictor over the same games: last 10 count double,
  // unlabelled games stay in the denominator as "Unknown".
  const weighted = Dna.recencyWeightedStrategies(
    labels.map((strategy) => ({ opponent: { strategy } })),
  );
  const predictions = weighted
    .filter((p) => p.strategy !== "Unknown")
    .slice(0, MAX_PREDICTIONS)
    .map((p) => ({ name: p.strategy, weight: p.probability }));
  if (predictions.length > 0) out.predictedStrategies = predictions;

  const cheese = weighted
    .filter((p) => isCheese(p.strategy))
    .reduce((sum, p) => sum + p.probability, 0);
  if (cheese >= CHEESE_ALERT_THRESHOLD) {
    out.cheeseProbability = cheese;
    out.cheeseHistory = {
      samples: labels.filter((label) => isCheese(label)).length,
      of: window,
    };
  }
  return out;
}

/**
 * Same shape from a legacy ``opponents.openings`` frequency map
 * (``{"Pool first": 3, Macro: 1}``). Counts carry no dates, so the
 * shares are plain frequencies. Null when the map is empty.
 *
 * @param {unknown} openings
 * @returns {OpponentTendencies | null}
 */
function tendenciesFromLegacyOpenings(openings) {
  if (!openings || typeof openings !== "object") return null;
  const entries = Object.entries(openings)
    .map(([name, v]) => /** @type {[string, number]} */ ([name, Number(v)]))
    .filter(([name, v]) => name && Number.isFinite(v) && v > 0)
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  const total = entries.reduce((acc, [, v]) => acc + v, 0);
  const [favName, favCount] = entries[0];
  /** @type {OpponentTendencies} */
  const out = {
    window: total,
    favOpening: { name: favName, share: favCount / total, samples: favCount, of: total },
    predictedStrategies: entries
      .slice(0, MAX_PREDICTIONS)
      .map(([name, v]) => ({ name, weight: v / total })),
  };
  const cheeseGames = entries
    .filter(([name]) => isCheese(name))
    .reduce((acc, [, v]) => acc + v, 0);
  if (cheeseGames / total >= CHEESE_ALERT_THRESHOLD) {
    out.cheeseProbability = cheeseGames / total;
    out.cheeseHistory = { samples: cheeseGames, of: total };
  }
  return out;
}

/**
 * True when the game-derived summary has anything to show. When it
 * doesn't, callers fall back to the legacy openings map.
 *
 * @param {OpponentTendencies | null | undefined} t
 * @returns {boolean}
 */
function hasTendencies(t) {
  return Boolean(
    t
    && t.window >= MIN_TENDENCY_GAMES
    && (t.favOpening || (t.predictedStrategies && t.predictedStrategies.length > 0)),
  );
}

module.exports = {
  MIN_TENDENCY_GAMES,
  CHEESE_ALERT_THRESHOLD,
  CHEESE_KEYWORDS,
  cheeseProbability,
  personalOppStrategy,
  summarizeOpponentTendencies,
  tendenciesFromLegacyOpenings,
  hasTendencies,
};
