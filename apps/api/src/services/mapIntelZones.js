"use strict";

/**
 * Pure binning and hot-zone helpers for the Map Intel heatmaps
 * (services/spatial.js). No I/O: every function is a deterministic
 * function of its inputs, so the fixtures in __tests__/mapIntelZones.test.js
 * fully specify the behaviour.
 *
 * Coordinates are SC2 world units with Y growing upward. A grid cell
 * (x, y) covers [minX + x*w, minX + (x+1)*w) horizontally and
 * [minY + y*h, minY + (y+1)*h) vertically, so row 0 is the bottom edge of
 * the map. The web panel (lib/mapIntel.ts) flips rows when it draws them,
 * the same mapping MapReplayer uses for the layout image.
 */

/** Hot zones listed per layer. */
const ZONE_LIMIT = 5;
/** A zone measures the cells within this fraction of the grid around its peak. */
const ZONE_RADIUS_FRACTION = 0.05;
/** A zone sits "at" a base when its centre is this close to one, as a
 * fraction of the playable diagonal (about 25 world units on a ladder map). */
const BASE_RADIUS_FRACTION = 0.1;
/** Town halls closer than this many world units are one base site. */
const ANCHOR_SNAP = 8;
/** Base sites kept per sample, most used first. */
const MAX_ANCHORS = 16;
/** The first three distinct town halls of a game are its main, natural and third. */
const BASE_ROLES = /** @type {const} */ (["main", "natural", "third"]);

/** @param {unknown} value @returns {value is number} */
function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Grid cell for one world position, or null outside the bounds. A point on
 * the max edge belongs to the last cell; anything beyond the bounds is
 * dropped rather than clamped, so a stray coordinate never paints an edge.
 *
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} bounds
 * @param {number} grid
 * @param {number} x @param {number} y
 * @returns {{ix:number, iy:number} | null}
 */
function cellOf(bounds, grid, x, y) {
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  if (!(w > 0) || !(h > 0)) return null;
  if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) return null;
  const ix = Math.min(grid - 1, Math.floor(((x - bounds.minX) / w) * grid));
  const iy = Math.min(grid - 1, Math.floor(((y - bounds.minY) / h) * grid));
  return { ix, iy };
}

/**
 * Bin each game's points into a ``grid`` x ``grid`` matrix.
 *
 * ``value`` sums point weights (1 when a point has none), ``intensity`` is
 * value over the densest cell, and ``games`` counts the distinct games with
 * a point in the cell. ``games`` on the result counts games that placed at
 * least one point inside the bounds.
 *
 * @param {{minX:number,minY:number,maxX:number,maxY:number} | null} bounds
 * @param {number} grid
 * @param {Array<Array<{x:number,y:number,weight?:number}>>} perGame
 */
function binGamePoints(bounds, grid, perGame) {
  /** @type {Map<number, {value:number, games:number, last:number}>} */
  const cells = new Map();
  let points = 0;
  let games = 0;
  if (!bounds) return { cells: [], points, games };
  perGame.forEach((rows, gameIndex) => {
    let placed = false;
    for (const p of rows) {
      const cell = cellOf(bounds, grid, p.x, p.y);
      if (!cell) continue;
      const key = cell.iy * grid + cell.ix;
      const entry = cells.get(key) || { value: 0, games: 0, last: -1 };
      entry.value += finite(p.weight) && p.weight > 0 ? p.weight : 1;
      if (entry.last !== gameIndex) {
        entry.games += 1;
        entry.last = gameIndex;
      }
      cells.set(key, entry);
      points += 1;
      placed = true;
    }
    if (placed) games += 1;
  });
  let max = 0;
  for (const entry of cells.values()) if (entry.value > max) max = entry.value;
  const out = [];
  for (const [key, entry] of cells) {
    out.push({
      x: key % grid,
      y: Math.floor(key / grid),
      value: round2(entry.value),
      intensity: max ? round3(entry.value / max) : 0,
      games: entry.games,
    });
  }
  out.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  return { cells: out, points, games };
}

/**
 * Base sites from the owner's own town halls: per game the first three
 * distinct town halls by time are its main, natural and third, and each site
 * takes the role it held most often. Sites are map positions, not sides; a
 * main is the main of whichever player spawned there.
 *
 * @param {Array<unknown>} perGameTownHalls the projected ``anchors`` lists
 * @returns {Array<{x:number, y:number, role:"main"|"natural"|"third", games:number}>}
 */
function baseAnchors(perGameTownHalls) {
  /** @type {Array<{x:number,y:number,games:number,roles:number[]}>} */
  const sites = [];
  for (const raw of perGameTownHalls) {
    if (!Array.isArray(raw)) continue;
    const ordered = raw
      .filter((h) => h && finite(h.x) && finite(h.y) && finite(h.time))
      .sort((a, b) => a.time - b.time);
    /** @type {Array<{x:number,y:number}>} */
    const distinct = [];
    for (const hall of ordered) {
      if (distinct.some((seen) => distance(seen, hall) < ANCHOR_SNAP)) continue;
      distinct.push(hall);
      if (distinct.length === BASE_ROLES.length) break;
    }
    distinct.forEach((hall, role) => {
      let site = sites.find((candidate) => distance(candidate, hall) < ANCHOR_SNAP);
      if (!site) {
        site = { x: hall.x, y: hall.y, games: 0, roles: [0, 0, 0] };
        sites.push(site);
      }
      site.games += 1;
      site.roles[role] += 1;
    });
  }
  return sites
    .sort((a, b) => b.games - a.games)
    .slice(0, MAX_ANCHORS)
    .map((site) => ({
      x: round2(site.x),
      y: round2(site.y),
      role: BASE_ROLES[site.roles.indexOf(Math.max(...site.roles))],
      games: site.games,
    }));
}

/**
 * Where on the map a position is, in thirds: "top left", "centre", "right"...
 *
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} bounds
 * @param {number} x @param {number} y
 */
function areaLabel(bounds, x, y) {
  const fx = (x - bounds.minX) / ((bounds.maxX - bounds.minX) || 1);
  const fy = (y - bounds.minY) / ((bounds.maxY - bounds.minY) || 1);
  const col = fx < 1 / 3 ? "left" : fx > 2 / 3 ? "right" : "centre";
  const row = fy > 2 / 3 ? "top" : fy < 1 / 3 ? "bottom" : "middle";
  if (row === "middle") return col;
  if (col === "centre") return row;
  return `${row} ${col}`;
}

/**
 * The top hot zones of a binned layer. Peaks are taken greedily by cell
 * value; a later peak inside an earlier zone's window is skipped, so zones
 * never overlap. Each zone reports its weighted centre, its share of the
 * layer, the distinct games with a point in its window, the nearest base
 * site within reach and its area of the map.
 *
 * @param {{
 *   bounds: {minX:number,minY:number,maxX:number,maxY:number},
 *   grid: number,
 *   cells: Array<{x:number,y:number,value:number}>,
 *   perGame: Array<Array<{x:number,y:number}>>,
 *   anchors: Array<{x:number,y:number,role:string}>,
 * }} input
 */
function hotZones({ bounds, grid, cells, perGame, anchors }) {
  if (!bounds || cells.length === 0) return [];
  const radius = Math.max(1, Math.round(grid * ZONE_RADIUS_FRACTION));
  const total = cells.reduce((sum, cell) => sum + cell.value, 0) || 1;
  const cellW = (bounds.maxX - bounds.minX) / grid;
  const cellH = (bounds.maxY - bounds.minY) / grid;
  const reach = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * BASE_RADIUS_FRACTION;
  const peaks = [...cells].sort((a, b) => (b.value - a.value) || (a.y - b.y) || (a.x - b.x));
  /** @type {Array<{x:number,y:number}>} */
  const taken = [];
  const zones = [];
  for (const peak of peaks) {
    if (zones.length >= ZONE_LIMIT) break;
    if (taken.some((t) => Math.max(Math.abs(t.x - peak.x), Math.abs(t.y - peak.y)) <= radius * 2)) continue;
    taken.push(peak);
    const inside = (/** @type {{x:number,y:number}} */ c) => Math.abs(c.x - peak.x) <= radius && Math.abs(c.y - peak.y) <= radius;
    const window = cells.filter(inside);
    const weight = window.reduce((sum, c) => sum + c.value, 0);
    const x = bounds.minX + (window.reduce((sum, c) => sum + c.value * (c.x + 0.5), 0) / weight) * cellW;
    const y = bounds.minY + (window.reduce((sum, c) => sum + c.value * (c.y + 0.5), 0) / weight) * cellH;
    const games = perGame.filter((rows) => rows.some((p) => {
      const cell = cellOf(bounds, grid, p.x, p.y);
      return cell !== null && inside({ x: cell.ix, y: cell.iy });
    })).length;
    const nearest = nearestAnchor(anchors, x, y);
    zones.push({
      x: round2(x),
      y: round2(y),
      share: round3(weight / total),
      games,
      base: nearest && nearest.distance <= reach ? nearest.role : null,
      area: areaLabel(bounds, x, y),
    });
  }
  return zones;
}

/** @param {Array<{x:number,y:number,role:string}>} anchors @param {number} x @param {number} y */
function nearestAnchor(anchors, x, y) {
  /** @type {{role:string, distance:number} | null} */
  let best = null;
  for (const anchor of anchors) {
    const d = Math.hypot(anchor.x - x, anchor.y - y);
    if (!best || d < best.distance) best = { role: anchor.role, distance: d };
  }
  return best;
}

/** @param {{x:number,y:number}} a @param {{x:number,y:number}} b */
function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** @param {number} n */
function round2(n) { return Math.round(n * 100) / 100; }
/** @param {number} n */
function round3(n) { return Math.round(n * 1000) / 1000; }

module.exports = {
  ZONE_LIMIT,
  BASE_ROLES,
  cellOf,
  binGamePoints,
  baseAnchors,
  areaLabel,
  hotZones,
};
