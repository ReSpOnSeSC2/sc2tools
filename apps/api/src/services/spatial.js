"use strict";

const { gamesMatchStage } = require("../util/parseQuery");
const { attachRecentByMap } = require("./recentResults");
const {
  runPythonNdjson,
  pythonAvailable,
  writeTempFile,
  PythonError,
} = require("../util/pythonRunner");
const { proxyEvidence } = require("./proxyClassification");

const SPATIAL_DEFAULT_GRID = 64;
const SPATIAL_MAX_GAMES = 5000;

/**
 * The town halls ``ownerMain`` (services/proxyClassification.js) reads to
 * find a player's main. The own-side proxy heatmap projects only these rows
 * of ``spatial.buildings`` — the full list is up to 2000 rows a game, times
 * SPATIAL_MAX_GAMES. spatial.test.js checks the list against ``ownerMain``.
 */
const MAIN_TOWN_HALL_NAMES = [
  "Nexus", "Hatchery", "CommandCenter", "OrbitalCommand", "PlanetaryFortress",
];

/**
 * SpatialService — heatmap and per-map aggregates.
 *
 * The legacy /spatial/{maps,buildings,proxy,battle,death-zone,
 * opponent-proxies} endpoints all operated on per-game spatial point
 * arrays the agent extracted from each replay. The cloud port stores
 * those same arrays in the game documents under `spatial.*` keys, so
 * the routes are mostly Mongo aggregations.
 *
 * Where the legacy code rasterised points into a heatmap grid via
 * scripts/spatial_cli.py (scipy KDE), we keep that same pattern: the
 * service writes the candidate points to a tmp NDJSON file and shells
 * out to spatial_cli.py — but the route can also fall back to a pure
 * JS bin counter when scipy isn't available.
 */
class SpatialService {
  /** @param {{games: import('mongodb').Collection}} db */
  constructor(db) {
    this.db = db;
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
   * @param {object} filters
   * @param {{ grid?: number }} [opts]
   */
  async buildings(userId, map, filters, opts = {}) {
    return this._heatmap(userId, map, filters, "spatial.buildings", "buildings", opts);
  }

  /**
   * Proxy / forward-base heatmap (the user's own proxies).
   *
   * @param {string} userId
   * @param {string} map
   * @param {object} filters
   * @param {{ grid?: number }} [opts]
   */
  async proxy(userId, map, filters, opts = {}) {
    return this._heatmap(userId, map, filters, "spatial.my_proxies", "proxy", opts, "my");
  }

  /**
   * Battle heatmap — locations of large army engagements.
   *
   * @param {string} userId
   * @param {string} map
   * @param {object} filters
   * @param {{ grid?: number }} [opts]
   */
  async battle(userId, map, filters, opts = {}) {
    return this._heatmap(userId, map, filters, "spatial.battles", "battle", opts);
  }

  /**
   * "Death-zone" heatmap — where the user's army died.
   *
   * @param {string} userId
   * @param {string} map
   * @param {object} filters
   * @param {{ grid?: number }} [opts]
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
   * @param {object} filters
   * @param {{ grid?: number }} [opts]
   */
  async opponentProxies(userId, map, filters, opts = {}) {
    return this._heatmap(userId, map, filters, "spatial.opp_proxies", "opp_proxy", opts, "opp");
  }

  /**
   * @private
   * @param {string} userId
   * @param {string} map
   * @param {object} filters
   * @param {string} field   dotted path on the game doc
   * @param {string} kind    label echoed in the response
   * @param {{ grid?: number }} opts
   * @param {"my" | "opp"} [proxySide] set by the two proxy heatmaps, whose
   *   stored rows are resolved to the canonical proxy test before plotting
   */
  async _heatmap(userId, map, filters, field, kind, opts, proxySide) {
    if (!map || typeof map !== "string") throw httpError(400, "map_required");
    const grid = clampGrid(opts.grid);
    const baseMatch = {
      ...gamesMatchStage(userId, filters),
      map,
      [field]: { $exists: true, $not: { $size: 0 } },
    };
    const docs = await this.db.games
      .aggregate([
        { $match: baseMatch },
        { $sort: { date: -1 } },
        { $limit: SPATIAL_MAX_GAMES },
        {
          $project: {
            _id: 0,
            gameId: 1,
            mapBounds: "$spatial.map_bounds",
            points: `$${field}`,
            ...(proxySide ? proxyStampProjection(proxySide) : {}),
          },
        },
      ])
      .toArray();
    if (proxySide) {
      for (const doc of docs) doc.points = canonicalProxyPoints(doc, proxySide);
    }
    if (docs.length === 0) {
      return {
        ok: true,
        kind,
        map,
        grid,
        points: 0,
        bounds: null,
        cells: [],
      };
    }
    const bounds = docs[0].mapBounds || inferBoundsFromPoints(docs);
    const points = flattenPoints(docs);
    // The canonical test can leave nothing to plot (every stored row was a
    // third base); the JS path answers that without spawning python.
    if (points.length > 0 && pythonAvailable()) {
      try {
        return await this._runPythonHeatmap({ kind, map, grid, bounds, points });
      } catch (err) {
        if (!(err instanceof PythonError)) throw err;
        // Fall through to JS path on python failure — never 5xx the
        // SPA just because scipy isn't available.
      }
    }
    return jsHeatmap({ kind, map, grid, bounds, points });
  }

  /**
   * @private
   * @param {{ kind: string, map: string, grid: number, bounds: any, points: any[] }} args
   */
  async _runPythonHeatmap({ kind, map, grid, bounds, points }) {
    const ndjson = points.map(/** @param {any} p */ (p) => JSON.stringify(p)).join("\n");
    const tmp = writeTempFile(`spatial-${kind}`, "ndjson", ndjson);
    try {
      const records = await runPythonNdjson({
        script: "scripts/spatial_cli.py",
        args: [
          "kde",
          "--input",
          tmp,
          "--grid",
          String(grid),
          "--bounds",
          JSON.stringify(bounds),
          "--kind",
          kind,
        ],
      });
      const result = /** @type {any} */ (
        records.find((r) => r && /** @type {any} */ (r).ok)
      );
      if (!result) {
        throw new PythonError("spatial_cli_no_result", { kind: "no_result" });
      }
      return {
        ok: true,
        kind,
        map,
        grid,
        bounds,
        points: points.length,
        cells: Array.isArray(result.cells) ? result.cells : [],
      };
    } finally {
      try {
        require("fs").unlinkSync(tmp);
      } catch (_e) {
        // best-effort
      }
    }
  }
}

/**
 * Pure-JS fallback for the heatmap: bin every point into a `grid x
 * grid` matrix and return the non-empty cells. Cells are normalised
 * to the densest cell so the SPA's existing colour scale works.
 */
/**
 * @param {{ kind: string, map: string, grid: number, bounds: any, points: any[] }} args
 */
function jsHeatmap({ kind, map, grid, bounds, points }) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  if (!bounds || points.length === 0) {
    return { ok: true, kind, map, grid, bounds, points: points.length, cells: [] };
  }
  const xRange = bounds.maxX - bounds.minX || 1;
  const yRange = bounds.maxY - bounds.minY || 1;
  for (const p of points) {
    if (typeof p.x !== "number" || typeof p.y !== "number") continue;
    const ix = Math.min(grid - 1, Math.max(0, Math.floor(((p.x - bounds.minX) / xRange) * grid)));
    const iy = Math.min(grid - 1, Math.max(0, Math.floor(((p.y - bounds.minY) / yRange) * grid)));
    const k = `${ix},${iy}`;
    counts.set(k, (counts.get(k) || 0) + (p.weight || 1));
  }
  let max = 0;
  for (const v of counts.values()) {
    if (v > max) max = v;
  }
  const cells = [];
  for (const [key, value] of counts) {
    const [ix, iy] = key.split(",").map(Number);
    cells.push({ x: ix, y: iy, value, intensity: max ? value / max : 0 });
  }
  return {
    ok: true,
    kind,
    map,
    grid,
    bounds,
    points: points.length,
    cells,
  };
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
function flattenPoints(docs) {
  /** @type {any[]} */
  const out = [];
  for (const d of docs) {
    if (!Array.isArray(d.points)) continue;
    for (const p of d.points) {
      if (!p || typeof p !== "object") continue;
      out.push(p);
    }
  }
  return out;
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

module.exports = { SpatialService };
