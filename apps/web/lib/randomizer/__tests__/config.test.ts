import { describe, expect, it } from "vitest";
import {
  defaultRandomizerConfig,
  sanitizeRandomizerConfig,
  setBuildWeight,
  toggleBuild,
} from "@/lib/randomizer/config";
import { MATCHUPS, type RandomizerBuild } from "@/lib/randomizer/types";

function build(id: string, weight = 1): RandomizerBuild {
  return { id, name: id, race: "Protoss", source: "catalog", weight };
}

describe("sanitizeRandomizerConfig", () => {
  it("returns the default config from garbage input", () => {
    const cfg = sanitizeRandomizerConfig(null);
    for (const m of MATCHUPS) {
      expect(cfg.matchups[m].enabled).toBe(false);
      expect(cfg.matchups[m].builds).toEqual([]);
    }
  });

  it("drops invalid builds and clamps weights", () => {
    const raw = {
      matchups: {
        PvT: {
          enabled: true,
          useCustomWeights: true,
          builds: [
            { id: "a", name: "Build A", race: "Protoss", weight: 3 },
            { id: "", name: "no-id" },
            { name: "no-id" },
            { id: "b", name: "Build B", race: "Protoss", weight: -2 },
          ],
        },
      },
    };
    const cfg = sanitizeRandomizerConfig(raw);
    const pvt = cfg.matchups.PvT;
    expect(pvt.enabled).toBe(true);
    expect(pvt.builds).toHaveLength(2);
    expect(pvt.builds[0].weight).toBe(3);
    // Bad weights coerce to a sensible default (1).
    expect(pvt.builds[1].weight).toBe(1);
  });
});

describe("toggleBuild", () => {
  const base = defaultRandomizerConfig().matchups.PvP;

  it("adds and removes builds", () => {
    const a = build("a");
    const added = toggleBuild(base, a, true);
    expect(added.builds.map((b) => b.id)).toEqual(["a"]);
    const removed = toggleBuild(added, a, false);
    expect(removed.builds).toEqual([]);
  });

  it("is idempotent on duplicate add", () => {
    const a = build("a");
    const once = toggleBuild(base, a, true);
    const twice = toggleBuild(once, a, true);
    expect(twice.builds).toHaveLength(1);
  });
});

describe("setBuildWeight", () => {
  it("updates the matching id only", () => {
    const cfg = {
      ...defaultRandomizerConfig().matchups.PvP,
      builds: [build("a", 1), build("b", 2)],
    };
    const next = setBuildWeight(cfg, "a", 5);
    expect(next.builds.find((b) => b.id === "a")?.weight).toBe(5);
    expect(next.builds.find((b) => b.id === "b")?.weight).toBe(2);
  });
});
