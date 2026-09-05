import { describe, expect, it, vi } from "vitest";
import type { PlaybackBuilding, PlaybackUnit } from "../mapReplay";
import { collectCreepSources, creepPatchesAt, drawEstimatedCreep,
  estimatedCreepRadiusAt, ESTIMATED_CREEP_DECAY_SECONDS, type CreepSource } from "../replayCreep";

const building = (name: string, t = 0, died: number | null = null): PlaybackBuilding =>
  ({ owner: "opp", name, t, x: 20, y: 30, died, moves: [] });
const tumor: CreepSource = { owner: "opp", kind: "tumor", x: 30, y: 40, born: 100, died: 150 };

describe("recorded creep source collection", () => {
  it("uses both sides' hatchery morphs and all tumor forms, but never assumes creep from a queen or overlord", () => {
    const buildings = ["Hatchery", "Lair", "Hive", "CreepTumor", "CreepTumorQueen", "CreepTumorBurrowed",
      "Nexus", "CommandCenter", "Queen", "Overlord"].map((name, i) => building(name, i));
    buildings[0].owner = "me";
    const sources = collectCreepSources({ buildings, units: [] });
    expect(sources).toHaveLength(6);
    expect(sources[0].owner).toBe("me");
    expect(sources.map((s) => s.kind)).toEqual(["hall", "hall", "hall", "tumor", "tumor", "tumor"]);
  });

  it("accepts legacy unit tumors without moving creep to spurious later targets or counting duplicate entities", () => {
    const unit: PlaybackUnit = { owner: "opp", name: "CreepTumorBurrowed", born: 100, died: 150,
      wp: [100, 20, 30, 120, 150, 150] };
    const sources = collectCreepSources({ buildings: [building("CreepTumorQueen", 100, 150)], units: [unit] });
    expect(sources).toEqual([{ owner: "opp", kind: "tumor", x: 20, y: 30, born: 100, died: 150 }]);
  });

  it("preserves rebuilds as separate lifetimes and rejects malformed locations", () => {
    const sources = collectCreepSources({ buildings: [building("Hatchery", 0, 50), building("Hatchery", 150),
      { ...building("Hatchery"), x: NaN }], units: [] });
    expect(sources).toHaveLength(2);
    expect(creepPatchesAt(sources, 100)).toEqual([]);
    expect(creepPatchesAt(sources, 180)).toHaveLength(1);
  });
});

describe("estimated creep timeline", () => {
  it("does not reveal future creep and grows a recorded tumor progressively", () => {
    expect(estimatedCreepRadiusAt(tumor, 99)).toBe(0);
    expect(estimatedCreepRadiusAt(tumor, 100)).toBe(0);
    expect(estimatedCreepRadiusAt(tumor, 110)).toBeGreaterThan(0);
    expect(estimatedCreepRadiusAt(tumor, 130)).toBeGreaterThan(estimatedCreepRadiusAt(tumor, 110));
  });

  it("shows starting creep immediately, freezes growth at death, and decays to nothing", () => {
    const hall: CreepSource = { ...tumor, kind: "hall", born: 0, died: 150 };
    expect(estimatedCreepRadiusAt(hall, 0)).toBe(12);
    const killedYoung = { ...tumor, died: 105 };
    expect(estimatedCreepRadiusAt(killedYoung, 110)).toBeLessThan(estimatedCreepRadiusAt(killedYoung, 105));
    expect(estimatedCreepRadiusAt(tumor, 151)).toBeLessThan(estimatedCreepRadiusAt(tumor, 150));
    expect(estimatedCreepRadiusAt(tumor, 150 + ESTIMATED_CREEP_DECAY_SECONDS)).toBe(0);
  });

  it("preserves overlapping surviving sources and is deterministic when seeking backwards", () => {
    const surviving = { ...tumor, x: 31, died: null };
    const sources = [tumor, surviving];
    const before = creepPatchesAt(sources, 140);
    expect(creepPatchesAt(sources, 200)).toHaveLength(1);
    expect(creepPatchesAt(sources, 140)).toEqual(before);
    expect(sources).toEqual([tumor, surviving]);
  });

  it("clips to the projected map and unions overlapping patches instead of accumulating opacity", () => {
    const ctx = Object.fromEntries(["save", "beginPath", "rect", "clip", "moveTo", "lineTo", "closePath", "fill", "restore"]
      .map((key) => [key, vi.fn()])) as unknown as CanvasRenderingContext2D;
    drawEstimatedCreep(ctx, { minX: 0, minY: 0, maxX: 100, maxY: 100 }, { k: 2, ox: 4, oy: 6 },
      [tumor, { ...tumor, x: 31 }], 140);
    expect(ctx.rect).toHaveBeenCalledWith(4, 6, 200, 200);
    expect(ctx.clip).toHaveBeenCalledOnce();
    expect(ctx.fill).toHaveBeenCalledTimes(2);
    expect(ctx.restore).toHaveBeenCalledOnce();
  });
});
