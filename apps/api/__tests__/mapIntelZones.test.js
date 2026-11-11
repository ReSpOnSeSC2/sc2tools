// @ts-nocheck
"use strict";

const {
  ZONE_LIMIT,
  areaLabel,
  baseAnchors,
  binGamePoints,
  cellOf,
  hotZones,
} = require("../src/services/mapIntelZones");

// 200 world units over a 20-cell grid: each cell is 10 units square.
const BOUNDS = { minX: 0, minY: 0, maxX: 200, maxY: 200 };

describe("services/mapIntelZones cellOf", () => {
  test("rows count up from the bottom edge and the max edge is the last cell", () => {
    expect(cellOf(BOUNDS, 20, 0, 0)).toEqual({ ix: 0, iy: 0 });
    expect(cellOf(BOUNDS, 20, 15, 195)).toEqual({ ix: 1, iy: 19 });
    expect(cellOf(BOUNDS, 20, 200, 200)).toEqual({ ix: 19, iy: 19 });
  });

  test("a position outside the playable bounds is dropped, never clamped", () => {
    expect(cellOf(BOUNDS, 20, -0.5, 10)).toBeNull();
    expect(cellOf(BOUNDS, 20, 10, 200.5)).toBeNull();
    expect(cellOf({ minX: 5, minY: 5, maxX: 5, maxY: 9 }, 20, 5, 6)).toBeNull();
  });
});

describe("services/mapIntelZones binGamePoints", () => {
  test("sums weights, normalises to the densest cell and counts distinct games per cell", () => {
    const out = binGamePoints(BOUNDS, 20, [
      [{ x: 15, y: 15 }, { x: 16, y: 14, weight: 3 }],
      [{ x: 12, y: 11 }],
      [{ x: 150, y: 150, weight: 2 }, { x: 999, y: 999 }],
      [{ x: -5, y: 10 }],
    ]);
    expect(out.points).toBe(4);
    // The fourth game placed nothing inside the bounds.
    expect(out.games).toBe(3);
    expect(out.cells).toEqual([
      { x: 1, y: 1, value: 5, intensity: 1, games: 2 },
      { x: 15, y: 15, value: 2, intensity: 0.4, games: 1 },
    ]);
  });

  test("no bounds bins nothing", () => {
    expect(binGamePoints(null, 20, [[{ x: 1, y: 1 }]])).toEqual({ cells: [], points: 0, games: 0 });
  });
});

describe("services/mapIntelZones baseAnchors", () => {
  test("the first three distinct town halls of a game are its main, natural and third", () => {
    const anchors = baseAnchors([
      // Spawned bottom left. A rebuilt main at the same spot is not a new base.
      [
        { x: 30, y: 30, time: 0 },
        { x: 31, y: 30, time: 400 },
        { x: 60, y: 30, time: 60 },
        { x: 90, y: 40, time: 200 },
        { x: 120, y: 120, time: 500 },
      ],
      // Spawned top right; this game's natural is that side's natural.
      [
        { x: 170, y: 170, time: 0 },
        { x: 140, y: 170, time: 70 },
      ],
      // Bottom left again, with the town halls out of order in the list.
      [
        { x: 61, y: 31, time: 55 },
        { x: 29, y: 30, time: 0 },
      ],
      "not a list",
      [{ x: 10, y: Number.NaN, time: 0 }],
    ]);
    expect(anchors).toEqual([
      { x: 30, y: 30, role: "main", games: 2 },
      { x: 60, y: 30, role: "natural", games: 2 },
      { x: 90, y: 40, role: "third", games: 1 },
      { x: 170, y: 170, role: "main", games: 1 },
      { x: 140, y: 170, role: "natural", games: 1 },
    ]);
  });
});

describe("services/mapIntelZones areaLabel", () => {
  test.each([
    [10, 190, "top left"],
    [100, 190, "top"],
    [190, 100, "right"],
    [100, 100, "centre"],
    [10, 10, "bottom left"],
  ])("(%d, %d) is %s", (x, y, label) => {
    expect(areaLabel(BOUNDS, x, y)).toBe(label);
  });
});

describe("services/mapIntelZones hotZones", () => {
  test("zones are disjoint peaks with their share, game count and nearest base", () => {
    const perGame = [
      [{ x: 62, y: 32 }, { x: 64, y: 34 }],
      [{ x: 63, y: 31 }],
      [{ x: 150, y: 150 }],
    ];
    const binned = binGamePoints(BOUNDS, 20, perGame);
    const zones = hotZones({
      bounds: BOUNDS,
      grid: 20,
      cells: binned.cells,
      perGame,
      anchors: [{ x: 60, y: 30, role: "natural" }, { x: 30, y: 30, role: "main" }],
    });
    expect(zones).toEqual([
      { x: 65, y: 35, share: 0.75, games: 2, base: "natural", area: "bottom left" },
      // No base within reach of the centre of the top-right quadrant.
      { x: 155, y: 155, share: 0.25, games: 1, base: null, area: "top right" },
    ]);
  });

  test("a later peak inside an earlier zone is part of it, and at most five zones are listed", () => {
    const perGame = [Array.from({ length: 12 }, (_, i) => ({ x: 5 + i * 16, y: 5 + i * 16, weight: 12 - i }))];
    perGame[0].push({ x: 15, y: 5, weight: 11.5 });
    const binned = binGamePoints(BOUNDS, 20, perGame);
    const zones = hotZones({ bounds: BOUNDS, grid: 20, cells: binned.cells, perGame, anchors: [] });
    expect(zones).toHaveLength(ZONE_LIMIT);
    // The 11.5-weight neighbour of the first peak never opens its own zone.
    expect(zones.some((zone) => zone.x === 15 && zone.y === 5)).toBe(false);
    expect(zones.every((zone) => zone.base === null)).toBe(true);
  });

  test("an empty layer has no zones", () => {
    expect(hotZones({ bounds: BOUNDS, grid: 20, cells: [], perGame: [], anchors: [] })).toEqual([]);
  });
});
