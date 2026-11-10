"use strict";

const { gamesMatchStage } = require("../util/parseQuery");
const { OwnerRevisions } = require("../util/gameVisibility");
const { attachRecentByMap } = require("./recentResults");
const { requestKey } = require("./trendsRequests");
const { proxyEvidence } = require("./proxyClassification");
const { baseAnchors, binGamePoints, hotZones } = require("./mapIntelZones");

const SPATIAL_DEFAULT_GRID = 64;
/** The heatmaps read the most recent games with map data, never more. */
const MAP_INTEL_MAX_GAMES = 300;
/** A map-wide layer needs this many contributing games to show a pattern. */
const MAP_INTEL_MIN_GAMES = 3;
/** One opponent's layer shows every observed game: one game is a fact. */
const MAP_INTEL_OPPONENT_MIN_GAMES = 1;
/** Rows read per game and layer. The building list holds up to 2000. */
const LAYER_ROW_CAP = Object.freeze({ buildings: 400, proxy: 100, other: 200 });
/** Town halls read per game for the base labels. */
const ANCHOR_ROW_CAP = 12;
const MAP_INTEL_CACHE_TTL_MS = 10 * 60 * 1000;
const MAP_INTEL_CACHE_MAX = 128;

/**
 * The town halls ``ownerMain`` (services/proxyClassification.js) reads to
 * find a player's main. The own-side proxy heatmap projects only these rows
 * of ``spatial.buildings`` — the full list is up to 2000 rows a game.
 * spatial.test.js checks the list against ``ownerMain``.
 */
const MAIN_TOWN_HALL_NAMES = [
  "Nexus", "Hatchery", "CommandCenter", "OrbitalCommand", "PlanetaryFortress",
];

/**
 * In-process LRU for the heatmap answers, keyed by owner, map, layer,
 * filters and opponent. Each entry carries the owner's revision token, so
 * an ingest, hide or delete retires every answer for that owner at once, and
 * an answer computed across such a change is never stored.
 */
class MapIntelCache {
  /** @param {{ttlMs?: number, max?: number, now?: () => number}} [opts] */
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs ?? MAP_INTEL_CACHE_TTL_MS;
    this.max = opts.max ?? MAP_INTEL_CACHE_MAX;
    this.now = opts.now || Date.now;
    this.revisions = new OwnerRevisions();
    /** @type {Map<string, {owner: string, revision: {id: number}, expiresAt: number, value: any}>} */
    this.entries = new Map();
  }

  /** @param {string} owner */
  token(owner) { return this.revisions.get(owner); }

  /** @param {string} owner @param {string} key */
  get(owner, key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now() || !this.revisions.current(owner, entry.revision)) {
      this.entries.delete(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return structuredClone(entry.value);
  }

  /** @param {string} owner @param {string} key @param {{id: number}} revision @param {any} value */
  set(owner, key, revision, value) {
    if (!this.revisions.current(owner, revision)) return;
    this.entries.delete(key);
    while (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { owner, revision, expiresAt: this.now() + this.ttlMs, value: structuredClone(value) });
  }

  /** @param {string} owner */
  invalidate(owner) {
    this.revisions.invalidate(owner);
    for (const [key, entry] of this.entries) if (entry.owner === owner) this.entries.delete(key);
  }
}

/**
 * SpatialService — heatmap and per-map aggregates.
 *
 * The agent extracts per-game spatial point arrays from each replay and the
 * ingest stores a bounded copy on the slim game row under ``spatial.*``
 * (games.js ``sanitizeSpatial``). The heatmap routes bin the most recent
 * MAP_INTEL_MAX_GAMES games with map data in plain JS — never a child
 * process — and cache each answer for ten minutes per owner revision.
 */
class SpatialService {
  /**
   * @param {{games: import('mongodb').Collection}} db
   * @param {{cache?: MapIntelCache}} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.cache = opts.cache || new MapIntelCache();
  }

  /** Retire every cached heatmap of one owner (ingest, hide, delete).
   * @param {string} userId */
  invalidateForUser(userId) {
    this.cache.invalidate(userId);
  }

  /**
   * List every map the user has games on, with W/L/winRate so the SPA
   * map page renders the same shape it did in the legacy analyzer.
   *
   * Includes maps with no spatial extracts. The `hasSpatial` flag
   * tells the heatmap viewer whether buildings/proxy/battle/death-zone
   * layers will produce results for that map.
   *
   * @typedef {{
   *   name: string,
   *   total: number,
   *   wins: number,
   *   losses: number,
   *   winRate: number,
   *   lastPlayed: Date | null,
   *   hasSpatial: boolean,
   *   bounds: object | null,
   *   recent: Array<'win' | 'loss'>,
   * }} SpatialMapRow
   *
   * @param {string} userId
   * @param {object} filters
   * @returns {Promise<SpatialMapRow[]>}
   */
  async maps(userId, filters) {
    const match = gamesMatchStage(userId, filters);
    const rows = await this.db.games
      .aggregate([
        { $match: match },
        // Sort spatially-extracted docs to the head of each group so
        // ``$first`` on bounds/spatialSamples/etc. always picks a doc
        // that actually has spatial data when the map has any. The
        // previous version used the natural order, which dropped
        // ``bounds`` to ``null`` whenever the most-recent replay on
        // a map predated the spatial-extract pipeline.
        {
          $addFields: {
            _hasBounds: {
              $cond: [{ $ifNull: ["$spatial.map_bounds", false] }, 1, 0],
            },
          },
        },
        { $sort: { _hasBounds: -1, date: -1 } },
        {
          $group: {
            _id: { $ifNull: ["$map", "Unknown"] },
            total: { $sum: 1 },
            wins: {
              $sum: {
                $cond: [
                  {
                    $in: [
                      { $toLower: { $ifNull: ["$result", ""] } },
                      ["victory", "win"],
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            losses: {
              $sum: {
                $cond: [
                  {
                    $in: [
                      { $toLower: { $ifNull: ["$result", ""] } },
                      ["defeat", "loss"],
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            lastPlayed: { $max: "$date" },
            spatialSamples: { $sum: "$_hasBounds" },
            // After the sort above, ``$first`` is now deterministic:
            // a bounds-having doc if any exist, else the most recent
            // doc on the map (yielding null bounds — which is what we
            // want the SPA to see so it can show "no spatial yet").
            bounds: { $first: "$spatial.map_bounds" },
          },
        },
        {
          $project: {
            _id: 0,
            name: "$_id",
            total: 1,
            wins: 1,
            losses: 1,
            lastPlayed: 1,
            bounds: 1,
            hasSpatial: { $gt: ["$spatialSamples", 0] },
            winRate: {
              $cond: [
                { $gt: [{ $add: ["$wins", "$losses"] }, 0] },
                { $divide: ["$wins", { $add: ["$wins", "$losses"] }] },
                0,
              ],
            },
          },
        },
        { $sort: { total: -1, name: 1 } },
      ])
      .toArray();
    // Attach the SPA's "form sparkline" data so Map Intel's trend
    // column matches the Battlefield/Maps tab's behaviour. Cheap
    // second pass — the SPA renders a single inline list per row.
    // Casts: the driver types rows as ``Document`` even though the
    // $project pins the shape, and attachRecentByMap echoes its loose
    // ``{name} & Record`` row type back rather than the full row.
    return /** @type {Promise<SpatialMapRow[]>} */ (
      attachRecentByMap(this.db, userId, filters, /** @type {Array<{name: string} & Record<string, any>>} */ (rows))
    );
  }

  /**
   * Building-placement heatmap for the user's race on a specific map.
   *
   * @param {string} userId
   * @param {string} map
   * @param {import('../util/parseQuery').GlobalFilters} filters
   * @param {HeatmapOptions} [opts]
   */
  async buildings(userId, map, filters, opts = {}) {
    return this._heatmap(userId, map, filters, "spatial.buildings", "buildings", opts);
  }

  /**
   * Proxy / forward-base heatmap (the user's own proxies).
   *
   * @param {string} userId
   * @param {string} map
   * @param {import('../util/parseQuery').GlobalFilters} filters
   * @param {HeatmapOptions} [opts]
   */
  async proxy(userId, map, filters, opts = {}) {
    return this._heatmap(userId, map, filters, "spatial.my_proxies", "proxy", opts, "my");
  }

  /**
   * Battle heatmap — locations of large army engagements.
   *
   * @param {string} userId
   * @param {string} map
   * @param {import('../util/parseQuery').GlobalFilters} filters
   * @param {HeatmapOptions} [opts]
   */
  async battle(userId, map, filters, opts = {}) {
    return this._heatmap(userId, map, filters, "spatial.battles", "battle", opts);
  }

  /**
   * "Death-zone" heatmap — where the user's army died.
   *
   * @param {string} userId
   * @param {string} map
   * @param {import('../util/parseQuery').GlobalFilters} filters
   * @param {HeatmapOptions} [opts]
   */
  async deathZone(userId, map, filters, opts = {}) {
    return this._heatmap(userId, map, filters, "spatial.deaths", "death", opts);
  }

  /**
   * Opponent proxy heatmap — locations where opponents proxied
   * against the user.
   *
   * @param {string} userId
   * @param {string} map
   * @param {import('../util/parseQuery').GlobalFilters} filters
   * @param {HeatmapOptions} [opts]
   */
  async opponentProxies(userId, map, filters, opts = {}) {
    return this._heatmap(userId, map, filters, "spatial.opp_proxies", "opp_proxy", opts, "opp");
  }

  /**
   * One heatmap layer of one map, from the latest MAP_INTEL_MAX_GAMES games
   * with map data that match the filters (and the opponent, when given).
   *
   * Sample semantics travel with the answer: ``scanned`` games were read,
   * ``games`` of them placed a point on this layer, ``capped`` says older
   * games exist beyond the read, and ``belowMinimum`` says ``games`` is under
   * ``minGames`` — the panel then shows the count instead of a pattern.
   *
   * @private
   * @param {string} userId
   * @param {string} map
   * @param {import('../util/parseQuery').GlobalFilters} filters
   * @param {string} field   dotted path on the game doc
   * @param {string} kind    label echoed in the response
   * @param {HeatmapOptions} opts
   * @param {"my" | "opp"} [proxySide] set by the two proxy heatmaps, whose
   *   stored rows are resolved to the canonical proxy test before plotting
   */
  async _heatmap(userId, map, filters, field, kind, opts, proxySide) {
    if (!map || typeof map !== "string") throw httpError(400, "map_required");
    const grid = clampGrid(opts.grid);
    const opponent = opts.opponent || null;
    const key = requestKey(["heatmap", userId, map, kind, grid, filters || {}, opponent]);
    const cached = key === null ? null : this.cache.get(userId, key);
    if (cached) return cached;
    const revision = this.cache.token(userId);
    const result = await this._computeHeatmap({ userId, map, filters, field, kind, grid, opponent, proxySide });
    if (key !== null) this.cache.set(userId, key, revision, result);
    return result;
  }

  /**
   * @private
   * @param {{userId: string, map: string, filters: import('../util/parseQuery').GlobalFilters,
   *   field: string, kind: string, grid: number, opponent: Record<string, any> | null,
   *   proxySide?: "my" | "opp"}} input
   */
  async _computeHeatmap({ userId, map, filters, field, kind, grid, opponent, proxySide }) {
    const exact = filters && Array.isArray(filters.mapExact) && filters.mapExact.length > 0
      ? { $in: filters.mapExact }
      : map;
    const match = {
      ...gamesMatchStage(userId, filters),
      map: exact,
      "spatial.map_bounds": { $exists: true },
    };
    const docs = /** @type {Array<Record<string, any>>} */ (await this.db.games
      .aggregate([
        { $match: opponent ? { $and: [match, opponent] } : match },
        { $sort: { date: -1 } },
        // One extra row tells a full sample from a capped one.
        { $limit: MAP_INTEL_MAX_GAMES + 1 },
        {
          $project: {
            _id: 0,
            gameId: 1,
            mapBounds: "$spatial.map_bounds",
            points: layerRows(field, proxySide),
            anchors: townHallAnchors(),
            ...(proxySide ? proxyStampProjection(proxySide) : {}),
          },
        },
      ])
      .toArray());
    const capped = docs.length > MAP_INTEL_MAX_GAMES;
    const sample = capped ? docs.slice(0, MAP_INTEL_MAX_GAMES) : docs;
    if (proxySide) {
      for (const doc of sample) doc.points = canonicalProxyPoints(doc, proxySide);
    }
    const minGames = opponent ? MAP_INTEL_OPPONENT_MIN_GAMES : MAP_INTEL_MIN_GAMES;
    const bounds = sample.length > 0 ? sample[0].mapBounds || inferBoundsFromPoints(sample) : null;
    const perGame = sample.map((doc) => plottableRows(doc.points));
    const binned = binGamePoints(bounds, grid, perGame);
    const anchors = baseAnchors(sample.map((doc) => doc.anchors));
    return {
      ok: true,
      kind,
      map,
      grid,
      bounds,
      points: binned.points,
      games: binned.games,
      scanned: sample.length,
      capped,
      maxGames: MAP_INTEL_MAX_GAMES,
      minGames,
      belowMinimum: binned.games < minGames,
      cells: binned.cells,
      zones: bounds ? hotZones({ bounds, grid, cells: binned.cells, perGame, anchors }) : [],
    };
  }
}

/**
 * @typedef {{
 *   grid?: number,
 *   opponent?: Record<string, any> | null,
 * }} HeatmapOptions ``opponent`` is an owner-scoped identity clause from
 *   OpponentsService.identityClause (pulse ids and character ids, merged
 *   identities included), ANDed with the map match.
 */

/**
 * The bounded rows one layer reads per game. Proxy rows keep their name and
 * time for the canonical proxy test; every other layer needs only a position
 * and its weight.
 *
 * @param {string} field
 * @param {"my" | "opp"} [proxySide]
 */
function layerRows(field, proxySide) {
  const path = `$${field}`;
  const rows = { $cond: [{ $isArray: path }, path, []] };
  if (proxySide) return { $slice: [rows, LAYER_ROW_CAP.proxy] };
  const cap = field === "spatial.buildings" ? LAYER_ROW_CAP.buildings : LAYER_ROW_CAP.other;
  return {
    $map: {
      input: { $slice: [rows, cap] },
      as: "row",
      in: { x: "$$row.x", y: "$$row.y", weight: "$$row.weight" },
    },
  };
}

/** The owner's first town halls of each game, for the base labels. */
function townHallAnchors() {
  return {
    $map: {
      input: {
        $slice: [{
          $filter: {
            input: { $cond: [{ $isArray: "$spatial.buildings" }, "$spatial.buildings", []] },
            as: "building",
            cond: { $in: ["$$building.name", MAIN_TOWN_HALL_NAMES] },
          },
        }, ANCHOR_ROW_CAP],
      },
      as: "hall",
      in: { x: "$$hall.x", y: "$$hall.y", time: "$$hall.time" },
    },
  };
}

/** Finite positions only; anything else in a stored row is skipped.
 * @param {unknown} rows @returns {Array<{x: number, y: number, weight?: number}>} */
function plottableRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => row && typeof row === "object"
    && Number.isFinite(row.x) && Number.isFinite(row.y));
}

/**
 * Extra ``$project`` fields a proxy heatmap needs to resolve its stored rows
 * (see ``canonicalProxyPoints``).
 *
 * @param {"my" | "opp"} side
 * @returns {Record<string, any>}
 */
function proxyStampProjection(side) {
  const version = `$spatial.${side}_proxy_classification_v`;
  /** @type {Record<string, any>} */
  const fields = { proxyVersion: version };
  // Only the user's own buildings are stored, and only a version-1 row is
  // re-tested against its main, so Mongo returns the town halls of those
  // games and nothing of ``spatial.buildings`` for the rest.
  if (side === "my") {
    fields.townHalls = {
      $cond: [
        { $and: [{ $eq: [version, 1] }, { $isArray: "$spatial.buildings" }] },
        {
          $filter: {
            input: "$spatial.buildings",
            as: "building",
            cond: { $in: ["$$building.name", MAIN_TOWN_HALL_NAMES] },
          },
        },
        "$$REMOVE",
      ],
    };
  }
  return fields;
}

/**
 * One game's stored proxy rows, resolved to the canonical proxy test
 * (services/proxyClassification.js): farther from the owner's main than 80
 * world units for town halls, gas and Spine / Spore Crawlers, 50 for every
 * other structure.
 *
 * A version-2 stamp already used that test and is plotted as stored. A
 * version-1 stamp (agents from 0.16.0) tested every structure at 50 units,
 * so it lists a standard third base and its gas / crawlers, 50-80 units out:
 *   - Own side: those rows are re-tested at 80 units against the main found
 *     in the projected town halls, and the third base is dropped.
 *   - Opponent side: their main is not stored, so ``proxyEvidence`` can only
 *     mark those rows ``ambiguous``. They are dropped, not plotted. A third
 *     base is in almost every macro game and a proxy Hatchery is rare, so
 *     keeping them would paint the opponent's third base on every map; the
 *     cost is that a real proxy Hatchery or Spine Crawler rush from a
 *     version-1 game is missing. Their 50-unit structures (Barracks,
 *     Gateway, Pylon, Photon Cannon...) are unaffected.
 * An own-side row whose main cannot be established is ``ambiguous`` too and
 * is dropped for the same reason.
 *
 * Rows with no stamp are plotted as stored: agents before 0.16.0 listed
 * structures within 50 units of the other player's main, a test that never
 * included a third base.
 *
 * @param {{points?: any, proxyVersion?: any, townHalls?: any}} doc
 * @param {"my" | "opp"} side
 * @returns {any[]}
 */
function canonicalProxyPoints(doc, side) {
  const { rows } = proxyEvidence(
    {
      [`${side}_proxies`]: doc.points,
      [`${side}_proxy_classification_v`]: doc.proxyVersion,
      buildings: doc.townHalls,
    },
    side,
  );
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => !(row && row.ambiguous === true));
}

/** @param {Array<{points?: any[]}>} docs */
function inferBoundsFromPoints(docs) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let any = false;
  for (const d of docs) {
    if (!Array.isArray(d.points)) continue;
    for (const p of d.points) {
      if (!p || typeof p.x !== "number" || typeof p.y !== "number") continue;
      any = true;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!any) return null;
  return { minX, minY, maxX, maxY };
}

/** @param {unknown} raw */
function clampGrid(raw) {
  const n = Number.parseInt(String(raw || ""), 10);
  if (!Number.isFinite(n) || n <= 0) return SPATIAL_DEFAULT_GRID;
  return Math.min(256, Math.max(8, n));
}

/** @param {number} status @param {string} code */
function httpError(status, code) {
  const err = new Error(code);
  /** @type {any} */ (err).status = status;
  /** @type {any} */ (err).code = code;
  return err;
}

module.exports = {
  SpatialService,
  MapIntelCache,
  MAP_INTEL_MAX_GAMES,
  MAP_INTEL_MIN_GAMES,
  MAP_INTEL_OPPONENT_MIN_GAMES,
};
