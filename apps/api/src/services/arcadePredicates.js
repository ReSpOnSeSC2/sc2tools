"use strict";

/**
 * Bingo: Ladder Edition objective predicates + slim-row field helpers.
 *
 * Each entry in PREDICATES is a pure function (games[], params) →
 * gameId | null. The registry is the source of truth for what can
 * appear on a card; the candidate factory in
 * apps/web/.../bingoLadder.candidates.ts MUST reference a key that
 * exists here, otherwise resolveQuests treats the cell as unknown
 * and leaves it un-ticked.
 *
 * Two-pass strategy lives in services/arcade.js: predicates that read
 * only the slim ``games`` row run in pass 1 (no extra I/O); ones
 * listed in HEAVY_PREDICATES need game_details and run after a single
 * bulk load. Whichever pass a predicate runs in, the signature is the
 * same — heavy predicates just assume buildLog / oppBuildLog have
 * been merged onto the slim row by the time they're called.
 *
 * Field-name tolerance: production rows use the DB-canonical
 * ``durationSec`` / ``macroScore`` / nested ``opponent.race``; client-
 * roundtripped fixtures (e.g. tests that re-use normaliseGame) use
 * ``duration`` / ``macro_score`` / ``oppRace``. The slim-row helpers
 * below check both shapes so each predicate stays a one-liner.
 */

/* ──────────────── Slim-row field helpers ──────────────── */

/**
 * Game duration in seconds. DB-canonical column is ``durationSec``; the
 * client-side ``normaliseGame`` lifts it onto ``duration`` for legacy
 * SPA code. Read both.
 *
 * @param {any} g
 * @returns {number} duration in seconds, or NaN if neither field is set
 */
function durationOf(g) {
  const a = Number(g.durationSec);
  if (Number.isFinite(a)) return a;
  const b = Number(g.duration);
  if (Number.isFinite(b)) return b;
  return Number.NaN;
}

/**
 * Macro score. DB-canonical is ``macroScore``; ``normaliseGame`` lifts
 * it to ``macro_score``. Read both.
 *
 * @param {any} g
 * @returns {number} macro score, or NaN
 */
function macroScoreOf(g) {
  const a = Number(g.macroScore);
  if (Number.isFinite(a)) return a;
  const b = Number(g.macro_score);
  if (Number.isFinite(b)) return b;
  return Number.NaN;
}

/**
 * APM. Single canonical field, tolerate legacy uppercase form.
 *
 * @param {any} g
 * @returns {number} APM, or NaN
 */
function apmOf(g) {
  const a = Number(g.apm);
  if (Number.isFinite(a)) return a;
  const b = Number(g.APM);
  if (Number.isFinite(b)) return b;
  return Number.NaN;
}

/**
 * My-race letter ("P" | "T" | "Z" | ""). Tolerates full names
 * ("Protoss"), letter form, and casing variations.
 *
 * @param {any} g
 * @returns {string}
 */
function myRaceLetter(g) {
  return raceLetter(g.myRace);
}

/**
 * Opponent-race letter. The agent persists the resolved opponent block
 * under ``opponent.race``; the client lifts it to top-level ``oppRace``
 * in normaliseGame. Both paths checked so server-side games (raw DB
 * rows) and round-tripped client games (test fixtures) resolve
 * identically.
 *
 * @param {any} g
 * @returns {string}
 */
function oppRaceLetter(g) {
  return raceLetter(g.oppRace || (g.opponent && g.opponent.race) || "");
}

/**
 * My-build string — agent-classified strategy label like
 * "Protoss - Cannon Rush". Returns "" when the field is missing.
 *
 * @param {any} g
 * @returns {string}
 */
function myBuildOf(g) {
  if (typeof g.myBuild === "string") return g.myBuild;
  return "";
}

/**
 * Opponent strategy string — legacy ``opp_strategy`` AND modern
 * ``opponent.strategy`` (agent v0.5+). Returns "" when neither is set.
 *
 * Retained only for back-compat: the candidate factory no longer mints
 * cells using win_vs_strategy_contains because the agent's classifier
 * doesn't emit a stable taxonomy for opponent rushes / cheese / proxy
 * (see retired-keys list in apps/web/.../bingoLadder.tsx). The
 * predicate still resolves so persisted cards keep ticking until the
 * legacy-detector regenerates them.
 *
 * @param {any} g
 * @returns {string}
 */
function oppStrategyOf(g) {
  if (typeof g.opp_strategy === "string" && g.opp_strategy) {
    return g.opp_strategy;
  }
  if (g.opponent && typeof g.opponent === "object") {
    const s = /** @type {any} */ (g.opponent).strategy;
    if (typeof s === "string") return s;
  }
  return "";
}

/**
 * Game outcome → "W" / "L" / "U". Mirrors the SPA's ``gameOutcome``
 * helper in lib/h2hSeries.ts so server/client stay in lockstep.
 *
 * @param {any} g
 * @returns {"W" | "L" | "U"}
 */
function outcome(g) {
  const r = String(g.result || "").toLowerCase();
  if (r === "win" || r === "victory") return "W";
  if (r === "loss" || r === "defeat") return "L";
  return "U";
}

const isWin = (g) => outcome(g) === "W";
const lc = (v) => (typeof v === "string" ? v.toLowerCase() : "");
const raceLetter = (v) =>
  typeof v === "string" && v.length > 0 ? v.charAt(0).toUpperCase() : "";

/**
 * Best-effort opponent MMR — the column was renamed across agent
 * versions, so check modern + legacy fields. Returns NaN when neither
 * is populated.
 *
 * @param {any} g
 * @returns {number}
 */
function oppMmr(g) {
  const cand = [g?.opponent?.mmr, g?.opp_mmr, g?.oppMmr];
  for (const v of cand) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return Number.NaN;
}

/**
 * Best-effort opponent identifier — preferred ``opponent.pulseId``,
 * then top-level legacy ``oppPulseId``. Returns "" when neither is
 * populated; revenge_win silently skips those rows.
 *
 * @param {any} g
 * @returns {string}
 */
function pulseIdOf(g) {
  const a = g?.opponent?.pulseId;
  if (typeof a === "string" && a) return a;
  const b = g?.oppPulseId;
  if (typeof b === "string" && b) return b;
  return "";
}

/**
 * True when any entry in a build-log array contains the needle as a
 * case-insensitive substring. The build-log line shape varies across
 * agent versions ("[5:30] Supply Depot" vs structured objects), so
 * coerce to string and match defensively.
 *
 * @param {unknown} log
 * @param {string} needle  already lowercased by the caller
 * @returns {boolean}
 */
function buildLogContains(log, needle) {
  if (!Array.isArray(log) || log.length === 0) return false;
  for (const entry of log) {
    const s = typeof entry === "string" ? entry : JSON.stringify(entry);
    if (s.toLowerCase().includes(needle)) return true;
  }
  return false;
}

/**
 * Count distinct log lines matching the needle. Used by
 * ``won_built_n_of_unit`` for "built N+ Marines"-style objectives.
 *
 * @param {unknown} log
 * @param {string} needle
 * @returns {number}
 */
function buildLogCount(log, needle) {
  if (!Array.isArray(log) || log.length === 0) return 0;
  let n = 0;
  for (const entry of log) {
    const s = typeof entry === "string" ? entry : JSON.stringify(entry);
    if (s.toLowerCase().includes(needle)) n += 1;
  }
  return n;
}

function firstId(games) {
  if (!games.length) return null;
  return String(games[0].gameId);
}

/* ──────────────── ISO-week start helper ──────────────── */

/**
 * Convert an ISO-week key ("YYYY-Www") to the UTC Date for Monday
 * 00:00:00 of that ISO week.
 *
 * The Bingo card is keyed on an ISO week. The resolver uses this to
 * pick the lower bound for the "games-in-window" query: every game in
 * the user's calendar week should be eligible, not just games since
 * the card was first opened. (Card-startedAt-as-floor was the cause
 * of "Win vs Protoss never ticks even though I beat one Monday" —
 * the user generates the card mid-week and earlier games fell
 * outside the window.)
 *
 * UTC midnight is deliberate: it is at or before every local midnight
 * worldwide, so a Monday-noon game in any timezone falls in-window.
 * The upper bound is open (we never look forward past "now"), so a
 * one-day-ahead floor doesn't pull in next week's games.
 *
 * Returns null for malformed input — the caller falls back to
 * ``card.startedAt``.
 *
 * @param {unknown} weekKey
 * @returns {Date | null}
 */
function isoWeekStart(weekKey) {
  if (typeof weekKey !== "string") return null;
  const m = /^(\d{4})-W(\d{2})$/.exec(weekKey);
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (!Number.isFinite(year) || !Number.isFinite(week)) return null;
  if (week < 1 || week > 53) return null;
  // ISO 8601: week 1 is the week containing January 4th.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  // (getUTCDay() + 6) % 7 maps Sunday=0..Saturday=6 to Monday=0..Sunday=6.
  const jan4Dow = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Dow);
  const target = new Date(week1Monday);
  target.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return target;
}

/* ──────────────── HEAVY / LEGACY predicate registries ──────────────── */

/**
 * Predicates that depend on game_details fields. resolveQuests checks
 * this set to decide whether to bulk-load the heavy store. Add a
 * predicate here AND in PREDICATES.
 */
const HEAVY_PREDICATES = new Set([
  "won_with_unit",
  "won_built_n_of_unit",
  "won_built_opp_unit_seen",
  "built_n_of_unit_week",
]);

/**
 * The four heavy field names (mirrored from services/gameDetails.js).
 * Duplicated locally so the slim-vs-heavy decoration step doesn't have
 * to require gameDetails.js when the dep is null in a test.
 */
const HEAVY_FIELDS = Object.freeze([
  "buildLog",
  "oppBuildLog",
  "macroBreakdown",
  "apmCurve",
]);

/* ──────────────── Predicate registry ──────────────── */

/**
 * Predicate registry for Bingo objectives. Each predicate receives the
 * user's games-in-window (chronological) and the objective's params,
 * and returns the gameId that satisfied it (truthy) or null.
 *
 * Predicates are pure: no DB calls, no I/O, no time math beyond what's
 * on the row. They MUST tolerate missing fields — the games collection
 * is wide and old rows can lack any modern field. The helpers above
 * (durationOf / macroScoreOf / etc.) handle the legacy/canonical
 * field-name split so each predicate stays a one-liner.
 *
 * @type {Record<string, (games: any[], params: any) => string | null>}
 */
const PREDICATES = {
  /** Played at least one game in the window. Free-space center cell. */
  any_game: (games) => firstId(games),
  /** Won any game in the window. */
  any_win: (games) => firstId(games.filter(isWin)),
  /** Won on a specific map (params.map: string). Retained for
   *  back-compat with cards generated before the map-objective
   *  removal — new cards will not include this predicate, but a card
   *  persisted under the previous schema must still resolve so
   *  existing ticks stay sticky. */
  win_on_map: (games, params) => {
    const map = String(params.map || "").toLowerCase();
    return firstId(games.filter((g) => isWin(g) && lc(g.map) === map));
  },
  /** Won as a specific race (params.race: P/T/Z). */
  win_as_race: (games, params) => {
    const race = String(params.race || "").charAt(0).toUpperCase();
    return firstId(games.filter((g) => isWin(g) && myRaceLetter(g) === race));
  },
  /** Won vs a specific race (params.race). */
  win_vs_race: (games, params) => {
    const race = String(params.race || "").charAt(0).toUpperCase();
    return firstId(
      games.filter((g) => isWin(g) && oppRaceLetter(g) === race),
    );
  },
  /** Won vs an opponent at least N MMR above (params.diff: number). */
  win_vs_higher_mmr: (games, params) => {
    const diff = Number(params.diff) || 100;
    return firstId(
      games.filter((g) => {
        if (!isWin(g)) return false;
        const my = Number(g.myMmr);
        const op = oppMmr(g);
        return (
          Number.isFinite(my) &&
          Number.isFinite(op) &&
          op - my >= diff
        );
      }),
    );
  },
  /** Won a game where the opponent's MMR was within ±params.delta
   *  (defaults 50). Inclusive at the boundary — a delta-25 cell ticks
   *  when |op - my| is exactly 25. */
  win_close_mmr: (games, params) => {
    const delta = Math.max(0, Number(params.delta) || 50);
    return firstId(
      games.filter((g) => {
        if (!isWin(g)) return false;
        const my = Number(g.myMmr);
        const op = oppMmr(g);
        return (
          Number.isFinite(my) &&
          Number.isFinite(op) &&
          Math.abs(op - my) <= delta
        );
      }),
    );
  },
  /** Won N in a row anywhere in the window (params.n, default 3). */
  win_streak_n: (games, params) => {
    const n = Math.max(2, Number(params.n) || 3);
    let streak = 0;
    let lastId = null;
    for (const g of games) {
      const out = outcome(g);
      if (out === "W") {
        streak += 1;
        lastId = String(g.gameId);
        if (streak >= n) return lastId;
      } else if (out === "L") {
        streak = 0;
        lastId = null;
      }
    }
    return null;
  },
  /** Legacy alias kept for existing cards persisted under the old name. */
  three_in_a_row_win: (games) => PREDICATES.win_streak_n(games, { n: 3 }),
  /** Won a game shorter than params.maxSec seconds (strict <). */
  win_under_seconds: (games, params) => {
    const cap = Number(params.maxSec) || 360;
    return firstId(
      games.filter((g) => {
        if (!isWin(g)) return false;
        const d = durationOf(g);
        return Number.isFinite(d) && d > 0 && d < cap;
      }),
    );
  },
  /** Won a game at least params.minSec seconds long (inclusive). */
  win_over_seconds: (games, params) => {
    const min = Number(params.minSec) || 1500;
    return firstId(
      games.filter((g) => {
        if (!isWin(g)) return false;
        const d = durationOf(g);
        return Number.isFinite(d) && d >= min;
      }),
    );
  },
  /** Won a game with duration in [minSec, maxSec). Half-open interval —
   *  the upper bound is exclusive so consecutive range cells (e.g. "5–10
   *  min" and "10–15 min") don't both tick on the same 10:00 game.
   *  Empty / inverted params (max <= min) returns null. */
  win_between_seconds: (games, params) => {
    const min = Math.max(0, Number(params.minSec) || 0);
    const max = Number(params.maxSec);
    if (!Number.isFinite(max) || max <= min) return null;
    return firstId(
      games.filter((g) => {
        if (!isWin(g)) return false;
        const d = durationOf(g);
        return Number.isFinite(d) && d >= min && d < max;
      }),
    );
  },
  /** Won as race X in under params.maxSec seconds. */
  win_as_race_under: (games, params) => {
    const race = String(params.race || "").charAt(0).toUpperCase();
    const cap = Number(params.maxSec) || 360;
    return firstId(
      games.filter((g) => {
        if (!isWin(g)) return false;
        if (myRaceLetter(g) !== race) return false;
        const d = durationOf(g);
        return Number.isFinite(d) && d > 0 && d < cap;
      }),
    );
  },
  /** Won as race X in at least params.minSec seconds. */
  win_as_race_over: (games, params) => {
    const race = String(params.race || "").charAt(0).toUpperCase();
    const min = Number(params.minSec) || 900;
    return firstId(
      games.filter((g) => {
        if (!isWin(g)) return false;
        if (myRaceLetter(g) !== race) return false;
        const d = durationOf(g);
        return Number.isFinite(d) && d >= min;
      }),
    );
  },
  /** Won vs race X in under params.maxSec seconds. */
  win_vs_race_under: (games, params) => {
    const race = String(params.race || "").charAt(0).toUpperCase();
    const cap = Number(params.maxSec) || 360;
    return firstId(
      games.filter((g) => {
        if (!isWin(g)) return false;
        if (oppRaceLetter(g) !== race) return false;
        const d = durationOf(g);
        return Number.isFinite(d) && d > 0 && d < cap;
      }),
    );
  },
  /** Won vs race X in at least params.minSec seconds. */
  win_vs_race_over: (games, params) => {
    const race = String(params.race || "").charAt(0).toUpperCase();
    const min = Number(params.minSec) || 900;
    return firstId(
      games.filter((g) => {
        if (!isWin(g)) return false;
        if (oppRaceLetter(g) !== race) return false;
        const d = durationOf(g);
        return Number.isFinite(d) && d >= min;
      }),
    );
  },
  /** Hit a macroScore of at least params.minScore. Inclusive at the
   *  threshold — "70+" has to fire on exactly 70, not just 71. */
  macro_above: (games, params) => {
    const min = Number(params.minScore) || 70;
    return firstId(
      games.filter((g) => {
        const m = macroScoreOf(g);
        return Number.isFinite(m) && m >= min;
      }),
    );
  },
  /** Hit a macroScore at most params.maxScore on a WON game. */
  win_macro_below: (games, params) => {
    const cap = Number(params.maxScore) || 40;
    return firstId(
      games.filter((g) => {
        if (!isWin(g)) return false;
        const m = macroScoreOf(g);
        return Number.isFinite(m) && m <= cap;
      }),
    );
  },
  /** Won a game with apm at or above params.minApm. */
  win_apm_above: (games, params) => {
    const min = Number(params.minApm) || 200;
    return firstId(
      games.filter((g) => {
        if (!isWin(g)) return false;
        const a = apmOf(g);
        return Number.isFinite(a) && a >= min;
      }),
    );
  },
  /** Won a game whose ``myBuild`` strategy label contains a keyword
   *  (case-insensitive substring). e.g. "Cannon Rush" matches
   *  "Protoss - Cannon Rush". */
  win_build_contains: (games, params) => {
    const needle = String(params.keyword || "").toLowerCase().trim();
    if (!needle) return null;
    return firstId(
      games.filter(
        (g) => isWin(g) && myBuildOf(g).toLowerCase().includes(needle),
      ),
    );
  },
  /** Won a game where the OPPONENT's strategy contains a keyword.
   *  Retained for back-compat with persisted cards minted before the
   *  May-2026 candidate-list overhaul — the generator no longer adds
   *  these (the agent's opponent-strategy classifier doesn't emit a
   *  stable taxonomy for the keywords this used: Cheese / Proxy /
   *  All-in / Rush, so the cells were effectively unwinnable). The
   *  legacy detector in bingoLadder.tsx auto-regenerates any saved
   *  card carrying these cells. */
  win_vs_strategy_contains: (games, params) => {
    const needle = String(params.keyword || "").toLowerCase().trim();
    if (!needle) return null;
    return firstId(
      games.filter(
        (g) => isWin(g) && oppStrategyOf(g).toLowerCase().includes(needle),
      ),
    );
  },
  /** Played at least params.n games in the window. */
  play_n_games: (games, params) => {
    const n = Math.max(1, Number(params.n) || 5);
    if (games.length < n) return null;
    return String(games[n - 1].gameId);
  },
  /** Won at least params.n games in the window. */
  win_n_games: (games, params) => {
    const n = Math.max(1, Number(params.n) || 5);
    const wins = games.filter(isWin);
    if (wins.length < n) return null;
    return String(wins[n - 1].gameId);
  },
  /** Won the game immediately after a loss (revenge tilt). */
  win_after_loss: (games) => {
    let lastWasLoss = false;
    for (const g of games) {
      const out = outcome(g);
      if (out === "W" && lastWasLoss) return String(g.gameId);
      if (out === "W") lastWasLoss = false;
      else if (out === "L") lastWasLoss = true;
    }
    return null;
  },
  /** Won against an opponent (by ``oppPulseId``) that previously beat
   *  the user inside this same window. */
  revenge_win: (games) => {
    /** @type {Set<string>} */
    const owed = new Set();
    for (const g of games) {
      const id = pulseIdOf(g);
      if (!id) continue;
      const out = outcome(g);
      if (out === "L") owed.add(id);
      else if (out === "W" && owed.has(id)) return String(g.gameId);
    }
    return null;
  },
  /** Won a game within an active "session" (4-hour inactivity bound)
   *  that already contained at least params.minWinsBefore wins. */
  win_in_long_session: (games, params) => {
    const need = Math.max(1, Number(params.minWinsBefore) || 2);
    const FOUR_HOURS = 4 * 60 * 60 * 1000;
    let sessionStart = -1;
    let lastTs = -1;
    let winsInSession = 0;
    for (const g of games) {
      const ts = new Date(g.date).getTime();
      if (!Number.isFinite(ts)) continue;
      if (lastTs > 0 && ts - lastTs >= FOUR_HOURS) {
        winsInSession = 0;
        sessionStart = ts;
      }
      if (sessionStart < 0) sessionStart = ts;
      const out = outcome(g);
      if (out === "W") {
        if (winsInSession >= need) return String(g.gameId);
        winsInSession += 1;
      }
      lastTs = ts;
    }
    return null;
  },
  /** ── HEAVY PREDICATES (need game_details) ── */
  /** Won a game whose own build-log contains a unit/structure name. */
  won_with_unit: (games, params) => {
    const needle = String(params.unit || "").toLowerCase().trim();
    if (!needle) return null;
    return firstId(
      games.filter((g) => isWin(g) && buildLogContains(g.buildLog, needle)),
    );
  },
  /** Won a game whose own build-log mentions a unit at least
   *  params.count times. */
  won_built_n_of_unit: (games, params) => {
    const needle = String(params.unit || "").toLowerCase().trim();
    const need = Math.max(1, Number(params.count) || 1);
    if (!needle) return null;
    return firstId(
      games.filter(
        (g) => isWin(g) && buildLogCount(g.buildLog, needle) >= need,
      ),
    );
  },
  /** Built ≥ params.count of params.unit across the entire window —
   *  wins AND losses count. Returns the gameId of the game on which
   *  the running total first crossed the threshold. */
  built_n_of_unit_week: (games, params) => {
    const needle = String(params.unit || "").toLowerCase().trim();
    const need = Math.max(1, Number(params.count) || 1);
    if (!needle) return null;
    let running = 0;
    for (const g of games) {
      running += buildLogCount(g.buildLog, needle);
      if (running >= need) return String(g.gameId);
    }
    return null;
  },
  /** Won a game where the OPPONENT's build-log contained a unit. */
  won_built_opp_unit_seen: (games, params) => {
    const needle = String(params.unit || "").toLowerCase().trim();
    if (!needle) return null;
    return firstId(
      games.filter(
        (g) => isWin(g) && buildLogContains(g.oppBuildLog, needle),
      ),
    );
  },
};

module.exports = {
  PREDICATES,
  HEAVY_PREDICATES,
  HEAVY_FIELDS,
  isoWeekStart,
  // Helpers exported for unit tests + the unitStats path in arcade.js.
  durationOf,
  macroScoreOf,
  apmOf,
  myRaceLetter,
  oppRaceLetter,
  myBuildOf,
  oppStrategyOf,
  oppMmr,
  pulseIdOf,
  buildLogContains,
  buildLogCount,
  outcome,
  isWin,
};
