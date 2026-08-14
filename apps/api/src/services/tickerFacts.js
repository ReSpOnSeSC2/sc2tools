"use strict";

const { regionFromToonHandle } = require("../util/regionFromToonHandle");

/**
 * TickerFactsService — computes the stats-ticker's "fun facts" pool:
 * career records, all-time bests, matchup splits, map/build/opponent
 * trivia, milestone watches, and recent form, all derived from the
 * user's real games collection. The overlay's stats-ticker widget
 * rotates through the pool between its live segments.
 *
 * Design constraints:
 *   * Real data only. Every fact carries a minimum sample size —
 *     better to emit 6 facts for a new account than 30 misleading
 *     ones. A brand-new account gets an empty pool and the ticker
 *     simply shows its live segments.
 *   * Cheap at the edge. The full compute is one light-projection
 *     scan plus one $group aggregation, then cached per user for
 *     CACHE_TTL_MS — overlay Browser Sources refetching every few
 *     minutes hit the cache, not Mongo.
 *   * MMR facts are region-aware, matching the session widget's
 *     cross-region guard: peak/30-day-MMR facts only read games on
 *     the ladder the user played most recently, so an EU⇄NA switcher
 *     never sees a "peak" that mixes two independent ratings.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_USERS = 500;
/** Hard bound on the light-projection scan. 20k games ≈ a decade of
 *  heavy laddering; the newest rows win when someone exceeds it. */
const MAX_ROWS = 20000;

/** Barcode-style names ("IIlIlIII…") collide across distinct players,
 *  so per-opponent-name facts (nemesis, most-faced) exclude them. */
const BARCODE_RE = /^[Il|]{4,}$/;

class TickerFactsService {
  /**
   * @param {{games: import('mongodb').Collection}} db
   * @param {{
   *   now?: () => number,
   *   skillFingerprint?: {compute: (userId: string, args: {matchup: string}) => Promise<any>},
   *   arcade?: {unitStats: (userId: string) => Promise<any>},
   *   seasons?: {list: () => Promise<any>},
   * }} [deps]
   */
  constructor(db, deps = {}) {
    this.db = db;
    this.now = deps.now || Date.now;
    this.skillFingerprint = deps.skillFingerprint || null;
    this.arcade = deps.arcade || null;
    this.seasons = deps.seasons || null;
    /** @type {Map<string, {atMs: number, facts: Array<{id: string, text: string}>}>} */
    this._cache = new Map();
  }

  /**
   * Cached facts pool for one user. Shape: `[{id, text}]`, ordered
   * roughly by interest so a client that truncates keeps the best.
   *
   * @param {string} userId
   * @returns {Promise<Array<{id: string, text: string}>>}
   */
  async factsFor(userId) {
    const cached = this._cache.get(userId);
    if (cached && this.now() - cached.atMs < CACHE_TTL_MS) {
      return cached.facts;
    }
    const facts = await this._compute(userId);
    // Refresh insert order so the size cap below evicts the stalest.
    this._cache.delete(userId);
    this._cache.set(userId, { atMs: this.now(), facts });
    if (this._cache.size > CACHE_MAX_USERS) {
      const oldest = this._cache.keys().next().value;
      if (oldest !== undefined) this._cache.delete(oldest);
    }
    return facts;
  }

  /**
   * @param {string} userId
   * @returns {Promise<Array<{id: string, text: string}>>}
   */
  async _compute(userId) {
    /** @type {Array<Record<string, any>>} */
    let rows = [];
    try {
      rows = await this.db.games
        .find(
          { userId, isResumedFromReplay: { $ne: true } },
          {
            projection: {
              _id: 0,
              date: 1,
              result: 1,
              myRace: 1,
              myBuild: 1,
              map: 1,
              durationSec: 1,
              apm: 1,
              spq: 1,
              macroScore: 1,
              myMmr: 1,
              myToonHandle: 1,
              playerCount: 1,
              "opponent.displayName": 1,
              "opponent.race": 1,
              "opponent.mmr": 1,
              "opponent.toonHandle": 1,
            },
          },
        )
        .sort({ date: -1 })
        .limit(MAX_ROWS)
        .toArray();
    } catch {
      return [];
    }

    // Normalise into chronological order with parsed fields; drop
    // team games (playerCount > 2) — every fact here is 1v1-shaped.
    /**
     * @type {Array<{
     *   ts: number, win: boolean, loss: boolean, myRace: string,
     *   myBuild: string, map: string, durationSec: number|null,
     *   apm: number|null, spq: number|null, macroScore: number|null,
     *   myMmr: number|null, region: string|null,
     *   oppName: string, oppRace: string, oppMmr: number|null,
     * }>}
     */
    const games = [];
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      const d = row.date instanceof Date ? row.date : new Date(row.date);
      if (Number.isNaN(d.getTime())) continue;
      if (Number.isFinite(Number(row.playerCount)) && Number(row.playerCount) > 2) {
        continue;
      }
      const res = String(row.result || "").toLowerCase();
      const opp = row.opponent || {};
      games.push({
        ts: d.getTime(),
        win: res === "victory" || res === "win",
        loss: res === "defeat" || res === "loss",
        myRace: String(row.myRace || ""),
        myBuild: String(row.myBuild || ""),
        map: String(row.map || ""),
        durationSec: Number.isFinite(Number(row.durationSec))
          ? Number(row.durationSec)
          : null,
        apm: Number.isFinite(Number(row.apm)) ? Number(row.apm) : null,
        spq: Number.isFinite(Number(row.spq)) ? Number(row.spq) : null,
        macroScore: Number.isFinite(Number(row.macroScore))
          ? Number(row.macroScore)
          : null,
        myMmr: Number.isFinite(Number(row.myMmr)) ? Number(row.myMmr) : null,
        region:
          (typeof row.myToonHandle === "string"
            ? regionFromToonHandle(row.myToonHandle)
            : null) ||
          (typeof opp.toonHandle === "string"
            ? regionFromToonHandle(opp.toonHandle)
            : null) ||
          null,
        oppName: String(opp.displayName || ""),
        oppRace: String(opp.race || ""),
        oppMmr: Number.isFinite(Number(opp.mmr)) ? Number(opp.mmr) : null,
      });
    }
    if (games.length === 0) return [];

    /** @type {Array<{id: string, text: string}>} */
    const facts = [];
    /** @type {(id: string, text: string|null|undefined) => void} */
    const add = (id, text) => {
      if (typeof text === "string" && text.length > 0) facts.push({ id, text });
    };

    const wins = games.filter((g) => g.win).length;
    const losses = games.filter((g) => g.loss).length;
    const decided = wins + losses;
    const total = games.length;

    // ── Career headline ──
    if (decided >= 10) {
      add(
        "career-record",
        `CAREER: ${fmtInt(wins)} W – ${fmtInt(losses)} L (${pct(wins, decided)}%) over ${fmtInt(total)} tracked games`,
      );
    }

    // ── Total in-game time ──
    const totalSec = games.reduce((acc, g) => acc + (g.durationSec ?? 0), 0);
    if (totalSec >= 10 * 3600) {
      const hours = totalSec / 3600;
      const days = hours / 24;
      add(
        "career-hours",
        `TIME IN GAME: ${fmtInt(Math.round(hours))} hrs — ${days >= 2 ? `${days.toFixed(1)} days` : `${Math.round(hours)} hours`} in the Koprulu sector`,
      );
    }

    // ── Tracking since ──
    if (total >= 25) {
      add(
        "tracking-since",
        `TRACKING SINCE ${fmtMonthYear(games[0].ts)} · ${fmtInt(total)} games logged`,
      );
    }

    // ── Region-aware MMR facts (same guard as the session widget) ──
    const currentRegion = (() => {
      for (let i = games.length - 1; i >= 0; i -= 1) {
        if (games[i].region) return games[i].region;
      }
      return null;
    })();
    const mmrGames = games.filter(
      (g) =>
        g.myMmr !== null &&
        (currentRegion === null ? true : g.region === currentRegion),
    );
    if (mmrGames.length >= 10) {
      let peak = mmrGames[0];
      for (const g of mmrGames) if ((g.myMmr ?? 0) > (peak.myMmr ?? 0)) peak = g;
      const latest = mmrGames[mmrGames.length - 1];
      add(
        "peak-mmr",
        `PEAK MMR: ${fmtInt(peak.myMmr ?? 0)}${currentRegion ? ` on ${currentRegion}` : ""} (${fmtShortDate(peak.ts)})` +
          (latest.myMmr !== null && latest.myMmr < (peak.myMmr ?? 0)
            ? ` — ${fmtInt((peak.myMmr ?? 0) - latest.myMmr)} away right now`
            : " — sitting at the summit"),
      );
      const cutoff30 = this.now() - 30 * 24 * 3600 * 1000;
      const last30 = mmrGames.filter((g) => g.ts >= cutoff30);
      if (last30.length >= 5) {
        const delta = (last30[last30.length - 1].myMmr ?? 0) - (last30[0].myMmr ?? 0);
        add(
          "mmr-30d",
          `LAST 30 DAYS: ${delta >= 0 ? "+" : ""}${fmtInt(delta)} MMR over ${fmtInt(last30.length)} rated games`,
        );
      }
      // Biggest scalp — highest-MMR opponent ever beaten.
      const scalps = games.filter(
        (g) =>
          g.win &&
          g.oppMmr !== null &&
          (currentRegion === null ? true : g.region === currentRegion),
      );
      if (scalps.length >= 10) {
        let best = scalps[0];
        for (const g of scalps) if ((g.oppMmr ?? 0) > (best.oppMmr ?? 0)) best = g;
        add(
          "biggest-scalp",
          `BIGGEST SCALP: beat a ${fmtInt(best.oppMmr ?? 0)} MMR opponent${best.oppName && !BARCODE_RE.test(best.oppName) ? ` (${best.oppName})` : ""} — ${fmtShortDate(best.ts)}`,
        );
      }
    }

    // ── Longest win streak ever ──
    {
      let best = 0;
      let bestEndTs = 0;
      let run = 0;
      for (const g of games) {
        if (g.win) {
          run += 1;
          if (run > best) {
            best = run;
            bestEndTs = g.ts;
          }
        } else if (g.loss) {
          run = 0;
        }
      }
      if (best >= 5) {
        add(
          "longest-streak",
          `LONGEST WIN STREAK: ${best} in a row (${fmtShortDate(bestEndTs)})`,
        );
      }
    }

    // ── Matchup split (career, from the user's dominant race) ──
    {
      const mainRace = dominantRace(games);
      if (mainRace) {
        const letter = mainRace[0].toUpperCase();
        const parts = [];
        for (const oppRace of ["Terran", "Zerg", "Protoss"]) {
          const sub = games.filter(
            (g) =>
              g.myRace.toLowerCase() === mainRace.toLowerCase() &&
              g.oppRace.toLowerCase() === oppRace.toLowerCase() &&
              (g.win || g.loss),
          );
          const w = sub.filter((g) => g.win).length;
          if (sub.length >= 20) {
            parts.push(`${letter}v${oppRace[0]} ${pct(w, sub.length)}%`);
          }
        }
        if (parts.length >= 2) {
          add("matchups", `CAREER MATCHUPS: ${parts.join(" · ")}`);
        }
      }
    }

    // ── Maps ──
    {
      const byMap = groupBy(
        games.filter((g) => g.map && (g.win || g.loss)),
        (g) => g.map,
      );
      let most = null;
      for (const [map, list] of byMap) {
        if (!most || list.length > most.list.length) most = { map, list };
      }
      if (most && most.list.length >= 15) {
        const w = most.list.filter((g) => g.win).length;
        add(
          "most-played-map",
          `MOST-PLAYED MAP: ${most.map} — ${fmtInt(most.list.length)} games, ${pct(w, most.list.length)}% wins`,
        );
      }
      let bestMap = null;
      for (const [map, list] of byMap) {
        if (list.length < 10) continue;
        const rate = list.filter((g) => g.win).length / list.length;
        if (!bestMap || rate > bestMap.rate) bestMap = { map, list, rate };
      }
      if (bestMap && (!most || bestMap.map !== most.map) && bestMap.rate >= 0.55) {
        add(
          "best-map",
          `HAPPY HUNTING GROUND: ${bestMap.map} — ${pct(bestMap.list.filter((g) => g.win).length, bestMap.list.length)}% over ${fmtInt(bestMap.list.length)} games`,
        );
      }
    }

    // ── Duration records ──
    {
      const timed = games.filter((g) => (g.durationSec ?? 0) >= 60);
      let longest = null;
      for (const g of timed) {
        if (!longest || (g.durationSec ?? 0) > (longest.durationSec ?? 0))

          longest = g;
      }
      if (longest && (longest.durationSec ?? 0) >= 25 * 60) {
        add(
          "longest-game",
          `LONGEST GAME EVER: ${fmtDur(longest.durationSec ?? 0)}${longest.map ? ` on ${longest.map}` : ""} — a ${longest.win ? "WIN" : longest.loss ? "LOSS" : "TIE"}`,
        );
      }
      let fastestWin = null;
      for (const g of timed) {
        if (!g.win) continue;
        if (!fastestWin || (g.durationSec ?? 0) < (fastestWin.durationSec ?? 0))
          fastestWin = g;
      }
      if (fastestWin && (fastestWin.durationSec ?? 0) <= 7 * 60) {
        add(
          "fastest-win",
          `FASTEST WIN: ${fmtDur(fastestWin.durationSec ?? 0)}${fastestWin.map ? ` on ${fastestWin.map}` : ""} — gg go next`,
        );
      }
      if (timed.length >= 20) {
        const avg = timed.reduce((a, g) => a + (g.durationSec ?? 0), 0) / timed.length;
        add("avg-length", `AVERAGE GAME: ${fmtDur(Math.round(avg))}`);
      }
      // Short-game vs macro-game splits.
      const rush = timed.filter((g) => (g.durationSec ?? 0) < 6 * 60 && (g.win || g.loss));
      if (rush.length >= 10) {
        const w = rush.filter((g) => g.win).length;
        const rate = pct(w, rush.length);
        add(
          "rush-defense",
          `GAMES UNDER 6:00: ${rate}% win rate — ${Number(rate) >= 50 ? "cheese gets punished here" : "the danger zone"}`,
        );
      }
      const macro = timed.filter((g) => (g.durationSec ?? 0) >= 20 * 60 && (g.win || g.loss));
      if (macro.length >= 10) {
        const w = macro.filter((g) => g.win).length;
        add(
          "macro-games",
          `MACRO GAMES (20:00+): ${pct(w, macro.length)}% wins over ${fmtInt(macro.length)}`,
        );
      }
    }

    // ── Opponents ──
    {
      const named = games.filter(
        (g) =>
          g.oppName &&
          g.oppName.length >= 2 &&
          !BARCODE_RE.test(g.oppName) &&
          (g.win || g.loss),
      );
      const byOpp = groupBy(named, (g) => g.oppName);
      let mostFaced = null;
      for (const [name, list] of byOpp) {
        if (!mostFaced || list.length > mostFaced.list.length)
          mostFaced = { name, list };
      }
      if (mostFaced && mostFaced.list.length >= 6) {
        const w = mostFaced.list.filter((g) => g.win).length;
        add(
          "most-faced",
          `MOST-FACED OPPONENT: ${mostFaced.name} — ${fmtInt(mostFaced.list.length)} meetings (${w}–${mostFaced.list.length - w})`,
        );
      }
      let nemesis = null;
      for (const [name, list] of byOpp) {
        if (list.length < 5) continue;
        const l = list.filter((g) => g.loss).length;
        const w = list.length - l;
        if (l > w && (!nemesis || l - w > nemesis.margin)) {
          nemesis = { name, w, l, margin: l - w };
        }
      }
      if (nemesis) {
        add(
          "nemesis",
          `NEMESIS: ${nemesis.name} — ${nemesis.w}–${nemesis.l} lifetime · the villain arc continues`,
        );
      }
      let victim = null;
      for (const [name, list] of byOpp) {
        if (list.length < 5) continue;
        const w = list.filter((g) => g.win).length;
        const l = list.length - w;
        if (w > l && (!victim || w - l > victim.margin)) {
          victim = { name, w, l, margin: w - l };
        }
      }
      if (victim && (!nemesis || victim.name !== nemesis.name)) {
        add(
          "favorite-victim",
          `FAVORITE MATCHUP: ${victim.name} — ${victim.w}–${victim.l} lifetime`,
        );
      }
      const uniqueOpponents = new Set(named.map((g) => g.oppName)).size;
      if (uniqueOpponents >= 100) {
        add(
          "unique-opponents",
          `UNIQUE OPPONENTS FACED: ${fmtInt(uniqueOpponents)}${uniqueOpponents >= 500 ? " — basically knows the whole ladder" : ""}`,
        );
      }
      const barcodes = games.filter(
        (g) => g.oppName && BARCODE_RE.test(g.oppName) && (g.win || g.loss),
      );
      if (barcodes.length >= 10) {
        const w = barcodes.filter((g) => g.win).length;
        add(
          "barcodes",
          `BARCODES FACED: ${fmtInt(barcodes.length)} — ${pct(w, barcodes.length)}% win rate vs the mystery men`,
        );
      }
      const rated = games.filter((g) => g.oppMmr !== null);
      const recent20 = rated.slice(-20);
      if (recent20.length >= 10) {
        const avg = recent20.reduce((a, g) => a + (g.oppMmr ?? 0), 0) / recent20.length;
        add(
          "avg-opp-mmr",
          `AVERAGE OPPONENT (last ${recent20.length}): ${fmtInt(Math.round(avg))} MMR`,
        );
      }
    }

    // ── Builds ──
    {
      // The classifier's "<X>v<Y> - Game Too Short" catch-all (sub-45s
      // replays) is not a build — without this filter it wins the
      // signature/hottest slots on any account with a cheese-y ladder
      // history. Same exclusion regex the ladder-meta service uses.
      // The unclassified fallbacks ("Unclassified - Protoss",
      // "PvP - Macro Transition (Unclassified)") are equally not builds
      // and must never headline the signature/hottest slots either.
      const withBuild = games.filter(
        (g) =>
          g.myBuild &&
          !/Game Too Short$/i.test(g.myBuild) &&
          !/^Unclassified\s*-/i.test(g.myBuild) &&
          !/\(Unclassified\)\s*$/i.test(g.myBuild) &&
          (g.win || g.loss),
      );
      const byBuild = groupBy(withBuild, (g) => g.myBuild);
      let signature = null;
      for (const [build, list] of byBuild) {
        if (!signature || list.length > signature.list.length)
          signature = { build, list };
      }
      if (signature && signature.list.length >= 15) {
        const w = signature.list.filter((g) => g.win).length;
        add(
          "signature-build",
          `SIGNATURE BUILD: ${shortBuild(String(signature.build))} — ${fmtInt(signature.list.length)} games, ${pct(w, signature.list.length)}% wins`,
        );
      }
      let hot = null;
      for (const [build, list] of byBuild) {
        if (list.length < 10) continue;
        const rate = list.filter((g) => g.win).length / list.length;
        if (!hot || rate > hot.rate) hot = { build, list, rate };
      }
      if (hot && hot.rate >= 0.58 && (!signature || hot.build !== signature.build)) {
        add(
          "hot-build",
          `HOTTEST BUILD: ${shortBuild(String(hot.build))} — ${pct(hot.list.filter((g) => g.win).length, hot.list.length)}% over ${fmtInt(hot.list.length)} games`,
        );
      }
    }

    // ── Mechanics ──
    {
      const withApm = games.filter((g) => g.apm !== null && g.apm > 0);
      if (withApm.length >= 20) {
        const avg = withApm.reduce((a, g) => a + (g.apm ?? 0), 0) / withApm.length;
        let peak = 0;
        for (const g of withApm) if ((g.apm ?? 0) > peak) peak = g.apm ?? 0;
        add(
          "apm",
          `APM: ${fmtInt(Math.round(avg))} average · ${fmtInt(Math.round(peak))} peak`,
        );
      }
      const withMacro = games.filter((g) => g.macroScore !== null).slice(-50);
      if (withMacro.length >= 15) {
        const avg =
          withMacro.reduce((a, g) => a + (g.macroScore ?? 0), 0) / withMacro.length;
        add(
          "macro-score",
          `MACRO SCORE: ${Math.round(avg)}/100 average over the last ${withMacro.length} games`,
        );
      }
    }

    // ── Career combat totals (heavy counters, single $group) ──
    try {
      const agg = await this.db.games
        .aggregate([
          {
            $match: { userId, isResumedFromReplay: { $ne: true } },
          },
          {
            $group: {
              _id: null,
              unitsKilled: {
                $sum: {
                  $ifNull: ["$macroBreakdown.player_stats.me.units_killed", 0],
                },
              },
              unitsProduced: {
                $sum: {
                  $ifNull: ["$macroBreakdown.player_stats.me.units_produced", 0],
                },
              },
              unitsLost: {
                $sum: {
                  $ifNull: ["$macroBreakdown.player_stats.me.units_lost", 0],
                },
              },
              structuresKilled: {
                $sum: {
                  $ifNull: [
                    "$macroBreakdown.player_stats.me.structures_killed",
                    0,
                  ],
                },
              },
              supplyBlockedSec: {
                $sum: {
                  $ifNull: [
                    "$macroBreakdown.player_stats.me.supply_blocked_seconds",
                    0,
                  ],
                },
              },
            },
          },
        ])
        .toArray();
      const t = agg[0] || {};
      const race = dominantRace(games);
      if (Number(t.unitsProduced) >= 5000) {
        add(
          "units-produced",
          `ARMY REPORT: ${fmtInt(Math.round(Number(t.unitsProduced)))} units ${produceVerb(race)} (career)`,
        );
      }
      if (Number(t.unitsKilled) >= 5000) {
        add(
          "units-killed",
          `CAREER KILLS: ${fmtInt(Math.round(Number(t.unitsKilled)))} enemy units destroyed`,
        );
      }
      if (Number(t.structuresKilled) >= 500) {
        add(
          "structures-killed",
          `DEMOLITION LOG: ${fmtInt(Math.round(Number(t.structuresKilled)))} enemy structures flattened`,
        );
      }
      if (Number(t.supplyBlockedSec) >= 3600) {
        add(
          "supply-blocked",
          `TIME SUPPLY BLOCKED (career): ${(Number(t.supplyBlockedSec) / 3600).toFixed(1)} hrs — ${supplyLine(race)}`,
        );
      }
    } catch {
      // Heavy counters are decorative; a failed aggregation only
      // shrinks the pool.
    }

    // ── Recent form + weekly summary ──
    {
      const decidedGames = games.filter((g) => g.win || g.loss);
      const last20 = decidedGames.slice(-20);
      if (last20.length >= 10) {
        const w = last20.filter((g) => g.win).length;
        add("form", `FORM: ${w}–${last20.length - w} over the last ${last20.length}`);
      }
      const weekCutoff = this.now() - 7 * 24 * 3600 * 1000;
      const week = decidedGames.filter((g) => g.ts >= weekCutoff);
      if (week.length >= 5) {
        const w = week.filter((g) => g.win).length;
        add(
          "this-week",
          `THIS WEEK: ${fmtInt(week.length)} games · ${w}–${week.length - w}`,
        );
      }
      // Best day of week (min 20 decided games on that day).
      const byDay = groupBy(decidedGames, (g) => new Date(g.ts).getUTCDay());
      let bestDay = null;
      for (const [day, list] of byDay) {
        if (list.length < 20) continue;
        const rate = list.filter((g) => g.win).length / list.length;
        if (!bestDay || rate > bestDay.rate) bestDay = { day, list, rate };
      }
      if (bestDay && bestDay.rate >= 0.55) {
        add(
          "best-day",
          `BEST DAY: ${DAY_NAMES[Number(bestDay.day)]}s — ${pct(bestDay.list.filter((g) => g.win).length, bestDay.list.length)}% win rate (${fmtInt(bestDay.list.length)} games)`,
        );
      }
    }

    // ── Milestone watch ──
    if (decided >= 40) {
      const nextWinsMark = Math.ceil((wins + 1) / 100) * 100;
      const winsAway = nextWinsMark - wins;
      if (winsAway <= 15) {
        add(
          "milestone-wins",
          `MILESTONE WATCH: ${winsAway} win${winsAway === 1 ? "" : "s"} to career win #${fmtInt(nextWinsMark)}`,
        );
      }
      const nextGamesMark = Math.ceil((total + 1) / 500) * 500;
      const gamesAway = nextGamesMark - total;
      if (gamesAway <= 25) {
        add(
          "milestone-games",
          `COMING UP: tracked game #${fmtInt(nextGamesMark)} — ${gamesAway} away`,
        );
      }
    }

    // ── On this day (Daily Pulse's best idea, ticker-sized) ──
    {
      const today = new Date(this.now());
      const md = `${today.getUTCMonth()}-${today.getUTCDate()}`;
      const thisYear = today.getUTCFullYear();
      const past = games.filter((g) => {
        const d = new Date(g.ts);
        return (
          `${d.getUTCMonth()}-${d.getUTCDate()}` === md &&
          d.getUTCFullYear() < thisYear &&
          (g.win || g.loss)
        );
      });
      if (past.length >= 3) {
        const w = past.filter((g) => g.win).length;
        add(
          "on-this-day",
          `ON THIS DAY (past years): ${w}–${past.length - w} across ${fmtInt(past.length)} games`,
        );
      }
    }

    // ── Skill fingerprint playstyle ──
    if (this.skillFingerprint) {
      try {
        const mu = mostPlayedMatchup(games);
        if (mu) {
          const fp = await this.skillFingerprint.compute(userId, { matchup: mu });
          if (fp && typeof fp.playstyle === "string" && fp.playstyle) {
            add(
              "playstyle",
              `PLAYSTYLE (${mu}): ${fp.playstyle}${playstyleDetail(fp, mu)}`,
            );
          }
        }
      } catch {
        // Fingerprint is decorative — a failure only shrinks the pool.
      }
    }

    // ── Arcade unit trivia (favorite unit, career losses) ──
    if (this.arcade && typeof this.arcade.unitStats === "function") {
      try {
        const stats = await this.arcade.unitStats(userId);
        const byUnit =
          stats && stats.builtByUnit && typeof stats.builtByUnit === "object"
            ? Object.entries(stats.builtByUnit)
            : [];
        let fav = null;
        for (const [name, count] of byUnit) {
          const c = Number(count);
          if (!Number.isFinite(c)) continue;
          if (!fav || c > fav.count) fav = { name, count: c };
        }
        if (fav && fav.count >= 500) {
          add(
            "favorite-unit",
            `FAVORITE UNIT: ${fav.name} — ${fmtInt(fav.count)} ${produceVerb(dominantRace(games))} over the last ${fmtInt(Number(stats.scannedGames) || 0)} games`,
          );
        }
        if (Number(stats?.totalUnitsLost) >= 2000) {
          add(
            "units-lost",
            `CASUALTY REPORT: ${fmtInt(Number(stats.totalUnitsLost))} units lost in action — they will be remembered`,
          );
        }
      } catch {
        // Unit trivia reads the heavy store — treat outages as "no fact".
      }
    }

    // ── Ladder season countdown ──
    if (this.seasons && typeof this.seasons.list === "function") {
      try {
        const cat = await this.seasons.list();
        const current = cat && cat.current;
        if (typeof current === "number" && Array.isArray(cat.items)) {
          let end = null;
          for (const item of cat.items) {
            if (!item || item.number !== current || !item.end) continue;
            const t = new Date(item.end).getTime();
            if (Number.isFinite(t) && (end === null || t > end)) end = t;
          }
          if (end !== null && end > this.now()) {
            const days = Math.ceil((end - this.now()) / (24 * 3600 * 1000));
            if (days <= 60) {
              add(
                "season-countdown",
                `LADDER SEASON ${current}: ${days} day${days === 1 ? "" : "s"} left — lock in that final MMR`,
              );
            }
          }
        }
      } catch {
        // Season catalog is a network-backed cache — skip on failure.
      }
    }

    // ── First tracked game ──
    if (total >= 50) {
      const first = games[0];
      add(
        "first-game",
        `FIRST TRACKED GAME: a ${first.win ? "WIN" : first.loss ? "LOSS" : "TIE"}${first.map ? ` on ${first.map}` : ""} — ${fmtShortDate(first.ts)}`,
      );
    }

    return facts;
  }
}

/* ──────────────── helpers ──────────────── */

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** @param {number} n @param {number} d @returns {string} */
function pct(n, d) {
  return d > 0 ? String(Math.round((n / d) * 100)) : "0";
}

/** @param {number} n @returns {string} */
function fmtInt(n) {
  return Math.round(n).toLocaleString("en-US");
}

/** @param {number} sec @returns {string} */
function fmtDur(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Preserve fingerprint precision at the 5:00 / 15:00 average-time edges. */
/** @param {number} sec @returns {string} */
function fmtAverageDur(sec) {
  const totalHundredths = Math.round(sec * 100);
  const minutes = Math.floor(totalHundredths / 6000);
  const remainder = totalHundredths % 6000;
  const wholeSeconds = Math.floor(remainder / 100);
  const hundredths = remainder % 100;
  const fraction = hundredths === 0
    ? ""
    : hundredths % 10 === 0
      ? `.${hundredths / 10}`
      : `.${String(hundredths).padStart(2, "0")}`;
  const rendered = `${String(wholeSeconds).padStart(2, "0")}${fraction}`;
  return `${minutes}:${rendered}`;
}

/** @param {number} ts @returns {string} */
function fmtMonthYear(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Date-stamp for the all-time facts (peak MMR, biggest scalp,
 *  longest streak, first game). Those records are often years old,
 *  so a bare "Dec 29" is ambiguous — the year always rides along.
 *  @param {number} ts @returns {string} */
function fmtShortDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Trim classifier prefixes like "PvZ - " from build names so ticker
 * segments stay compact; the matchup context is usually elsewhere in
 * the same line.
 * @param {string} name
 * @returns {string}
 */
function shortBuild(name) {
  return name.replace(/^[PTZR]v[PTZR]\s*-\s*/i, "").slice(0, 60);
}

/**
 * @template T
 * @param {T[]} list
 * @param {(item: T) => string|number} keyFn
 * @returns {Map<string|number, T[]>}
 */
function groupBy(list, keyFn) {
  /** @type {Map<string|number, T[]>} */
  const out = new Map();
  for (const item of list) {
    const key = keyFn(item);
    const bucket = out.get(key);
    if (bucket) bucket.push(item);
    else out.set(key, [item]);
  }
  return out;
}

/**
 * The race the user actually plays — majority race over the most
 * recent 50 games (ties break toward the most recent).
 * @param {Array<{myRace: string}>} games chronological
 * @returns {string|null}
 */
function dominantRace(games) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const g of games.slice(-50)) {
    const r = g.myRace.trim();
    if (!r) continue;
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  let best = null;
  for (const [race, count] of counts) {
    if (!best || count >= best.count) best = { race, count };
  }
  return best ? best.race : null;
}

/**
 * Most-played matchup over the recent window, e.g. "PvZ". Only
 * emits when both races are recognisable.
 * @param {Array<{myRace: string, oppRace: string}>} games chronological
 * @returns {string|null}
 */
function mostPlayedMatchup(games) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const g of games.slice(-200)) {
    const mine = g.myRace.trim()[0];
    const theirs = g.oppRace.trim()[0];
    if (!mine || !theirs) continue;
    const key = `${mine.toUpperCase()}v${theirs.toUpperCase()}`;
    if (!/^[PTZ]v[PTZ]$/.test(key)) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = null;
  for (const [mu, count] of counts) {
    if (!best || count > best.count) best = { mu, count };
  }
  return best && best.count >= 15 ? best.mu : null;
}

/**
 * Explain the current playstyle fingerprint with the raw replay measures that
 * actually selected it. Repertoire and pace describe the requested matchup;
 * matchup balance compares that race's three matchups. These are tendencies,
 * not skill percentiles, so the ticker reports counts, time, and matchup
 * win-rate gaps with familiar % notation rather than benchmark language.
 *
 * The legacy branch is deliberately retained for a short compatibility
 * window. Ticker facts are decorative and may be fed by a stale mock or a
 * rolling worker while the API deploys, so an old fingerprint should remain
 * readable rather than dropping the entire fact.
 *
 * @param {Record<string, any>} fp
 * @param {string} matchup
 * @returns {string}
 */
function playstyleDetail(fp, matchup) {
  const axes = Array.isArray(fp.axes) ? fp.axes : [];
  const repertoire = axes.find((axis) => axis && axis.key === "repertoire");
  const pace = axes.find((axis) => axis && axis.key === "pace");
  const matchupBalance = axes.find(
    (axis) => axis && axis.key === "matchup_balance",
  );
  const hasCurrentShape = Boolean(
    repertoire ||
      pace ||
      matchupBalance ||
      Array.isArray(fp.buildOrders) ||
      Array.isArray(fp.matchupWinRates) ||
      (fp.matchupSummary && typeof fp.matchupSummary === "object"),
  );

  if (hasCurrentShape) {
    const selected = [];
    const buildCount = repertoire
      ? usableFingerprintAxis(repertoire)
        ? firstFiniteNumber(repertoire.value)
        : null
      : firstFiniteNumber(
          Array.isArray(fp.buildOrders) ? fp.buildOrders.length : null,
        );
    if (buildCount !== null && buildCount >= 0) {
      const count = Math.round(buildCount);
      selected.push(
        `${count} ${matchup} build order${count === 1 ? "" : "s"}`,
      );
    }

    const averageSec = pace
      ? usableFingerprintAxis(pace)
        ? firstFiniteNumber(pace.value)
        : null
      : firstFiniteNumber(
          fp.averageDurationSec,
          fp.pace && fp.pace.averageSec,
        );
    if (averageSec !== null && averageSec >= 0) {
      selected.push(`${fmtAverageDur(averageSec)} average game`);
    }

    const balance = matchupDetail(
      fp.matchupSummary,
      fp.matchupWinRates,
      matchupBalance,
    );
    const measured = selected.join(", ");
    if (measured && balance) return ` — ${measured}; ${balance}`;
    if (measured) return ` — ${measured}`;
    if (balance) return ` — ${balance}`;
    return "";
  }

  return legacyPlaystyleDetail(fp, matchup, axes);
}

/**
 * @param {unknown} summary
 * @param {unknown} rawRates
 * @param {Record<string, any> | undefined} axis
 * @returns {string}
 */
function matchupDetail(summary, rawRates, axis) {
  const hasSummary = Boolean(summary && typeof summary === "object");
  const data = /** @type {Record<string, any>} */ (
    hasSummary ? summary : {}
  );
  // A present summary with null fields means the service's sample gate was
  // not met. Do not bypass that decision by recomputing from provisional
  // rows; derivation is only a compatibility path for summary-less mocks.
  const derived = hasSummary ? null : deriveMatchupGaps(rawRates);
  const spread = firstFiniteNumber(
    data.spreadPp,
    data.spread,
    data.winRateSpreadPp,
    derived && derived.spread,
    axis && axis.value,
  );
  const lead = firstFiniteNumber(
    data.leaderGap,
    data.leaderMarginPp,
    data.leadPp,
    data.bestLeadPp,
    data.specialistLeadPp,
    derived && derived.lead,
  );
  const weakGap = firstFiniteNumber(
    data.weakGap,
    data.weakGapPp,
    data.blindSpotGap,
    derived && derived.weakGap,
  );
  const leader = firstNonEmptyString(
    data.strongestMatchup,
    data.bestMatchup,
    data.leaderMatchup,
    data.leadingMatchup,
    derived && derived.leader,
  );
  const weakest = firstNonEmptyString(
    data.weakestMatchup,
    data.trailingMatchup,
    derived && derived.weakest,
  );
  const category = firstNonEmptyString(axis && axis.category);

  if (category === "specialist" && lead !== null && lead >= 0) {
    return leader
      ? `${leader} is your strongest matchup, with a win rate at least ${formatPercentValue(lead)}% higher than your other two`
      : `your best matchup has at least a ${formatPercentValue(lead)}% win-rate edge over the other two`;
  }
  if (category === "blind_spot" && weakGap !== null && weakGap >= 0) {
    return weakest
      ? `${weakest} is your toughest matchup, with a win rate at least ${formatPercentValue(weakGap)}% lower than your other two`
      : `your toughest matchup has at least a ${formatPercentValue(weakGap)}% win-rate gap from the other two`;
  }
  if (category === "universalist" && spread !== null && spread >= 0) {
    return `all three matchup win rates are within ${formatPercentValue(spread)}%`;
  }
  return spread !== null && spread >= 0
    ? `there is a ${formatPercentValue(spread)}% win-rate gap between your best and toughest matchups`
    : "";
}

/** Keep one decimal for whole values and reveal meaningful thousandths. */
/** @param {number} value @returns {string} */
function formatPercentValue(value) {
  return value
    .toFixed(3)
    .replace(/0+$/, "")
    .replace(/\.$/, ".0");
}

/**
 * Derive spread and leader margin when a caller supplies only the matchup
 * rows. ``winRate`` follows the fingerprint contract and is already a
 * percentage in the 0..100 range.
 *
 * @param {unknown} raw
 * @returns {{spread: number, lead: number, weakGap: number, leader: string|null, weakest: string|null} | null}
 */
function deriveMatchupGaps(raw) {
  if (!Array.isArray(raw)) return null;
  const rates = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const value = firstFiniteNumber(
      row.winRate,
      row.winRatePct,
      row.winRatePercent,
    );
    if (value === null || value < 0 || value > 100) continue;
    rates.push({
      matchup: firstNonEmptyString(row.matchup, row.name),
      value,
    });
  }
  if (rates.length < 3) return null;
  rates.sort((a, b) => b.value - a.value);
  return {
    spread: rates[0].value - rates[rates.length - 1].value,
    lead: rates[0].value - rates[1].value,
    weakGap:
      rates[rates.length - 2].value - rates[rates.length - 1].value,
    leader: rates[0].matchup,
    weakest: rates[rates.length - 1].matchup,
  };
}

/** @param {...unknown} values @returns {number|null} */
function firstFiniteNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/** Provisional axis values stay hidden until the service's sample gate passes. */
/** @param {unknown} raw @returns {boolean} */
function usableFingerprintAxis(raw) {
  if (!raw || typeof raw !== "object") return false;
  const axis = /** @type {Record<string, any>} */ (raw);
  return Boolean(
    typeof axis.category === "string" &&
      axis.category.trim() &&
      typeof axis.position === "number" &&
      Number.isFinite(axis.position),
  );
}

/** @param {...unknown} values @returns {string|null} */
function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * @param {Record<string, any>} fp
 * @param {string} matchup
 * @param {Array<Record<string, any>>} axes
 * @returns {string}
 */
function legacyPlaystyleDetail(fp, matchup, axes) {
  const valid = axes.filter(
    (axis) =>
      axis &&
      typeof axis.percentile === "number" &&
      Number.isFinite(axis.percentile),
  );
  const consistency = valid.find((axis) => axis.key === "consistency");

  if (
    consistency &&
    (fp.playstyle === "Metronome" || fp.playstyle === "Coin-Flip Player")
  ) {
    const score = Math.max(0, Math.min(100, Math.round(consistency.percentile)));
    const description =
      fp.playstyle === "Metronome"
        ? "steady macro across recent games, usually at a measured pace"
        : "macro varied across recent games";
    return ` — ${description} (consistency score: ${score}/100)`;
  }

  const strongestBenchmark = valid
    .filter((axis) => axis.key !== "consistency" && axis.key !== "ladder")
    .sort((a, b) => b.percentile - a.percentile)[0];
  if (!strongestBenchmark) return "";

  const percentile = Math.max(
    0,
    Math.min(100, Math.round(strongestBenchmark.percentile)),
  );
  const benchmark =
    fp.band && typeof fp.band.label === "string" && fp.band.label
      ? `${matchup} games against ${fp.band.label} opponents`
      : `comparable ${matchup} games`;
  const label =
    strongestBenchmark.key === "aggression"
      ? "game tempo"
      : String(strongestBenchmark.label).toLowerCase();
  return ` — strongest benchmark: ${label} averaged at the ${ordinal(percentile)} percentile vs ${benchmark}`;
}

/** @param {number} n @returns {string} */
function ordinal(n) {
  const mod100 = n % 100;
  const suffix =
    mod100 >= 11 && mod100 <= 13
      ? "th"
      : n % 10 === 1
        ? "st"
        : n % 10 === 2
          ? "nd"
          : n % 10 === 3
            ? "rd"
            : "th";
  return `${n}${suffix}`;
}

/** @param {string|null} race @returns {string} */
function produceVerb(race) {
  const r = (race || "").toLowerCase();
  if (r === "protoss") return "warped in";
  if (r === "zerg") return "morphed";
  if (r === "terran") return "trained";
  return "produced";
}

/** @param {string|null} race @returns {string} */
function supplyLine(race) {
  const r = (race || "").toLowerCase();
  if (r === "protoss") return "build more pylons";
  if (r === "zerg") return "more overlords, always";
  if (r === "terran") return "build more depots";
  return "build more supply";
}

module.exports = { TickerFactsService, CACHE_TTL_MS };
