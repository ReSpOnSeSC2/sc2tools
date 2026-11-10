import { describe, expect, it } from "vitest";
import {
  MAP_INTEL_GRID,
  belowMinimumText,
  cellRect,
  heatAlpha,
  mapIntelPath,
  sampleCaption,
  stageAspect,
  worldToStage,
  zoneDetail,
  zoneLabel,
} from "@/lib/mapIntel";
import { projectX, projectY, worldProjection } from "@/lib/mapReplay";

/**
 * Bounds alignment fixtures: playable bounds and start locations of ladder
 * maps, from apps/replay-engine/data/map_bounds.json (the same source the
 * agent's spatial extract and the replayer use), square and non-square.
 */
const MAPS = [
  { map: "Equilibrium LE", bounds: { minX: 8, minY: 8, maxX: 184, maxY: 184 }, starts: [[28.5, 156.5], [163.5, 35.5]] },
  { map: "Goldenaura LE", bounds: { minX: 12, minY: 12, maxX: 188, maxY: 188 }, starts: [[33.5, 161.5], [166.5, 38.5]] },
  { map: "Site Delta LE", bounds: { minX: 12, minY: 16, maxX: 180, maxY: 184 }, starts: [[33.5, 156.5], [158.5, 43.5]] },
  { map: "Hard Lead LE", bounds: { minX: 8, minY: 8, maxX: 192, maxY: 168 }, starts: [[26.5, 140.5], [173.5, 35.5]] },
  { map: "Crimson Court LE", bounds: { minX: 8, minY: 8, maxX: 184, maxY: 192 }, starts: [[28.5, 164.5], [163.5, 35.5]] },
  { map: "Frostline LE", bounds: { minX: 8, minY: 12, maxX: 168, maxY: 188 }, starts: [[26.5, 161.5], [149.5, 38.5]] },
] as const;

/** The API's binning (services/mapIntelZones.js cellOf), for the cell a world point lands in. */
function apiCell(bounds: (typeof MAPS)[number]["bounds"], grid: number, x: number, y: number) {
  return {
    x: Math.min(grid - 1, Math.floor(((x - bounds.minX) / (bounds.maxX - bounds.minX)) * grid)),
    y: Math.min(grid - 1, Math.floor(((y - bounds.minY) / (bounds.maxY - bounds.minY)) * grid)),
  };
}

describe("Map Intel stage alignment per map", () => {
  it.each(MAPS.map((fixture) => [fixture.map, fixture] as const))("%s: heat, layout and replayer share one mapping", (_name, { bounds, starts }) => {
    const width = 480;
    const height = width / stageAspect(bounds);
    const proj = worldProjection(bounds, width, height, 0);
    // A stage of the bounds' aspect has no letterbox, like the replayer canvas.
    expect(proj.ox).toBeCloseTo(0, 6);
    expect(proj.oy).toBeCloseTo(0, 6);
    expect(worldToStage(bounds, width, height, bounds.minX, bounds.maxY)).toEqual({ left: 0, top: 0 });
    const corner = worldToStage(bounds, width, height, bounds.maxX, bounds.minY);
    expect(corner.left).toBeCloseTo(width, 6);
    expect(corner.top).toBeCloseTo(height, 6);
    for (const [x, y] of starts) {
      const point = worldToStage(bounds, width, height, x, y);
      expect(point.left).toBeCloseTo(projectX(bounds, proj, x), 6);
      expect(point.top).toBeCloseTo(projectY(bounds, proj, y), 6);
      // The heat cell the API bins a start location into is drawn around it.
      const rect = cellRect(apiCell(bounds, MAP_INTEL_GRID, x, y), MAP_INTEL_GRID, width, height);
      expect(point.left).toBeGreaterThanOrEqual(rect.left);
      expect(point.left).toBeLessThan(rect.left + rect.width);
      expect(point.top).toBeGreaterThan(rect.top);
      expect(point.top).toBeLessThanOrEqual(rect.top + rect.height);
    }
  });

  it("row 0 is the bottom edge of the stage", () => {
    expect(cellRect({ x: 0, y: 0 }, 4, 400, 200)).toEqual({ left: 0, top: 150, width: 100, height: 50 });
    expect(cellRect({ x: 3, y: 3 }, 4, 400, 200)).toEqual({ left: 300, top: 0, width: 100, height: 50 });
  });
});

describe("mapIntelPath", () => {
  it("keeps the page filters and sets this map, its editions and the grid", () => {
    const path = mapIntelPath("battle", "Goldenaura", { filterQuery: "?since=2026-01-01&map=old&map_exact_label=old", aliases: ["Goldenaura LE", "Goldenaura"], oppRace: "Z" });
    const [route, query] = path.split("?");
    const params = new URLSearchParams(query);
    expect(route).toBe("/v1/spatial/battle");
    expect(params.get("since")).toBe("2026-01-01");
    expect(params.get("map")).toBe("Goldenaura");
    expect(JSON.parse(params.get("map_exact") ?? "[]")).toEqual(["Goldenaura", "Goldenaura LE"]);
    expect(params.has("map_exact_label")).toBe(false);
    expect(params.get("grid")).toBe(String(MAP_INTEL_GRID));
    expect(params.get("opp_race")).toBe("Z");
  });

  it("asks for one dossier opponent, merged identities when grouped", () => {
    const params = new URLSearchParams(mapIntelPath("opp-proxies", "Alcyone", { opponent: "p 1", mergeLinked: true }).split("?")[1]);
    expect(params.get("opponent")).toBe("p 1");
    expect(params.get("mergeLinked")).toBe("1");
    expect(params.has("map_exact")).toBe(false);
    expect(mapIntelPath("opp-proxies", "Alcyone", { opponent: "p1" })).not.toContain("mergeLinked");
  });
});

describe("Map Intel words", () => {
  it("labels hot zones by base and area", () => {
    expect(zoneLabel({ base: "natural", area: "top left" })).toBe("Natural, top left");
    expect(zoneLabel({ base: "main", area: "bottom right" })).toBe("Main base, bottom right");
    expect(zoneLabel({ base: null, area: "centre" })).toBe("Centre of the map");
    expect(zoneDetail({ share: 0.314, games: 1 })).toBe("31% · seen in 1 game");
  });

  it("says what the sample is made of and why a layer is withheld", () => {
    expect(sampleCaption({ games: 12, scanned: 37, capped: false, maxGames: 300 }, "battle")).toBe("Fights in 12 of 37 analysed games");
    expect(sampleCaption({ games: 4, scanned: 300, capped: true, maxGames: 300 }, "opp-proxies")).toBe("Proxies in 4 of the latest 300 analysed games");
    expect(sampleCaption({ games: 1, scanned: 1, capped: false, maxGames: 300 }, "death-zone")).toBe("Lost fights in 1 of 1 analysed game");
    expect(belowMinimumText({ games: 2, minGames: 3 }, "battle")).toBe("Not enough games to show a pattern yet: fights in 2 games, 3 needed.");
  });

  it("keeps faint cells visible and never exceeds the chosen opacity", () => {
    expect(heatAlpha(0, 1)).toBeCloseTo(0.18, 6);
    expect(heatAlpha(0.25, 1)).toBeCloseTo(0.59, 6);
    expect(heatAlpha(1, 0.6)).toBeCloseTo(0.6, 6);
    expect(heatAlpha(4, 2)).toBe(1);
  });
});
