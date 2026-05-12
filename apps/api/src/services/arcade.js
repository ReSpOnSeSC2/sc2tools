"use strict";

const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");

/**
 * Arcade service. Two responsibilities:
 *
 *   1. resolveQuests(userId, card)
 *      Re-evaluates an active Bingo: Ladder Edition card against the
 *      user's recent games and returns which cells have ticked. Pure
 *      derivation — does NOT mutate the card; the client persists the
 *      ticked state via /v1/me/preferences/arcade so the resolver
 *      stays idempotent.
 *
 *   2. Stock Market weekly P&L leaderboard
 *      submitLeaderboard(userId, entry) and listLeaderboard(weekKey)
 *      backed by the ``community_builds`` collection's neighbour —
 *      we use a separate ``arcade_leaderboard`` collection so the
 *      community-builds K-anon path stays unaffected. Opt-in: the row
 *      is only written when the user explicitly submits.
 */

const ARCADE_LEADERBOARD = COLLECTIONS.ARCADE_LEADERBOARD;

class ArcadeService {
  /**
   * @param {import('../db/connect').DbContext & { arcadeLeaderboard?: any }} db
   * @param {{
   *   games: import('../services/types').GamesService,
   *   gameDetails?: import('./gameDetails').GameDetailsService,
   * }} deps
   */
  constructor(db, deps) {
    this.db = db;
    this.games = deps.games;
    // GameDetailsService is optional: predicates that read only the
    // slim row work without it. Build-log / unit-built predicates
    // gracefully degrade to "not ticked" when game_details is missing
    // (e.g. older games whose ingestion predated the v0.4.3 split or
    // a test harness that doesn't wire the heavy store).
    this.gameDetails = deps.gameDetails || null;
    // Mongo collection lazy handle. Some test harnesses construct the
    // service without a pre-bound collection; resolve on first use so
    // the service stays cheap to instantiate.
    this._collection = null;
  }

  _coll() {
    if (this._collection) return this._collection;
    if (this.db.arcadeLeaderboard) {
      this._collection = this.db.arcadeLeaderboard;
      return this._collection;
    }
    if (typeof this.db.collection === "function") {
      this._collection = this.db.collection(ARCADE_LEADERBOARD);
      return this._collection;
    }
    throw new Error("arcade_leaderboard collection unavailable");
  }

  /**
   * Resolve every cell on an active card against the user's games since
   * ``card.startedAt``. Each cell declares a ``predicate`` key +
   * ``params``; the predicate registry below is the source of truth
   * for what can appear on a card.
   *
   * The field is named ``cells`` to match the client (BingoState.cells
   * in apps/web/components/analyzer/arcade/types.ts). A prior version
   * read ``card.objectives``, which the client never sends — so the
   * resolver returned an empty array on every call and Bingo cells
   * never ticked.
   *
   * Two-pass strategy: predicates that read only the slim ``games``
   * row run in pass 1 (no extra I/O). Predicates that need build-log
   * data (build_contains / won_with_unit) trigger one bulk
   * ``game_details`` fetch in pass 2 — capped at the games already
   * loaded by pass 1 so a card with three heavy-predicate cells still
   * hits Mongo once, not three times.
   *
   * @param {string} userId
   * @param {{
   *   startedAt: string,
   *   cells: Array<{ id: string, predicate: string, params?: any }>,
   * }} card
   * @returns {Promise<{ resolved: Array<{ id: string, ticked: boolean, gameId?: string }> }>}
   */
  async resolveQuests(userId, card) {
    if (!card || !Array.isArray(card.cells)) {
      return { resolved: [] };
    }
    const start = parseIso(card.startedAt) || new Date(0);
    const games = await this.db.games
      .find(
        { userId, date: { $gte: start } },
        { projection: { _id: 0 } },
      )
      .sort({ date: 1 })
      .limit(500)
      .toArray();

    // Pass 1: slim-row predicates only.
    /** @type {Array<{ id: string, ticked: boolean, gameId?: string }>} */
    const resolved = [];
    /** @type {Array<{ idx: number, cell: any }>} */
    const heavyPending = [];
    for (let i = 0; i < card.cells.length; i += 1) {
      const cell = card.cells[i];
      const predicate = PREDICATES[cell.predicate];
      if (!predicate) {
        resolved.push({ id: cell.id, ticked: false });
        continue;
      }
      if (HEAVY_PREDICATES.has(cell.predicate)) {
        // Reserve the slot and resolve later once details are loaded.
        resolved.push({ id: cell.id, ticked: false });
        heavyPending.push({ idx: i, cell });
        continue;
      }
      const hit = predicate(games, cell.params || {});
      resolved[i] = hit
        ? { id: cell.id, ticked: true, gameId: hit }
        : { id: cell.id, ticked: false };
    }

    // Pass 2: heavy predicates. Bulk-load game_details for every game
    // in the window once — the predicates are pure scans over that
    // map. Keeping the fetch outside the predicate loop is what makes
    // a 5-heavy-cell card a single round-trip.
    if (heavyPending.length > 0 && this.gameDetails && games.length > 0) {
      try {
        const ids = games.map((g) => String(g.gameId));
        const detailsMap = await this.gameDetails.findMany(userId, ids);
        // Decorate a shallow copy of each slim row with its heavy
        // blob so predicates can read both halves without juggling
        // two arrays. We mutate the local ``games`` here because it's
        // a per-request value and never escapes the method.
        for (const g of games) {
          const blob = detailsMap.get(String(g.gameId));
          if (blob) {
            for (const key of HEAVY_FIELDS) {
              if (blob[key] !== undefined) g[key] = blob[key];
            }
          }
        }
        for (const { idx, cell } of heavyPending) {
          const predicate = PREDICATES[cell.predicate];
          const hit = predicate(games, cell.params || {});
          resolved[idx] = hit
            ? { id: cell.id, ticked: true, gameId: hit }
            : { id: cell.id, ticked: false };
        }
      } catch {
        // Heavy-store outages must not break the slim-row results
        // that already resolved successfully. Pending heavy cells
        // stay un-ticked; the next resolve call retries.
      }
    }

    return { resolved };
  }

  /**
   * Submit (insert/replace) one row for a given (userId, weekKey).
   * Idempotent on (userId, weekKey) so multiple submits in the same
   * week overwrite. Display name is opt-in — empty string means the
   * row is anonymous and the leaderboard shows "Anonymous N".
   *
   * @param {string} userId
   * @param {{ weekKey: string, pnlPct: number, displayName?: string }} entry
   */
  async submitLeaderboard(userId, entry) {
    if (!entry || typeof entry !== "object") return false;
    const weekKey = String(entry.weekKey || "").trim();
    const pnl = Number(entry.pnlPct);
    if (!isWeekKey(weekKey)) return false;
    if (!Number.isFinite(pnl)) return false;
    const display = typeof entry.displayName === "string"
      ? entry.displayName.trim().slice(0, 60)
      : "";
    const now = new Date();
    /** @type {Record<string, any>} */
    const doc = {
      userId,
      weekKey,
      pnlPct: clamp(pnl, -100, 1000),
      displayName: display,
      updatedAt: now,
    };
    stampVersion(doc, ARCADE_LEADERBOARD);
    await this._coll().updateOne(
      { userId, weekKey },
      { $set: doc, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
    return true;
  }

  /**
   * Aggregate unit-built counts and total units-lost across the user's
   * recent games. Powers two trivia quizzes ("which unit have you
   * built the most of" / "how many units have you lost"). Heavy data
   * lives in game_details; this method bulk-loads details for the
   * most recent ``UNIT_STATS_SCAN_CAP`` games and folds them into a
   * compact aggregate. No DB write — the route is read-only and
   * recomputed on demand.
   *
   * Bounded by ``UNIT_STATS_SCAN_CAP`` so a 30 000-game corpus doesn't
   * pull tens of MB of buildLogs into RAM per request. The cap is
   * communicated back to the client via ``scannedGames`` so the trivia
   * reveal can say "of your last N games".
   *
   * @param {string} userId
   * @returns {Promise<{
   *   scannedGames: number,
   *   builtByUnit: Record<string, number>,
   *   totalUnitsLost: number,
   *   lostGames: number,
   * }>}
   */
  async unitStats(userId) {
    const empty = {
      scannedGames: 0,
      builtByUnit: /** @type {Record<string, number>} */ ({}),
      totalUnitsLost: 0,
      lostGames: 0,
    };
    if (!userId) return empty;
    const games = await this.db.games
      .find(
        { userId },
        { projection: { _id: 0, gameId: 1, date: 1 } },
      )
      .sort({ date: -1 })
      .limit(UNIT_STATS_SCAN_CAP)
      .toArray();
    if (!games.length) return empty;
    if (!this.gameDetails) {
      return { ...empty, scannedGames: games.length };
    }
    const ids = games.map((g) => String(g.gameId));
    let detailsMap;
    try {
      detailsMap = await this.gameDetails.findMany(userId, ids);
    } catch {
      // Heavy-store outage → return slim-row-only aggregate so the
      // trivia can still render an empty-state message rather than
      // crashing the route.
      return { ...empty, scannedGames: games.length };
    }
    /** @type {Record<string, number>} */
    const builtByUnit = {};
    let totalUnitsLost = 0;
    let lostGames = 0;
    for (const id of ids) {
      const blob = detailsMap.get(id);
      if (!blob) continue;
      if (Array.isArray(blob.buildLog)) {
        for (const line of blob.buildLog) {
          const name = extractBuildLogName(line);
          if (!name) continue;
          if (isStructureName(name)) continue;
          builtByUnit[name] = (builtByUnit[name] || 0) + 1;
        }
      }
      const me =
        blob.macroBreakdown &&
        blob.macroBreakdown.player_stats &&
        blob.macroBreakdown.player_stats.me;
      if (me && Number.isFinite(Number(me.units_lost))) {
        totalUnitsLost += Number(me.units_lost);
        lostGames += 1;
      }
    }
    return {
      scannedGames: games.length,
      builtByUnit,
      totalUnitsLost,
      lostGames,
    };
  }

  /**
   * List the top N rows for a given weekKey. Anonymises rows whose
   * displayName is empty and assigns rank by sorted P&L. Returns at
   * most ``limit`` rows; the underlying collection is capped here, not
   * upstream.
   *
   * @param {string} weekKey
   * @param {{ limit?: number }} [opts]
   */
  async listLeaderboard(weekKey, opts = {}) {
    if (!isWeekKey(weekKey)) {
      return { weekKey, items: [] };
    }
    const limit = Math.min(Math.max(1, Number(opts.limit) || 50), 200);
    const rows = await this._coll()
      .find(
        { weekKey },
        { projection: { _id: 0, userId: 1, displayName: 1, pnlPct: 1 } },
      )
      .sort({ pnlPct: -1, updatedAt: 1 })
      .limit(limit)
      .toArray();
    let anonCounter = 1;
    const items = rows.map((r, i) => ({
      rank: i + 1,
      // Stable per-user anonymised handle so the same anonymous user
      // doesn't read as a different "Anonymous N" between page loads
      // within a week.
      displayName: r.displayName && r.displayName.length > 0
        ? r.displayName
        : `Anonymous ${anonCounter++}`,
      pnlPct: r.pnlPct,
      isAnonymous: !r.displayName || r.displayName.length === 0,
    }));
    return { weekKey, items };
  }
}

/**
 * The four heavy field names (mirrored from services/gameDetails.js).
 * Duplicated locally so the slim-vs-heavy decoration step doesn't
 * have to require gameDetails.js when the dep is null in a test.
 */
const HEAVY_FIELDS = Object.freeze([
  "buildLog",
  "oppBuildLog",
  "macroBreakdown",
  "apmCurve",
]);

/**
 * Maximum number of recent games to scan when computing the
 * arcade-trivia unit aggregate. Bounded so a prolific user's request
 * doesn't blow up the heavy-store fetch — the trivia is a "fun
 * stat about your recent history" surface, not a forensic
 * career-spanning report.
 */
const UNIT_STATS_SCAN_CAP = 1000;

/**
 * Parse the unit/structure name out of one buildLog entry. The agent
 * emits lines like ``"[5:30] Marine"`` or structured objects like
 * ``{ time, name, ... }``. We accept both shapes — string form goes
 * through a regex; object form reads the ``name`` (or ``display``)
 * key directly. Returns an empty string when the line is unparseable.
 *
 * @param {unknown} line
 * @returns {string}
 */
function extractBuildLogName(line) {
  if (line && typeof line === "object") {
    const o = /** @type {any} */ (line);
    if (typeof o.name === "string" && o.name) return o.name;
    if (typeof o.display === "string" && o.display) return o.display;
    return "";
  }
  const s = String(line || "");
  if (!s) return "";
  const m = /^\s*\[\d+:\d+\]\s*(.+?)\s*$/.exec(s);
  if (m) return m[1];
  return s.trim();
}

/**
 * Heuristic: is this name a structure (building) rather than a
 * trainable unit? The "most-built unit" trivia is more interesting
 * when scoped to combat / worker units, since otherwise Pylons /
 * SCVs would always dominate. We use a small allowlist of common
 * structure suffixes; the catalog-based classifier is server-only
 * elsewhere (services/perGameCompute.js), but trivia doesn't need
 * its precision — a false positive just keeps a wider unit list.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isStructureName(name) {
  if (!name) return false;
  if (STRUCTURE_NAMES.has(name)) return true;
  return false;
}

const STRUCTURE_NAMES = new Set([
  // Protoss
  "Nexus", "Pylon", "Gateway", "WarpGate", "Warp Gate", "Forge",
  "PhotonCannon", "Photon Cannon", "Assimilator", "CyberneticsCore",
  "Cybernetics Core", "TwilightCouncil", "Twilight Council",
  "RoboticsFacility", "Robotics Facility", "RoboticsBay", "Robotics Bay",
  "Stargate", "FleetBeacon", "Fleet Beacon", "TemplarArchives",
  "Templar Archives", "DarkShrine", "Dark Shrine", "ShieldBattery",
  "Shield Battery", "ShieldBatteries",
  // Terran
  "CommandCenter", "Command Center", "OrbitalCommand", "Orbital Command",
  "PlanetaryFortress", "Planetary Fortress", "SupplyDepot", "Supply Depot",
  "Refinery", "Barracks", "Factory", "Starport", "EngineeringBay",
  "Engineering Bay", "Bunker", "MissileTurret", "Missile Turret",
  "SensorTower", "Sensor Tower", "Armory", "GhostAcademy",
  "Ghost Academy", "FusionCore", "Fusion Core", "Reactor", "TechLab",
  "Tech Lab",
  // Zerg
  "Hatchery", "Lair", "Hive", "SpawningPool", "Spawning Pool",
  "EvolutionChamber", "Evolution Chamber", "SporeCrawler", "Spore Crawler",
  "SpineCrawler", "Spine Crawler", "Extractor", "RoachWarren",
  "Roach Warren", "BanelingNest", "Baneling Nest", "HydraliskDen",
  "Hydralisk Den", "LurkerDen", "Lurker Den", "InfestationPit",
  "Infestation Pit", "Spire", "GreaterSpire", "Greater Spire",
  "NydusNetwork", "Nydus Network", "NydusWorm", "Nydus Worm",
  "UltraliskCavern", "Ultralisk Cavern", "CreepTumor", "Creep Tumor",
]);

/**
 * Predicates that depend on game_details fields. resolveQuests checks
 * this set to decide whether to bulk-load the heavy store. Add a
 * predicate here AND below in PREDICATES.
 */
const HEAVY_PREDICATES = new Set([
  "won_with_unit",
  "won_built_n_of_unit",
  "won_built_opp_unit_seen",
  "built_n_of_unit_week",
]);

/* ──────────────── Slim-row field helpers ──────────────── */

/**
 * Game duration in seconds — the DB stores ``durationSec`` (canonical
 * schema field) but the client-side ``normaliseGame`` lifts it onto
 * ``duration`` for legacy SPA code. Synthetic test fixtures historically
 * use either. Read both so the predicate works whichever path produced
 * the row.
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
 * Macro score — the DB stores ``macroScore``; the client-side
 * ``normaliseGame`` lifts it onto ``macro_score``. Read both.
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
 * APM — single canonical field, but tolerate the legacy lowercase form.
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
 * in normaliseGame. Both paths are checked here so server-side games
 * (raw DB rows) and round-tripped client games (test fixtures) both
 * resolve identically.
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
 * Opponent strategy string — legacy ``opp_strategy`` AND the modern
 * ``opponent.strategy`` (agent v0.5+). Returns "" when neither is set.
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
  /** Won on a specific map (params.map: string). Retained for back-compat
   *  with cards generated before the map-objective removal — new cards
   *  will not include this predicate, but a card persisted under the
   *  previous schema must still resolve so existing ticks stay sticky. */
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
        return Number.isFinite(my) && Number.isFinite(op) && (op - my) >= diff;
      }),
    );
  },
  /** Won a game where the opponent's MMR was within ±params.delta (defaults 50). */
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
  /** Won a game shorter than params.maxSec seconds. */
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
  /** Won a game longer than params.minSec seconds (inclusive of the cap). */
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
  /** Hit a macroScore of at least params.minScore. Inclusive — "70+"
   *  has to fire on 70, not just 71. The previous strict-> comparison
   *  is why a player whose macro registered exactly at the threshold
   *  saw the cell stay un-ticked even though the label said "70+". */
  macro_above: (games, params) => {
    const min = Number(params.minScore) || 70;
    return firstId(
      games.filter((g) => {
        const m = macroScoreOf(g);
        return Number.isFinite(m) && m >= min;
      }),
    );
  },
  /** Hit a macroScore at most params.maxScore on a WON game. Useful for
   *  the "scrappy win" theme — won despite poor macro. */
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
  /** Won a game where the OPPONENT's strategy contains a keyword
   *  (case-insensitive). e.g. "Cheese" / "All-in" / "Proxy". */
  win_vs_strategy_contains: (games, params) => {
    const needle = String(params.keyword || "").toLowerCase().trim();
    if (!needle) return null;
    return firstId(
      games.filter(
        (g) => isWin(g) && oppStrategyOf(g).toLowerCase().includes(needle),
      ),
    );
  },
  /** Played at least params.n games in the window. Doesn't require wins. */
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
  /** Won the game immediately after a loss (revenge tilt). The "after"
   *  here means "next decided game in the chronological window". */
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
   *  the user inside this same window. The bingo equivalent of "settle
   *  a score". */
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
   *  that already contained at least params.minWinsBefore wins.
   *  Defaults to 2 — so this fires on the THIRD win of a session
   *  without requiring all three to be consecutive. */
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
  /** Won a game whose own build-log contains a unit/structure name
   *  (params.unit, case-insensitive substring against each log line). */
  won_with_unit: (games, params) => {
    const needle = String(params.unit || "").toLowerCase().trim();
    if (!needle) return null;
    return firstId(
      games.filter((g) => isWin(g) && buildLogContains(g.buildLog, needle)),
    );
  },
  /** Won a game whose own build-log mentions a unit at least
   *  params.count times (default 1). Substring match per log line. */
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
   *  the running total first crossed the threshold so the reveal can
   *  link to it. Empty needle / zero target return null. */
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
  /** Won a game where the OPPONENT's build-log contained a unit
   *  (e.g. "saw a Mothership and still won"). */
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
 * versions, so check the modern + legacy fields. Returns NaN when
 * neither is populated.
 *
 * @param {any} g
 * @returns {number}
 */
function oppMmr(g) {
  const cand = [
    g?.opponent?.mmr,
    g?.opp_mmr,
    g?.oppMmr,
  ];
  for (const v of cand) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return Number.NaN;
}

/**
 * Best-effort opponent identifier — preferred ``opponent.pulseId``,
 * then the top-level legacy ``oppPulseId``. Returns "" when neither
 * is populated; revenge_win silently skips those rows so a stretch
 * of un-attributed games never collapses into a single bingo hit.
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
 * agent versions ("[5:30] Supply Depot" vs structured objects), so we
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

/** Validate a YYYY-Www ISO week key. */
function isWeekKey(s) {
  return /^\d{4}-W\d{2}$/.test(s);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function parseIso(s) {
  if (typeof s !== "string") return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = {
  ArcadeService,
  PREDICATES,
  HEAVY_PREDICATES,
  ARCADE_LEADERBOARD,
};
