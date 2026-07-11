"use strict";

/**
 * Skill Fingerprint — the product's identity artifact.
 *
 * A multi-axis profile of ONE player's skill dimensions in ONE matchup,
 * each axis expressed as a percentile against players in the same
 * league band + matchup (the Mobalytics-GPI pattern), plus a
 * deterministic playstyle label derived from the axis values.
 *
 * Data source — the player's most recent ``WINDOW_GAMES`` (50) slim
 * ``games`` rows for the requested matchup. Only ingest-stamped slim
 * metrics are read (``macroScore``, ``apm``, ``spq``, ``durationSec``,
 * ``myMmr``, ``opponent.leagueId``); the heavy ``game_details`` blob is
 * never touched.
 *
 * Matchup — same derivation as services/leaguePercentiles.js: the
 * first letters of ``myRace`` and ``opponent.race`` ("Protoss" vs
 * "Zerg" → "PvZ"). The query filters with case-insensitive
 * ``^letter`` anchors, and team games (``playerCount`` present and
 * != 2) are excluded — mirroring the corpus the percentile tables
 * were built from, so the comparison is apples-to-apples.
 *
 * Band — the modal ``opponent.leagueId`` across the window (ties break
 * toward the HIGHER league so the framing never undersells the
 * sample). Games rows carry no "my league" field; SC2 matchmaking
 * pairs near-equal ratings, so the opponent's league is a faithful
 * proxy for the bracket — the exact rationale leaguePercentiles.js
 * bands by.
 *
 * Axis formulas (each documented again at the computation site):
 *   Macro       — mean of per-game ``macroScore`` percentiles in the band.
 *   Mechanics   — mean of per-game ``apm`` percentiles.
 *   Spending    — mean of per-game ``spq`` percentiles.
 *   Consistency — 100 * (1 - min(1, sd / 25)) where sd is the
 *                 population standard deviation of ``macroScore``.
 *                 Percentile-free: it measures the player against
 *                 themself, not the band.
 *   Aggression  — 100 minus the mean of per-game ``durationSec``
 *                 percentiles (INVERTED: shorter games than the band's
 *                 norm = higher aggression).
 *   Ladder      — mean of per-game ``myMmr`` percentiles.
 *
 * Axes whose percentile cannot be computed (no band table, metric
 * below the k-anonymity floor, or no numeric samples) come back with
 * ``percentile: null`` — the radar hides them rather than plotting a
 * fake zero.
 *
 * Fewer than ``MIN_GAMES`` (10) qualifying games → ``compute`` returns
 * ``null`` and the route 404s with ``not_enough_games``.
 */

/** Most-recent-games window the fingerprint is computed over. */
const WINDOW_GAMES = 50;

/** Below this many qualifying games there is no fingerprint at all. */
const MIN_GAMES = 10;

/** Consistency needs a minimal spread sample to mean anything. */
const MIN_CONSISTENCY_SAMPLE = 5;

/**
 * Consistency scale ceiling: a macroScore standard deviation at or
 * above this reads as 0 consistency. Why 25 — macroScore lives on a
 * 0..100 scale, and a UNIFORMLY RANDOM score on that scale has
 * sd ≈ 28.9; 25 therefore marks "your macro is basically a dice
 * roll", while sd 0 (identical score every game) maps to 100.
 */
const CONSISTENCY_SD_CEIL = 25;

/** "Early finish" cutoff (8:00 in-game) for Aggression's raw value:
 *  the share of the player's games ending before this many seconds. */
const EARLY_FINISH_SEC = 8 * 60;

/** Axis order is the wire order — the radar draws clockwise from it. */
const AXES = Object.freeze([
  { key: "macro", label: "Macro" },
  { key: "mechanics", label: "Mechanics" },
  { key: "spending", label: "Spending" },
  { key: "consistency", label: "Consistency" },
  { key: "aggression", label: "Aggression" },
  { key: "ladder", label: "Ladder" },
]);

/**
 * SC2 league enum → display label. Mirrors the (unexported) map in
 * services/leaguePercentiles.js — kept local because that module's
 * surface is frozen and the fingerprint must label a band even when
 * the band has no percentile table yet.
 */
const LEAGUE_NAMES = Object.freeze({
  0: "Bronze",
  1: "Silver",
  2: "Gold",
  3: "Platinum",
  4: "Diamond",
  5: "Master",
  6: "Grandmaster",
});

/**
 * Playstyle decision table — deterministic, first match wins, and a
 * rule is only ELIGIBLE when every axis it references is non-null
 * (a hidden axis can neither qualify nor disqualify a label).
 *
 *   # | Rule (percentile thresholds)                      | Label
 *  ---+---------------------------------------------------+---------------------
 *   1 | ≥4 axes present AND every present axis ≥ 65       | Complete Player
 *   2 | Aggression ≥ 70 AND Macro < 40                    | All-in Gambler
 *   3 | Macro ≥ 70 AND Aggression < 40                    | Greedy Macro Player
 *   4 | Aggression ≥ 65 AND Mechanics ≥ 65                | Tempo Attacker
 *   5 | Spending ≥ 70 AND Macro ≥ 55                      | Economic Engine
 *   6 | Mechanics ≥ 70 AND Spending < 40                  | Busy Hands, Idle Bank
 *   7 | Consistency ≥ 70 AND Aggression < 55              | Metronome
 *   8 | Consistency < 35                                  | Coin-Flip Player
 *   9 | (fallback)                                        | Jack of All Trades
 *
 * Rationale for the ordering: rule 1 celebrates all-round strength
 * before any single-dimension caricature can claim the player; the
 * strong identity splits (2/3) outrank the softer tendencies (4–7);
 * volatility (8) is a last resort before the neutral fallback. Ladder
 * (MMR) deliberately appears only in rule 1 — where you ARE on the
 * ladder is context, not a playstyle.
 *
 * @param {Record<string, number | null>} ax axis key → percentile
 * @returns {string}
 */
function derivePlaystyle(ax) {
  /** @param {string} k */
  const has = (k) => typeof ax[k] === "number" && Number.isFinite(ax[k]);
  /**
   * Read an axis a rule has already ``has()``-guarded — the cast only
   * asserts what the guard established.
   * @param {string} k @returns {number}
   */
  const val = (k) => /** @type {number} */ (ax[k]);
  const present = AXES.map((a) => a.key).filter(has);
  if (present.length >= 4 && present.every((k) => val(k) >= 65)) {
    return "Complete Player";
  }
  if (has("aggression") && has("macro") && val("aggression") >= 70 && val("macro") < 40) {
    return "All-in Gambler";
  }
  if (has("macro") && has("aggression") && val("macro") >= 70 && val("aggression") < 40) {
    return "Greedy Macro Player";
  }
  if (
    has("aggression") && has("mechanics")
    && val("aggression") >= 65 && val("mechanics") >= 65
  ) {
    return "Tempo Attacker";
  }
  if (has("spending") && has("macro") && val("spending") >= 70 && val("macro") >= 55) {
    return "Economic Engine";
  }
  if (
    has("mechanics") && has("spending")
    && val("mechanics") >= 70 && val("spending") < 40
  ) {
    return "Busy Hands, Idle Bank";
  }
  if (
    has("consistency") && has("aggression")
    && val("consistency") >= 70 && val("aggression") < 55
  ) {
    return "Metronome";
  }
  if (has("consistency") && val("consistency") < 35) {
    return "Coin-Flip Player";
  }
  return "Jack of All Trades";
}

/**
 * @typedef {{
 *   key: string,
 *   label: string,
 *   percentile: number | null,
 *   value: number | null,
 * }} FingerprintAxis
 *
 * @typedef {{
 *   matchup: string,
 *   band: { leagueId: number, label: string } | null,
 *   games: number,
 *   axes: FingerprintAxis[],
 *   playstyle: string,
 * }} Fingerprint
 */

class SkillFingerprintService {
  /**
   * @param {{ games: import('mongodb').Collection }} db
   *        DbContext from db/connect.js (only ``games`` is read).
   * @param {{
   *   leaguePercentiles: import('./leaguePercentiles').LeaguePercentilesService,
   *   logger?: import('pino').Logger | null,
   * }} opts
   */
  constructor(db, opts) {
    this.games = db.games;
    this.leaguePercentiles = opts.leaguePercentiles;
    this.logger = opts.logger || null;
  }

  /**
   * Compute the fingerprint for one user + matchup.
   *
   * @param {string} userId internal user id (req.auth.userId)
   * @param {{ matchup: string }} args case-insensitive, e.g. "PvZ"
   * @returns {Promise<Fingerprint | null>} null when the matchup is
   *          invalid or fewer than MIN_GAMES qualifying games exist.
   */
  async compute(userId, { matchup } = /** @type {any} */ ({})) {
    if (typeof userId !== "string" || userId.length === 0) return null;
    const mu = normalizeMatchup(matchup);
    if (!mu) return null;

    const rows = await loadWindow(this.games, userId, mu);
    if (rows.length < MIN_GAMES) return null;

    const bandId = modalLeagueId(rows);
    const table =
      bandId === null
        ? null
        : await this.leaguePercentiles.lookup({ leagueId: bandId, matchup: mu });

    const lp = this.leaguePercentiles;

    // Formulas live on the helpers below: the band-relative axes are
    // means of PER-GAME percentiles (an outlier game moves an axis by
    // at most 99/n), Consistency is percentile-free, Aggression reads
    // the band's duration ladder upside down.
    const macro = avgPercentileAxis(lp, table, "macroScore", rows);
    const mechanics = avgPercentileAxis(lp, table, "apm", rows);
    const spending = avgPercentileAxis(lp, table, "spq", rows);
    const ladder = avgPercentileAxis(lp, table, "myMmr", rows);
    const consistency = consistencyAxis(rows);
    const aggression = aggressionAxis(lp, table, rows);

    /** @type {Record<string, {percentile: number|null, value: number|null}>} */
    const byKey = { macro, mechanics, spending, consistency, aggression, ladder };
    const axes = AXES.map((a) => ({
      key: a.key,
      label: a.label,
      percentile: byKey[a.key].percentile,
      value: byKey[a.key].value,
    }));

    const percentiles = Object.fromEntries(
      axes.map((a) => [a.key, a.percentile]),
    );
    return {
      matchup: mu,
      band:
        bandId === null
          ? null
          : { leagueId: bandId, label: leagueLabel(bandId) },
      games: rows.length,
      axes,
      playstyle: derivePlaystyle(percentiles),
    };
  }
}

/**
 * The user's most recent WINDOW_GAMES slim rows for one matchup,
 * newest first, slim metrics only. The case-insensitive ^letter
 * anchors reproduce the first-letter matchup derivation
 * leaguePercentiles.js uses ("Protoss" → P), and the playerCount
 * clause excludes team games the same way its corpus pipeline does —
 * so the player is measured against the exact population the band
 * tables were built from.
 *
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @param {string} mu canonical matchup, e.g. "PvZ"
 * @returns {Promise<Array<Record<string, any>>>}
 */
function loadWindow(games, userId, mu) {
  return games
    .find(
      {
        userId,
        myRace: { $regex: `^${mu[0]}`, $options: "i" },
        "opponent.race": { $regex: `^${mu[2]}`, $options: "i" },
        $or: [{ playerCount: { $exists: false } }, { playerCount: 2 }],
      },
      {
        projection: {
          _id: 0,
          macroScore: 1,
          apm: 1,
          spq: 1,
          durationSec: 1,
          myMmr: 1,
          "opponent.leagueId": 1,
          date: 1,
        },
        sort: { date: -1 },
        limit: WINDOW_GAMES,
      },
    )
    .toArray();
}

// ---------------- axis helpers (pure) ----------------

/**
 * Mean of per-game percentiles for one slim metric. Returns null
 * percentile when the band table is missing, the metric is under the
 * MIN_SAMPLE floor, or the player has no numeric values for it. The
 * ``value`` is the player's raw mean (1 decimal) — shown by the UI as
 * "what the percentile is a percentile OF".
 *
 * @param {{ percentileOf: (t: any, m: string, v: number) => number | null }} lp
 * @param {object | null} table band row from leaguePercentiles.lookup
 * @param {string} metric slim metric name
 * @param {Array<Record<string, any>>} rows
 * @returns {{ percentile: number | null, value: number | null }}
 */
function avgPercentileAxis(lp, table, metric, rows) {
  const values = numericValues(rows, metric);
  if (values.length === 0) return { percentile: null, value: null };
  const value = round1(mean(values));
  if (!table) return { percentile: null, value };
  const pcts = [];
  for (const v of values) {
    const p = lp.percentileOf(table, metric, v);
    if (typeof p === "number") pcts.push(p);
  }
  if (pcts.length === 0) return { percentile: null, value };
  return { percentile: clampPct(Math.round(mean(pcts))), value };
}

/**
 * Consistency = 100 * (1 - min(1, sd / CONSISTENCY_SD_CEIL)).
 * ``value`` is the sd itself so the UI can say "±6.2 macro points".
 * Needs MIN_CONSISTENCY_SAMPLE numeric macroScores; below that a
 * standard deviation is noise, so the axis hides.
 *
 * @param {Array<Record<string, any>>} rows
 * @returns {{ percentile: number | null, value: number | null }}
 */
function consistencyAxis(rows) {
  const scores = numericValues(rows, "macroScore");
  if (scores.length < MIN_CONSISTENCY_SAMPLE) {
    return { percentile: null, value: null };
  }
  const m = mean(scores);
  const sd = Math.sqrt(
    scores.reduce((acc, v) => acc + (v - m) * (v - m), 0) / scores.length,
  );
  const score = Math.round(100 * (1 - Math.min(1, sd / CONSISTENCY_SD_CEIL)));
  return { percentile: score, value: round1(sd) };
}

/**
 * Aggression = 100 - mean(per-game durationSec percentile), i.e. the
 * band's duration ladder read upside down: consistently finishing
 * games faster than the band's norm scores high. ``value`` = share
 * (%) of the player's games ending before EARLY_FINISH_SEC (8:00).
 *
 * @param {{ percentileOf: (t: any, m: string, v: number) => number | null }} lp
 * @param {object | null} table
 * @param {Array<Record<string, any>>} rows
 * @returns {{ percentile: number | null, value: number | null }}
 */
function aggressionAxis(lp, table, rows) {
  const durations = numericValues(rows, "durationSec");
  if (durations.length === 0) return { percentile: null, value: null };
  const early = durations.filter((d) => d < EARLY_FINISH_SEC).length;
  const value = Math.round((100 * early) / durations.length);
  if (!table) return { percentile: null, value };
  const pcts = [];
  for (const d of durations) {
    const p = lp.percentileOf(table, "durationSec", d);
    if (typeof p === "number") pcts.push(p);
  }
  if (pcts.length === 0) return { percentile: null, value };
  return { percentile: clampPct(Math.round(100 - mean(pcts))), value };
}

// ---------------- small utilities ----------------

/**
 * Modal opponent.leagueId across the window; ties break toward the
 * higher league. Null when no row carries a numeric leagueId (e.g.
 * offline/custom games) — the fingerprint then has no band and every
 * percentile axis hides.
 *
 * @param {Array<Record<string, any>>} rows
 * @returns {number | null}
 */
function modalLeagueId(rows) {
  /** @type {Map<number, number>} */
  const counts = new Map();
  for (const r of rows) {
    const id =
      r.opponent && typeof r.opponent.leagueId === "number"
        ? r.opponent.leagueId
        : null;
    if (id === null || !Number.isFinite(id)) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [id, c] of counts.entries()) {
    if (c > bestCount || (c === bestCount && best !== null && id > best)) {
      best = id;
      bestCount = c;
    }
  }
  return best;
}

/**
 * @param {Array<Record<string, any>>} rows
 * @param {string} key
 * @returns {number[]}
 */
function numericValues(rows, key) {
  const out = [];
  for (const r of rows) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  }
  return out;
}

/** @param {number[]} xs */
function mean(xs) {
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/** @param {number} v */
function round1(v) {
  return Math.round(v * 10) / 10;
}

/** Percentile axes stay on leaguePercentiles' 1..99 ladder. */
/** @param {number} p */
function clampPct(p) {
  return Math.max(1, Math.min(99, p));
}

/**
 * Canonicalize a matchup string ("pvz" → "PvZ"). Same contract as the
 * (unexported) normalizer in services/leaguePercentiles.js.
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeMatchup(raw) {
  if (typeof raw !== "string") return null;
  const m = /^([ptz])\s*v\s*([ptz])$/i.exec(raw.trim());
  if (!m) return null;
  return `${m[1].toUpperCase()}v${m[2].toUpperCase()}`;
}

/** @param {number} leagueId */
function leagueLabel(leagueId) {
  const name = /** @type {Record<number, string>} */ (LEAGUE_NAMES)[leagueId];
  return name || `League ${leagueId}`;
}

module.exports = {
  SkillFingerprintService,
  derivePlaystyle,
  WINDOW_GAMES,
  MIN_GAMES,
  EARLY_FINISH_SEC,
  CONSISTENCY_SD_CEIL,
};
