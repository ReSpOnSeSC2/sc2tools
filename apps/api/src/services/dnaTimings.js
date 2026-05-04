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

const TIMING_LINE_RE = /^\[(\d+):(\d{2})\]\s+(\w+)/;
const TREND_ABS_SECONDS = 5.0;
const TREND_REL_FRACTION = 0.05;

function formatSeconds(sec) {
  const t = Math.max(0, Math.floor(sec));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

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

function computeTrend(secondsChrono) {
  const n = secondsChrono.length;
  if (n < 4) return "unknown";
  const mid = Math.floor(n / 2);
  const m1 = median(secondsChrono.slice(0, mid));
  const m2 = median(secondsChrono.slice(mid));
  const diff = m2 - m1;
  const threshold = Math.max(TREND_ABS_SECONDS, TREND_REL_FRACTION * (m1 || 0));
  if (Math.abs(diff) < threshold) return "stable";
  return diff > 0 ? "later" : "earlier";
}

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

function firstOccurrenceSeconds(log, tokenSubstring) {
  if (!Array.isArray(log) || log.length === 0) return null;
  const tokLower = tokenSubstring.toLowerCase();
  let best = null;
  for (const line of log) {
    const m = TIMING_LINE_RE.exec(String(line || ""));
    if (!m) continue;
    const name = m[3].toLowerCase();
    if (name.indexOf(tokLower) === -1) continue;
    const sec = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    if (best === null || sec < best) best = sec;
  }
  return best;
}

function gameOppRace(g) {
  if (!g) return "";
  return TimingCatalog.normalizeRace(
    g.opp_race || (g.opponent && g.opponent.race) || g.oppRace || "",
  );
}

function gameMyRace(g) {
  if (!g) return "";
  return TimingCatalog.normalizeRace(g.myRace || g.my_race || "");
}

function gameDate(g) {
  if (!g) return "";
  return g.date || g.Date || "";
}

function gameMap(g) {
  if (!g) return "";
  return g.map || g.Map || "";
}

function gameId(g) {
  if (!g) return null;
  return g.gameId || g.id || g.game_id || g.GameId || null;
}

function gameResult(g) {
  if (!g) return "";
  return g.result || g.Result || "";
}

function isWonResult(result) {
  return result === "Win" || result === "Victory";
}

function gameMyBuild(g) {
  if (!g) return "";
  return g.myBuild || g.my_build || g.build || "";
}

function gameOppStrategy(g) {
  if (!g) return "";
  return (g.opponent && g.opponent.strategy) || g.opp_strategy || "";
}

function gameDurationSec(g) {
  if (!g) return 0;
  const v = g.durationSec || g.game_length || g.GameLength || 0;
  return typeof v === "number" ? v : 0;
}

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

function resolveMyRace(games) {
  if (!games || games.length === 0) return "";
  for (const g of games) {
    const r = resolveMyRaceFromGame(g);
    if (r) return r;
  }
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

function resolveModalOppRace(games) {
  if (!games || games.length === 0) return "";
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
 * @param {Array<object>} games — newest-first list of game records
 * @param {string} myRace — the user's race ("P" | "T" | "Z" | "")
 * @returns {Record<string, object>}
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
  const samples = Object.create(null);
  for (const tk of ordering) samples[tk.internalName] = [];
  for (const g of list) {
    collectSamples(g, samples, ownInternalSet, my);
  }
  return finaliseSamples(samples, ordering, ownInternalSet);
}

function pickModalOppRace(list) {
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
    samples[tk.internalName].push({
      seconds: sec,
      display: formatSeconds(sec),
      ...meta,
    });
  }
}

function finaliseSamples(samples, ordering, ownInternalSet) {
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
    const med = median(secondsList);
    const p25 = Math.round(percentileInclusive(sortedAsc, 0.25));
    const p75 = Math.round(percentileInclusive(sortedAsc, 0.75));
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

function computeMedianTimingsForMatchup(games, myRace, oppRace) {
  const my = TimingCatalog.normalizeRace(myRace);
  const opp = TimingCatalog.normalizeRace(oppRace);
  if (!my) return {};
  if (!opp) return computeMatchupAwareMedianTimings(games, myRace);
  const filtered = (games || []).filter((g) => gameOppRace(g) === opp);
  if (filtered.length === 0) {
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
