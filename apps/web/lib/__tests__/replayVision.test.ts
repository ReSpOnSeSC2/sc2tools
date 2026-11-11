import { describe, expect, it } from "vitest";
import { sanitizeMapPlayback, type MapPlayback } from "@/lib/mapReplay";
import {
  buildingFirstSeen, isReplayVision, nextReplayVision, REPLAY_VISIONS, VisionGrid, visionIsObserved, visionLabel, visionViewer,
} from "@/lib/replayVision";

const SIGHT = { unit: 11, worker: 9, hall: 13, building: 10 };

function playback(overrides: Record<string, unknown> = {}): MapPlayback {
  const raw = {
    v: 5, mapName: "Vision Test", gameLength: 600, bounds: { minX: 0, minY: 0, maxX: 200, maxY: 200 },
    spawns: [], battles: [], resources: [], stats: { me: [[0, 0, 12, 12], [600, 0, 12, 12]], opp: [[0, 0, 12, 12], [600, 0, 12, 12]] },
    buildings: [], units: [], ...overrides,
  };
  const value = sanitizeMapPlayback(raw);
  if (!value) throw new Error("fixture rejected");
  return value;
}

describe("vision modes", () => {
  it("cycles both → me → opp → off → both and validates stored values", () => {
    expect(REPLAY_VISIONS).toEqual(["both", "me", "opp", "off"]);
    expect(nextReplayVision("both")).toBe("me");
    expect(nextReplayVision("me")).toBe("opp");
    expect(nextReplayVision("opp")).toBe("off");
    expect(nextReplayVision("off")).toBe("both");
    expect(isReplayVision("opp")).toBe(true);
    expect(isReplayVision("selected")).toBe(false);
    expect(isReplayVision(undefined)).toBe(false);
    expect(visionViewer("me")).toBe("me");
    expect(visionViewer("both")).toBeNull();
    expect(visionViewer("off")).toBeNull();
    expect(visionLabel("opp", "Ada", "Rival")).toBe("Rival");
    expect(visionLabel("off")).toBe("Off");
  });

  it("labels every payload approximate until the engine exports observed vision", () => {
    expect(visionIsObserved({ fidelity: undefined })).toBe(false);
    expect(visionIsObserved({ fidelity: { positions: "engine", paths: "observed", creep: "observed" } })).toBe(false);
    expect(visionIsObserved({ fidelity: { positions: "engine", paths: "observed", creep: "observed", vision: "observed" } as never })).toBe(true);
  });
});

describe("VisionGrid", () => {
  it("reveals cell centres inside a stamped disc and nothing else", () => {
    const grid = new VisionGrid();
    grid.reset({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    grid.stamp(50, 50, 8);
    expect(grid.seen(50, 50)).toBe(true);
    expect(grid.seen(57, 50)).toBe(true);
    expect(grid.seen(50, 42.6)).toBe(true);
    expect(grid.seen(60, 50)).toBe(false);
    expect(grid.seen(56, 56)).toBe(false); // 8.5 away diagonally
    expect(grid.seen(-5, 50)).toBe(false);
    grid.reset({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    expect(grid.seen(50, 50)).toBe(false);
  });

  it("clips discs at the map edge and coarsens absurd bounds instead of allocating them", () => {
    const grid = new VisionGrid();
    grid.reset({ minX: 0, minY: 0, maxX: 40, maxY: 40 });
    grid.stamp(1, 1, 5);
    expect(grid.seen(0.5, 0.5)).toBe(true);
    expect(grid.seen(39, 39)).toBe(false);
    grid.reset({ minX: 0, minY: 0, maxX: 1e6, maxY: 1e6 });
    grid.stamp(5e5, 5e5, 3000);
    expect(grid.seen(5e5, 5e5)).toBe(true);
    expect(grid.seen(1e5, 1e5)).toBe(false);
  });
});

describe("buildingFirstSeen", () => {
  it("times the first sighting of each enemy structure from held friendly tracks", () => {
    const p = playback({
      buildings: [
        { owner: "me", name: "Nexus", t: 0, x: 20, y: 20, moves: [], died: null },
        { owner: "opp", name: "Barracks", t: 30, x: 100, y: 100, moves: [], died: null },
        { owner: "opp", name: "Factory", t: 50, x: 180, y: 180, moves: [], died: null },
        // Placed while the scout already stands next to it: seen on placement.
        { owner: "opp", name: "SupplyDepot", t: 70, x: 104, y: 100, moves: [], died: null },
        { owner: "opp", name: "Bunker", t: 0, x: 25, y: 20, moves: [], died: null },
      ],
      units: [
        { owner: "me", name: "Probe", born: 10, died: null, wp: [10, 20, 20, 60, 60, 100, 65, 100, 100, 200, 100, 100] },
      ],
    });
    const seen = buildingFirstSeen(p, "me", SIGHT);
    expect(seen[0]).toBe(0); // own structure
    expect(seen[1]).toBe(65); // the Probe arrives at 65 s
    expect(seen[2]).toBe(Infinity); // never scouted
    expect(seen[3]).toBe(70); // placed under the held scout
    expect(seen[4]).toBe(0); // inside the Nexus's sight from the start
    // Cached per payload and side.
    expect(buildingFirstSeen(p, "me", SIGHT)).toBe(seen);
    expect(buildingFirstSeen(p, "opp", SIGHT)[1]).toBe(0);
  });

  it("ignores sightings after a structure died and scouts that died first", () => {
    const p = playback({
      buildings: [{ owner: "opp", name: "Pylon", t: 0, x: 100, y: 100, moves: [], died: 40 }],
      units: [
        { owner: "me", name: "Zergling", born: 0, died: 30, wp: [0, 10, 10, 35, 100, 100] },
        { owner: "me", name: "Zergling", born: 0, died: null, wp: [0, 10, 10, 45, 100, 100] },
      ],
    });
    expect(buildingFirstSeen(p, "me", SIGHT)[0]).toBe(Infinity);
  });
});
