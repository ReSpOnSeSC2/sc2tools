"use strict";

/**
 * DNA helpers — matchup-aware median timings + recency-weighted strategy
 * predictions. Mirrors the legacy
 * `reveal-sc2-opponent-main/stream-overlay-backend/analyzer.js` helpers
 * (`computeMatchupAwareMedianTimings`, `recencyWeightedStrategies`,
 * `_resolveMyRace`, `_resolveModalOppRace`) so the cloud profile view
 * shows the same DNA cards the legacy SPA shows.
 *
 * Cloud game documents store fields on the agent's normalised shape:
 *   { myRace, opponent: { race, strategy }, buildLog, oppBuildLog,
 *     myBuild, durationSec, result, map, date, gameId }
 *
 * Legacy code read snake_case fields from the on-disk meta DB. This
 * port translates between the two and exposes the same output shape
 * the SPA components consume.
 */

const TimingCatalog = require("./timingCatalog");
const { toStartSeconds } = require("./buildDurations");

const TIMING_LINE_RE = /^\[(\d+):(\d{2})\]\s+(\w+)/;
const TREND_ABS_SECONDS = 5.0;
const TREND_REL_FRACTION = 0.05;

/** @typedef {import("./timingCatalog").CatalogToken} CatalogToken */
/** @typedef {import("./timingCatalog").RaceKey} RaceKey */

/**
 * One first-occurrence observation of a catalog token in a single game.
 * Carried (newest-first) on `TokenTimingRow.samples` for the SPA's
 * per-token drill-down.
 *
 * @typedef {{
 *   seconds: number,
 *   display: string,
 *   date: string|Date,
 *   map: string,
 *   result: string,
 *   won: boolean,
 *   gameId: string|number|null,
 *   oppRace: RaceKey,
 *   myRace: RaceKey,
 * }} TimingSample
 */

/**
 * Aggregated timing row for one catalog token — the value shape of the
 * maps returned by `computeMatchupAwareMedianTimings` /
 * `computeMedianTimingsForMatchup` (keyed by token `internalName`).
 *
 * @typedef {{
 *   sampleCount: number,
 *   medianSeconds: number|null,
 *   medianDisplay: string,
 *   p25Seconds: number|null,
 *   p25Display: string,
 *   p75Seconds: number|null,
 *   p75Display: string,
 *   minSeconds: number|null,
 *   minDisplay: string,
 *   maxSeconds: number|null,
 *   maxDisplay: string,
 *   lastSeenSeconds: number|null,
 *   lastSeenDisplay: string,
 *   winRateWhenBuilt: number|null,
 *   trend: "unknown"|"stable"|"later"|"earlier",
 *   source: "build_log"|"opp_build_log",
 *   samples: TimingSample[],
 *   displayName: string,
 *   iconFile: string,
 * }} TokenTimingRow
 */

/** @param {number} sec @returns {string} */
function formatSeconds(sec) {
  const t = Math.max(0, Math.floor(sec));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** @param {number[]} arr @returns {number|null} */
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** @param {number[]} sortedAsc @param {number} p @returns {number|null} */
function percentileInclusive(sortedAsc, p) {
  const n = sortedAsc.length;
  if (n === 0) return null;
  if (n === 1) return sortedAsc[0];
  const rank = p * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const frac = rank - lo;
  return sortedAsc[lo] + frac * (sortedAsc[hi] - sortedAsc[lo]);
}

/** @param {number[]} secondsChrono @returns {"unknown"|"stable"|"later"|"earlier"} */
function computeTrend(secondsChrono) {
  const n = secondsChrono.length;
  if (n < 4) return "unknown";
  const mid = Math.floor(n / 2);
  // n >= 4 so both halves are non-empty — the medians cannot be null.
  const m1 = /** @type {number} */ (median(secondsChrono.slice(0, mid)));
  const m2 = /** @type {number} */ (median(secondsChrono.slice(mid)));
  const diff = m2 - m1;
  const threshold = Math.max(TREND_ABS_SECONDS, TREND_REL_FRACTION * (m1 || 0));
  if (Math.abs(diff) < threshold) return "stable";
  return diff > 0 ? "later" : "earlier";
}

/**
 * @param {CatalogToken} token
 * @param {"build_log"|"opp_build_log"} source
 * @returns {TokenTimingRow}
 */
function emptyTokenRow(token, source) {
  return {
    sampleCount: 0,
    medianSeconds: null,
    medianDisplay: "-",
    p25Seconds: null,
    p25Display: "-",
    p75Seconds: null,
    p75Display: "-",
    minSeconds: null,
    minDisplay: "-",
    maxSeconds: null,
    maxDisplay: "-",
    lastSeenSeconds: null,
    lastSeenDisplay: "-",
    winRateWhenBuilt: null,
    trend: "unknown",
    source,
    samples: [],
    displayName: token.displayName,
    iconFile: token.iconFile,
  };
}

/**
 * Read a build-log array off a game doc, tolerating both the cloud
 * camelCase and legacy snake_case field spellings. Callers runtime-check
 * the value with `Array.isArray` before use.
 *
 * @param {any} g
 * @param {string} key
 * @returns {unknown}
 */
function readBuildLog(g, key) {
  if (!g) return null;
  const cap = key.charAt(0).toUpperCase() + key.slice(1);
  // Cloud schema uses camelCase: `buildLog`, `oppBuildLog`, `oppEarlyBuildLog`.
  // Legacy SPA used snake_case: `build_log`, `opp_build_log`. Read both.
  const camelCase = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  return (
    g[camelCase] ||
    g[key] ||
    g[cap] ||
    g[key + "Log"] ||
    g[cap + "Log"] ||
    null
  );
}

/**
 * @param {unknown} log
 * @param {string} tokenSubstring
 * @returns {number|null}
 */
function firstOccurrenceSeconds(log, tokenSubstring) {
  if (!Array.isArray(log) || log.length === 0) return null;
  const tokLower = tokenSubstring.toLowerCase();
  let best = null;
  for (const line of log) {
    const m = TIMING_LINE_RE.exec(String(line || ""));
    if (!m) continue;
    const rawName = m[3];
    if (rawName.toLowerCase().indexOf(tokLower) === -1) continue;
    const recorded = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    // The timing catalog tokens are buildings; structures emitted via
    // ``UnitInitEvent`` (P/T) or ``UnitBornEvent`` (Z drone) already
    // carry start-of-construction times. Morphs (Lair/Hive/etc.) come
    // through as completion times, so ``toStartSeconds`` rewinds them.
    const sec = Math.round(
      toStartSeconds(rawName, recorded, { isBuilding: true }),
    );
    if (best === null || sec < best) best = sec;
  }
  return best;
}

/** @param {any} g @returns {RaceKey|""} */
function gameOppRace(g) {
  if (!g) return "";
  return TimingCatalog.normalizeRace(
    g.opp_race || (g.opponent && g.opponent.race) || g.oppRace || "",
  );
}

/** @param {any} g @returns {RaceKey|""} */
function gameMyRace(g) {
  if (!g) return "";
  return TimingCatalog.normalizeRace(g.myRace || g.my_race || "");
}

/** @param {any} g @returns {string|Date} cloud docs carry Mongo Dates, legacy rows strings */
function gameDate(g) {
  if (!g) return "";
  return g.date || g.Date || "";
}

/** @param {any} g @returns {string} */
function gameMap(g) {
  if (!g) return "";
  return g.map || g.Map || "";
}

/** @param {any} g @returns {string|number|null} */
function gameId(g) {
  if (!g) return null;
  return g.gameId || g.id || g.game_id || g.GameId || null;
}

/** @param {any} g @returns {string} */
function gameResult(g) {
  if (!g) return "";
  return g.result || g.Result || "";
}

/** @param {unknown} result @returns {boolean} */
function isWonResult(result) {
  return result === "Win" || result === "Victory";
}

/** @param {any} g @returns {string} */
function gameMyBuild(g) {
  if (!g) return "";
  return g.myBuild || g.my_build || g.build || "";
}

/** @param {any} g @returns {string} */
function gameOppStrategy(g) {
  if (!g) return "";
  return (g.opponent && g.opponent.strategy) || g.opp_strategy || "";
}

/** @param {any} g @returns {number} */
function gameDurationSec(g) {
  if (!g) return 0;
  const v = g.durationSec || g.game_length || g.GameLength || 0;
  return typeof v === "number" ? v : 0;
}

/** @param {any} g @returns {RaceKey|""} */
function resolveMyRaceFromGame(g) {
  if (!g) return "";
  const direct = gameMyRace(g);
  if (direct) return direct;
  const mu = g.Matchup || g.matchup || "";
  if (mu) {
    const head = String(mu).split(/[vV]/)[0].trim();
    if (head) {
      const r = TimingCatalog.normalizeRace(head);
      if (r) return r;
      const first = TimingCatalog.normalizeRace(head[0]);
      if (first) return first;
    }
  }
  for (const field of ["myBuild", "my_build", "build", "build_name"]) {
    const bn = String(g[field] || "");
    if (!bn) continue;
    if (/^zerg/i.test(bn)) return "Z";
    if (/^protoss/i.test(bn)) return "P";
    if (/^terran/i.test(bn)) return "T";
    const mhead = bn.split(/[vV]/)[0].trim();
    const r =
      TimingCatalog.normalizeRace(mhead) ||
      TimingCatalog.normalizeRace(mhead[0] || "");
    if (r) return r;
  }
  return "";
}

/** @param {Array<any>} games @returns {string} "Z" | "P" | "T", or "" when unresolvable */
function resolveMyRace(games) {
  if (!games || games.length === 0) return "";
  for (const g of games) {
    const r = resolveMyRaceFromGame(g);
    if (r) return r;
  }
  /** @type {Record<string, number>} */
  const c = Object.create(null);
  for (const g of games) {
    const r = resolveMyRaceFromGame(g);
    if (r) c[r] = (c[r] || 0) + 1;
  }
  let best = "";
  let bestN = -1;
  for (const r of Object.keys(c)) {
    if (c[r] > bestN) {
      bestN = c[r];
      best = r;
    }
  }
  return best;
}

/** @param {Array<any>} games @returns {string} "Z" | "P" | "T", or "" when unresolvable */
function resolveModalOppRace(games) {
  if (!games || games.length === 0) return "";
  /** @type {Record<string, number>} */
  const c = Object.create(null);
  for (const g of games) {
    const r = gameOppRace(g);
    if (r) c[r] = (c[r] || 0) + 1;
  }
  let best = "";
  let bestN = -1;
  for (const r of Object.keys(c)) {
    if (c[r] > bestN) {
      bestN = c[r];
      best = r;
    }
  }
  return best;
}

/**
 * Compute matchup-aware median first-occurrence timings.
 *
 * @param {Array<any>} games — newest-first list of game records
 * @param {string} myRace — the user's race ("P" | "T" | "Z" | "")
 * @returns {Record<string, TokenTimingRow>} keyed by token internalName
 */
function computeMatchupAwareMedianTimings(games, myRace) {
  const my = TimingCatalog.normalizeRace(myRace);
  if (!my) return {};
  const list = games || [];
  const modalOpp = pickModalOppRace(list);
  const ownInternalSet = new Set(
    TimingCatalog.RACE_BUILDINGS[my].map((t) => t.internalName),
  );
  if (!modalOpp) {
    /** @type {Record<string, TokenTimingRow>} */
    const out = {};
    for (const tk of TimingCatalog.RACE_BUILDINGS[my]) {
      out[tk.internalName] = emptyTokenRow(
        tk,
        ownInternalSet.has(tk.internalName) ? "build_log" : "opp_build_log",
      );
    }
    return out;
  }
  const ordering = TimingCatalog.relevantTokens(my, modalOpp);
  if (ordering.length === 0) return {};
  /** @type {Record<string, TimingSample[]|undefined>} */
  const samples = Object.create(null);
  for (const tk of ordering) samples[tk.internalName] = [];
  for (const g of list) {
    collectSamples(g, samples, ownInternalSet, my);
  }
  return finaliseSamples(samples, ordering, ownInternalSet);
}

/** @param {Array<any>} list @returns {string} modal opponent race, or "" when none known */
function pickModalOppRace(list) {
  /** @type {Record<string, number>} */
  const oppCount = Object.create(null);
  for (const g of list) {
    const r = gameOppRace(g);
    if (r) oppCount[r] = (oppCount[r] || 0) + 1;
  }
  let modalOpp = "";
  let modalCount = -1;
  for (const r of Object.keys(oppCount)) {
    if (oppCount[r] > modalCount) {
      modalCount = oppCount[r];
      modalOpp = r;
    }
  }
  return modalOpp;
}

/**
 * @param {any} g
 * @param {Record<string, TimingSample[]|undefined>} samples keyed by
 *   token internalName; tokens outside the pre-seeded ordering are skipped
 * @param {Set<string>} ownInternalSet
 * @param {RaceKey} my
 */
function collectSamples(g, samples, ownInternalSet, my) {
  const oppRace = gameOppRace(g);
  if (!oppRace) return;
  const eligible = TimingCatalog.relevantTokens(my, oppRace);
  if (eligible.length === 0) return;
  const myLog = readBuildLog(g, "build_log");
  const oppLog = readBuildLog(g, "opp_build_log");
  const result = gameResult(g);
  const meta = {
    date: gameDate(g),
    map: gameMap(g),
    result: result || "",
    won: isWonResult(result),
    gameId: gameId(g),
    oppRace,
    myRace: my,
  };
  for (const tk of eligible) {
    if (samples[tk.internalName] === undefined) continue;
    const log = ownInternalSet.has(tk.internalName) ? myLog : oppLog;
    const sec = firstOccurrenceSeconds(log, tk.token);
    if (sec === null) continue;
    // Non-null: the `=== undefined` guard above already skipped
    // tokens missing from the pre-seeded map.
    /** @type {TimingSample[]} */ (samples[tk.internalName]).push({
      seconds: sec,
      display: formatSeconds(sec),
      ...meta,
    });
  }
}

/**
 * @param {Record<string, TimingSample[]|undefined>} samples
 * @param {CatalogToken[]} ordering
 * @param {Set<string>} ownInternalSet
 * @returns {Record<string, TokenTimingRow>}
 */
function finaliseSamples(samples, ordering, ownInternalSet) {
  /** @type {Record<string, TokenTimingRow>} */
  const out = {};
  for (const tk of ordering) {
    const source = ownInternalSet.has(tk.internalName)
      ? "build_log"
      : "opp_build_log";
    const list2 = samples[tk.internalName];
    if (!list2 || list2.length === 0) {
      out[tk.internalName] = emptyTokenRow(tk, source);
      continue;
    }
    list2.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const secondsList = list2.map((s) => s.seconds);
    const sortedAsc = [...secondsList].sort((a, b) => a - b);
    const n = secondsList.length;
    // list2 is non-empty on this path, so median / percentile cannot
    // return null.
    const med = /** @type {number} */ (median(secondsList));
    const p25 = Math.round(
      /** @type {number} */ (percentileInclusive(sortedAsc, 0.25)),
    );
    const p75 = Math.round(
      /** @type {number} */ (percentileInclusive(sortedAsc, 0.75)),
    );
    const mn = sortedAsc[0];
    const mx = sortedAsc[n - 1];
    const lastSeen = list2[list2.length - 1].seconds;
    const winsCount = list2.reduce((a, s) => a + (s.won ? 1 : 0), 0);

    out[tk.internalName] = {
      sampleCount: n,
      medianSeconds: med,
      medianDisplay: formatSeconds(med),
      p25Seconds: p25,
      p25Display: formatSeconds(p25),
      p75Seconds: p75,
      p75Display: formatSeconds(p75),
      minSeconds: mn,
      minDisplay: formatSeconds(mn),
      maxSeconds: mx,
      maxDisplay: formatSeconds(mx),
      lastSeenSeconds: lastSeen,
      lastSeenDisplay: formatSeconds(lastSeen),
      winRateWhenBuilt: winsCount / n,
      trend: computeTrend(secondsList),
      source,
      samples: list2.slice().reverse(),
      displayName: tk.displayName,
      iconFile: tk.iconFile,
    };
  }
  return out;
}

/**
 * Same as `computeMatchupAwareMedianTimings` but pinned to one opponent
 * race instead of the modal one.
 *
 * @param {Array<any>} games — newest-first list of game records
 * @param {string} myRace
 * @param {string} oppRace
 * @returns {Record<string, TokenTimingRow>} keyed by token internalName
 */
function computeMedianTimingsForMatchup(games, myRace, oppRace) {
  const my = TimingCatalog.normalizeRace(myRace);
  const opp = TimingCatalog.normalizeRace(oppRace);
  if (!my) return {};
  if (!opp) return computeMatchupAwareMedianTimings(games, myRace);
  const filtered = (games || []).filter((g) => gameOppRace(g) === opp);
  if (filtered.length === 0) {
    /** @type {Record<string, TokenTimingRow>} */
    const out = {};
    const ownInternalSet = new Set(
      TimingCatalog.RACE_BUILDINGS[my].map((t) => t.internalName),
    );
    const ordering = TimingCatalog.relevantTokens(my, opp);
    for (const tk of ordering) {
      const source = ownInternalSet.has(tk.internalName)
        ? "build_log"
        : "opp_build_log";
      out[tk.internalName] = emptyTokenRow(tk, source);
    }
    return out;
  }
  return computeMatchupAwareMedianTimings(filtered, myRace);
}

/**
 * Recency-weighted distribution over `opponent.strategy`.
 * Last 10 games count 2x, every other game 1x. `games` must already
 * be in newest-first order.
 *
 * @param {Array<object>} games
 * @returns {Array<{strategy: string, probability: number}>}
 */
function recencyWeightedStrategies(games) {
  if (!games || games.length === 0) return [];
  const weighted = new Map();
  let totalW = 0;
  for (let i = 0; i < games.length; i++) {
    const w = i < 10 ? 2.0 : 1.0;
    const s = gameOppStrategy(games[i]) || "Unknown";
    weighted.set(s, (weighted.get(s) || 0) + w);
    totalW += w;
  }
  if (totalW <= 0) return [];
  return [...weighted.entries()]
    .map(([strategy, w]) => ({ strategy, probability: w / totalW }))
    .sort((a, b) => b.probability - a.probability);
}

/**
 * Top-N strategies sorted by total games. Mirrors the legacy
 * `topStrategies` field consumed by `StrategyTendencyChart`.
 *
 * @param {Record<string, {wins: number, losses: number}>} byStrategy
 * @param {number} [limit=5]
 */
function topStrategiesFromBy(byStrategy, limit = 5) {
  return Object.entries(byStrategy || {})
    .map(([name, v]) => {
      const tot = (v.wins || 0) + (v.losses || 0);
      return {
        strategy: name,
        wins: v.wins || 0,
        losses: v.losses || 0,
        count: tot,
        winRate: tot ? v.wins / tot : 0,
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

module.exports = {
  formatSeconds,
  median,
  percentileInclusive,
  computeTrend,
  emptyTokenRow,
  readBuildLog,
  firstOccurrenceSeconds,
  computeMatchupAwareMedianTimings,
  computeMedianTimingsForMatchup,
  recencyWeightedStrategies,
  topStrategiesFromBy,
  resolveMyRace,
  resolveModalOppRace,
  gameOppRace,
  gameMyBuild,
  gameOppStrategy,
  gameDate,
  gameMap,
  gameId,
  gameResult,
  gameDurationSec,
  isWonResult,
};
