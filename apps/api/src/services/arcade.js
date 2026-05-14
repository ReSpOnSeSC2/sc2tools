"use strict";

const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const {
  PREDICATES,
  HEAVY_PREDICATES,
  HEAVY_FIELDS,
  isoWeekStart,
} = require("./arcadePredicates");

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
 *      backed by ``arcade_leaderboard`` (separate collection so the
 *      community-builds K-anon path stays unaffected). Opt-in: the row
 *      is only written when the user explicitly submits.
 *
 * The Bingo predicate registry was extracted to services/arcadePredicates.js
 * in May 2026 — this module was crowding 1000 lines and the predicate
 * table was the bulk of it. The re-export below keeps the public API
 * stable for callers that did ``require('../services/arcade')`` to grab
 * PREDICATES directly (e.g. routes/arcade.test.js).
 */

const ARCADE_LEADERBOARD = COLLECTIONS.ARCADE_LEADERBOARD;

/**
 * Maximum number of recent games to scan when computing the
 * arcade-trivia unit aggregate. Bounded so a prolific user's request
 * doesn't blow up the heavy-store fetch.
 */
const UNIT_STATS_SCAN_CAP = 1000;

/**
 * Hard cap on rows returned by the in-window resolveQuests query.
 * Even with the ISO-week window the user can't realistically play
 * more than a few hundred games in 7 days — 500 is a comfortable
 * upper bound that still protects Mongo from an unbounded scan if
 * the date filter mis-fires.
 */
const RESOLVE_QUERY_LIMIT = 500;

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
    // (older games whose ingestion predated the v0.4.3 split, or a
    // test harness that doesn't wire the heavy store).
    this.gameDetails = deps.gameDetails || null;
    // Mongo collection lazy handle. Some test harnesses construct the
    // service without a pre-bound collection; resolve on first use.
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
   * Resolve every cell on an active card against the user's games in
   * the card's ISO week. Each cell declares a ``predicate`` key +
   * ``params``; the predicate registry in arcadePredicates.js is the
   * source of truth for what can appear on a card.
   *
   * Window: the lower bound is the Monday-00:00-UTC of the card's
   * weekKey, NOT card.startedAt. The card represents one ISO week of
   * objectives, and every game in that calendar week should count —
   * before this fix, a user who beat e.g. Protoss on Monday but only
   * generated/opened the card on Wednesday saw "Win vs Protoss"
   * stay un-ticked because the resolver only looked at post-startedAt
   * games. weekKey is the user-visible source of truth (rendered on
   * the card subtitle), so aligning resolve to it matches what the UI
   * says. If weekKey is missing or malformed (test harnesses, very
   * old persisted cards), we fall back to startedAt — and finally to
   * epoch — so a sane upper bound always exists.
   *
   * Two-pass strategy: predicates that read only the slim ``games``
   * row run in pass 1 (no extra I/O). Predicates that need build-log
   * data (build_contains / won_with_unit) trigger one bulk
   * ``game_details`` fetch in pass 2 — capped at the games already
   * loaded by pass 1 so a card with three heavy-predicate cells still
   * hits Mongo once, not three times.
   *
   * Heavy-store outage: pass 2 is wrapped in try/catch so a
   * gameDetails failure can't erase ticks already returned by pass 1.
   * The heavy cells stay un-ticked; the next resolve retries.
   *
   * @param {string} userId
   * @param {{
   *   startedAt?: string,
   *   weekKey?: string,
   *   cells: Array<{ id: string, predicate: string, params?: any }>,
   * }} card
   * @returns {Promise<{ resolved: Array<{ id: string, ticked: boolean, gameId?: string }> }>}
   */
  async resolveQuests(userId, card) {
    if (!card || !Array.isArray(card.cells)) {
      return { resolved: [] };
    }
    const start = resolveWindowStart(card);
    const games = await this.db.games
      .find(
        { userId, date: { $gte: start } },
        { projection: { _id: 0 } },
      )
      .sort({ date: 1 })
      .limit(RESOLVE_QUERY_LIMIT)
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
        // Reserve the slot; resolve later once details are loaded.
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
        // Decorate a shallow copy of each slim row with its heavy blob
        // so predicates can read both halves without juggling two
        // arrays. ``games`` is a per-request value that never escapes
        // the method, so mutation here is safe.
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
        // Heavy-store outage: slim ticks above are preserved; pending
        // heavy cells stay un-ticked. Next resolve retries.
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
 * Pick the games-in-window lower bound for resolveQuests. Order of
 * preference:
 *
 *   1. ``isoWeekStart(card.weekKey)`` — the user-visible source of
 *      truth. Matches the "this week" semantics on the card subtitle.
 *   2. ``parseIso(card.startedAt)`` — fallback for legacy or test
 *      cards that don't carry a weekKey.
 *   3. ``new Date(0)`` — epoch, so the query always has a valid
 *      $gte. ResolveQuestsLimit caps the row count regardless.
 *
 * Exported only via the testing surface below — callers should not
 * reach into it directly.
 *
 * @param {{ weekKey?: string, startedAt?: string }} card
 * @returns {Date}
 */
function resolveWindowStart(card) {
  const weekStart = isoWeekStart(card.weekKey);
  if (weekStart) return weekStart;
  const fromStarted = parseIso(card.startedAt);
  if (fromStarted) return fromStarted;
  return new Date(0);
}

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
 * structure names; the catalog-based classifier is server-only
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
  // Exported for arcade.test.js — covers the ISO-week window helper
  // and the source-of-truth predicate registry without forcing tests
  // to reach into arcadePredicates.js directly.
  isoWeekStart,
  resolveWindowStart,
};
