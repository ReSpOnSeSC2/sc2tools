"use strict";

const { gamesMatchStage } = require("../util/parseQuery");
const {
  runPythonNdjson,
  pythonAvailable,
  writeTempFile,
  PythonError,
} = require("../util/pythonRunner");

const SPATIAL_DEFAULT_GRID = 64;
const SPATIAL_MAX_GAMES = 5000;

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
   * @param {string} userId
   * @param {object} filters
   * @returns {Promise<Array<{
   *   name: string,
   *   total: number,
   *   wins: number,
   *   losses: number,
   *   winRate: number,
   *   lastPlayed: Date | null,
   *   hasSpatial: boolean,
   *   bounds: object | null,
   * }>>}
   */
  async maps(userId, filters) {
    const match = gamesMatchStage(userId, filters);
    const rows = await this.db.games
      .aggregate([
        { $match: match },
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
            spatialSamples: {
              $sum: {
                $cond: [{ $ifNull: ["$spatial.map_bounds", false] }, 1, 0],
              },
            },
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
    return rows;
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
    return this._heatmap(userId, map, filters, "spatial.my_proxies", "proxy", opts);
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
    return this._heatmap(userId, map, filters, "spatial.opp_proxies", "opp_proxy", opts);
  }

  /**
   * @private
   * @param {string} userId
   * @param {string} map
   * @param {object} filters
   * @param {string} field   dotted path on the game doc
   * @param {string} kind    label echoed in the response
   * @param {{ grid?: number }} opts
   */
  async _heatmap(userId, map, filters, field, kind, opts) {
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
          },
        },
      ])
      .toArray();
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
    if (pythonAvailable()) {
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
