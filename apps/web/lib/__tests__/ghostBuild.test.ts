import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GHOST_BUILD_PARAM,
  GHOST_BUILD_CONFIG_VERSION,
  GHOST_BUILD_LIBRARY_STORAGE_KEY,
  GHOST_BUILD_STORAGE_KEY,
  GHOST_BUILD_VERSION,
  GHOST_MATCHUPS,
  MAX_GHOST_STEPS,
  appendGhostToUrl,
  armGhostTargetForMatchup,
  armGhostTarget,
  assignGhostTarget,
  assignSavedGhostBuild,
  clearGhostTarget,
  decodeGhostTarget,
  decodeGhostBuildConfig,
  disarmGhostTarget,
  emptyGhostBuildConfig,
  encodeGhostBuildConfig,
  encodeGhostTarget,
  fromBuildLog,
  fromOptimizerResult,
  ghostMatchupKey,
  migrateLegacyGhostTarget,
  migrateLegacyGhostTargetInStorage,
  normalizeConcreteGhostRace,
  normalizeGhostBuildConfig,
  normalizeGhostName,
  normalizeGhostTarget,
  readArmedGhostConfig,
  readArmedGhostTarget,
  readGhostBuildParamFromHash,
  readSavedGhostBuilds,
  removeSavedGhostBuild,
  saveGhostBuild,
  selectGhostTarget,
  writeArmedGhostConfig,
  type GhostBuildConfig,
  type SavedGhostBuild,
  type GhostTarget,
} from "@/lib/ghostBuild";
import type { BuildOrderStep } from "@/lib/optimizer/types";

/** Craft a raw base64url ?ghost= value from an arbitrary object —
 * bypasses encodeGhostTarget's own normalization so tests can feed
 * genuinely hostile payloads through the decode path. */
function rawParam(payload: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodedParam(raw: string): unknown {
  const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = Uint8Array.from(bin, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function makeTarget(overrides: Partial<GhostTarget> = {}): GhostTarget {
  return {
    v: GHOST_BUILD_VERSION,
    name: "PvZ 2 SG Void Ray",
    steps: [
      { supply: 14, t: 17, name: "Pylon" },
      { supply: 16, t: 40, name: "Gateway" },
      { supply: 20, t: 95, name: "Stargate" },
    ],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("encode/decode round-trip", () => {
  it("round-trips a fully-populated target", () => {
    const target = makeTarget();
    const encoded = encodeGhostTarget(target);
    expect(encoded).toBeTruthy();
    expect(decodeGhostTarget(encoded)).toEqual(target);
  });

  it("produces URL-safe output (base64url alphabet only)", () => {
    const encoded = encodeGhostTarget(makeTarget());
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("round-trips unicode build names (UTF-8, not just Latin-1)", () => {
    const target = makeTarget({ name: "проксі 4-gate — 파일런 rush" });
    const decoded = decodeGhostTarget(encodeGhostTarget(target));
    expect(decoded?.name).toBe("проксі 4-gate — 파일런 rush");
  });

  it("sorts steps chronologically on decode", () => {
    const encoded = rawParam({
      v: 1,
      name: "Out of order",
      steps: [
        { supply: null, t: 90, name: "Stargate" },
        { supply: null, t: 17, name: "Pylon" },
      ],
    });
    const decoded = decodeGhostTarget(encoded);
    expect(decoded?.steps.map((s) => s.t)).toEqual([17, 90]);
  });

  it("rounds fractional times and floors/clamps supply", () => {
    const encoded = rawParam({
      v: 1,
      name: "Fractional",
      steps: [{ supply: 250.7, t: 17.4, name: "Pylon" }],
    });
    const decoded = decodeGhostTarget(encoded);
    expect(decoded?.steps[0]).toEqual({ supply: 200, t: 17, name: "Pylon" });
  });
});

describe("exact matchup model", () => {
  it("exposes all nine matchups in stable streamer-race groups", () => {
    expect(GHOST_MATCHUPS).toEqual([
      "PvP", "PvT", "PvZ",
      "TvP", "TvT", "TvZ",
      "ZvP", "ZvT", "ZvZ",
    ]);
  });

  it.each([
    ["P", "P"],
    ["p", "P"],
    ["Protoss", "P"],
    ["T", "T"],
    ["terran", "T"],
    ["Zerg", "Z"],
  ] as const)("normalizes concrete race %s", (raw, expected) => {
    expect(normalizeConcreteGhostRace(raw)).toBe(expected);
  });

  it.each([null, undefined, "", "Random", "R", "unknown", "?", "potato"])(
    "never coerces non-concrete race %s",
    (raw) => {
      expect(normalizeConcreteGhostRace(raw)).toBeNull();
    },
  );

  it("forms keys only when both races are concrete", () => {
    expect(ghostMatchupKey("Protoss", "Terran")).toBe("PvT");
    expect(ghostMatchupKey("z", "P")).toBe("ZvP");
    expect(ghostMatchupKey("Random", "Terran")).toBeNull();
    expect(ghostMatchupKey("Protoss", "Random")).toBeNull();
    expect(ghostMatchupKey("Protoss", "unknown")).toBeNull();
  });

  it("assigns, selects and clears one exact slot without mutating the input", () => {
    const empty = emptyGhostBuildConfig();
    const pvt = makeTarget({ name: "PvT Blink" });
    const next = assignGhostTarget(empty, "PvT", pvt);
    expect(empty.slots).toEqual({});
    expect(selectGhostTarget(next, "Protoss", "Terran")).toEqual(pvt);
    expect(selectGhostTarget(next, "Protoss", "Zerg")).toBeNull();
    expect(selectGhostTarget(next, "Random", "Terran")).toBeNull();
    expect(selectGhostTarget(next, "Protoss", "Random")).toBeNull();

    const cleared = clearGhostTarget(next, "PvT");
    expect(cleared.slots).toEqual({});
    expect(next.slots.PvT).toEqual(pvt);
  });

  it("assigns a saved build to the requested slot, not its source slot", () => {
    const target = makeTarget({ name: "Flexible timing" });
    const saved: SavedGhostBuild = {
      id: "PvP:abc",
      matchup: "PvP",
      target,
      savedAt: "2026-07-12T12:00:00.000Z",
    };
    const config = assignSavedGhostBuild(
      emptyGhostBuildConfig(),
      "PvT",
      saved,
    );
    expect(config.slots.PvT).toEqual(target);
    expect(config.slots.PvP).toBeUndefined();
  });

  it("requires valid public config keys and nested targets", () => {
    expect(normalizeGhostBuildConfig({
      v: GHOST_BUILD_CONFIG_VERSION,
      slots: { PvT: makeTarget() },
    })).not.toBeNull();
    expect(normalizeGhostBuildConfig({
      v: GHOST_BUILD_CONFIG_VERSION,
      slots: { PvR: makeTarget() },
    })).toBeNull();
    expect(normalizeGhostBuildConfig({
      v: GHOST_BUILD_CONFIG_VERSION,
      slots: { PvT: { ...makeTarget(), v: 99 } },
    })).toBeNull();
  });
});

describe("compact v2 config codec", () => {
  function allMatchupsConfig(): GhostBuildConfig {
    let config = emptyGhostBuildConfig();
    for (const [index, matchup] of GHOST_MATCHUPS.entries()) {
      config = assignGhostTarget(
        config,
        matchup,
        makeTarget({ name: `${matchup} plan ${index + 1}` }),
      );
    }
    return config;
  }

  it("round-trips all nine exact slots in one URL payload", () => {
    const config = allMatchupsConfig();
    const encoded = encodeGhostBuildConfig(config);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeGhostBuildConfig(encoded)).toEqual(config);
  });

  it("uses compact wire keys and tuples instead of expanded target JSON", () => {
    const config = assignGhostTarget(
      emptyGhostBuildConfig(),
      "PvT",
      makeTarget({ name: "Blink" }),
    );
    const parsed = decodedParam(encodeGhostBuildConfig(config)!) as {
      v: number;
      b: Record<string, unknown>;
    };
    expect(Object.keys(parsed)).toEqual(["v", "b"]);
    expect(parsed.v).toBe(2);
    expect(parsed.b.PvT).toEqual([
      "Blink",
      [
        [14, 17, "Pylon"],
        [16, 40, "Gateway"],
        [20, 95, "Stargate"],
      ],
    ]);
    expect(JSON.stringify(parsed)).not.toContain('"steps"');
    expect(JSON.stringify(parsed)).not.toContain('"supply"');
  });

  it("does not encode or append an empty config", () => {
    const empty = emptyGhostBuildConfig();
    expect(encodeGhostBuildConfig(empty)).toBeNull();
    const url = "https://x.test/overlay/t/widget/ghost-build";
    expect(appendGhostToUrl(url, empty)).toBe(url);
  });

  it("appends and decodes a v2 config in a client-only fragment", () => {
    const config = assignGhostTarget(
      emptyGhostBuildConfig(),
      "TvZ",
      makeTarget({ name: "2-1-1" }),
    );
    const url = appendGhostToUrl(
      "https://x.test/overlay/t/widget/ghost-build?theme=abc",
      config,
    );
    expect(url).toMatch(/^https:\/\/x\.test\/overlay\/t\/widget\/ghost-build\?theme=abc#ghost=/);
    expect(url.slice(0, url.indexOf("#"))).not.toContain("ghost=");
    const encoded = readGhostBuildParamFromHash(url.slice(url.indexOf("#")));
    expect(decodeGhostBuildConfig(encoded)).toEqual(config);
  });

  it("strict-validates one v2 ghost field from a fragment", () => {
    const config = assignGhostTarget(
      emptyGhostBuildConfig(),
      "ZvP",
      makeTarget({ name: "Ling pressure" }),
    );
    const encoded = encodeGhostBuildConfig(config)!;

    expect(readGhostBuildParamFromHash(`#ghost=${encoded}`)).toBe(encoded);
    expect(readGhostBuildParamFromHash(`#panel=coach&ghost=${encoded}`)).toBe(encoded);
    expect(readGhostBuildParamFromHash(`#?ghost=${encoded}`)).toBe(encoded);
    expect(readGhostBuildParamFromHash(`#ghost=${encoded}&ghost=${encoded}`)).toBeNull();
    expect(readGhostBuildParamFromHash("#ghost=not-valid")).toBeNull();
    expect(readGhostBuildParamFromHash(`#ghost=${"A".repeat(65 * 1024)}`)).toBeNull();
    expect(
      readGhostBuildParamFromHash(`#ghost=${encodeGhostTarget(makeTarget())}`),
    ).toBeNull();
  });

  it("rejects malformed, unknown and partially invalid compact payloads", () => {
    const validTarget = ["Blink", [[14, 17, "Pylon"]]];
    const cases = [
      { v: 1, b: { PvT: validTarget } },
      { v: 2, b: {} },
      { v: 2, b: { PvR: validTarget } },
      { v: 2, b: { PvT: validTarget }, extra: true },
      { v: 2, b: { PvT: ["Blink", []] } },
      { v: 2, b: { PvT: ["Blink", [[14, "17", "Pylon"]]] } },
      { v: 2, b: { PvT: ["Blink", [[14, 17]]] } },
      { v: 2, b: { PvT: "not-a-target" } },
    ];
    for (const value of cases) {
      expect(decodeGhostBuildConfig(rawParam(value))).toBeNull();
    }
    expect(decodeGhostBuildConfig("A".repeat(64 * 1024 + 1))).toBeNull();
  });

  it("keeps legacy v1 decode separate and requires explicit migration", () => {
    const target = makeTarget({ name: "Old one-build URL" });
    const legacy = encodeGhostTarget(target)!;
    expect(decodeGhostTarget(legacy)).toEqual(target);
    expect(decodeGhostBuildConfig(legacy)).toBeNull();

    const migrated = migrateLegacyGhostTarget(target, "ZvT");
    expect(migrated.slots.ZvT).toEqual(target);
    expect(Object.keys(migrated.slots)).toEqual(["ZvT"]);
  });
});

describe("hostile decode inputs", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["junk base64", "%%%not-base64%%%"],
    ["non-base64url characters", "abc+/=="],
    ["valid b64 of non-JSON", btoa("hello world").replace(/=+$/, "")],
  ] as const)("returns null for %s", (_label, raw) => {
    expect(decodeGhostTarget(raw as string | null | undefined)).toBeNull();
  });

  it("rejects the wrong version", () => {
    expect(decodeGhostTarget(rawParam({ ...makeTarget(), v: 2 }))).toBeNull();
    expect(decodeGhostTarget(rawParam({ ...makeTarget(), v: "1" }))).toBeNull();
  });

  it("rejects a missing/empty/oversized step list", () => {
    expect(decodeGhostTarget(rawParam({ v: 1, name: "x" }))).toBeNull();
    expect(
      decodeGhostTarget(rawParam({ v: 1, name: "x", steps: [] })),
    ).toBeNull();
    const tooMany = Array.from({ length: MAX_GHOST_STEPS + 1 }, (_, i) => ({
      supply: null,
      t: i,
      name: "Pylon",
    }));
    expect(
      decodeGhostTarget(rawParam({ v: 1, name: "x", steps: tooMany })),
    ).toBeNull();
  });

  it("rejects oversized encoded payloads outright", () => {
    const huge = "A".repeat(9000);
    expect(decodeGhostTarget(huge)).toBeNull();
  });

  it("rejects any invalid step rather than silently dropping it", () => {
    const cases: unknown[][] = [
      [{ supply: null, t: NaN, name: "Pylon" }],
      [{ supply: null, t: -5, name: "Pylon" }],
      [{ supply: null, t: 999999999, name: "Pylon" }],
      [{ supply: null, t: "17", name: "Pylon" }],
      [{ supply: "14", t: 17, name: "Pylon" }],
      [{ supply: null, t: 17, name: "" }],
      [{ supply: null, t: 17, name: 42 }],
      ["not-an-object"],
      [null],
    ];
    for (const steps of cases) {
      expect(
        decodeGhostTarget(rawParam({ v: 1, name: "x", steps })),
      ).toBeNull();
    }
  });

  it("rejects non-object payloads and arrays", () => {
    expect(decodeGhostTarget(rawParam([1, 2, 3]))).toBeNull();
    expect(decodeGhostTarget(rawParam("string"))).toBeNull();
    expect(decodeGhostTarget(rawParam(17))).toBeNull();
  });

  it("strips control characters from names and caps their length", () => {
    const decoded = decodeGhostTarget(
      rawParam({
        v: 1,
        name: "Sneaky\0 build​" + "x".repeat(200),
        steps: [{ supply: null, t: 17, name: "Pylon" }],
      }),
    );
    expect(decoded).not.toBeNull();
    expect(decoded!.name.length).toBeLessThanOrEqual(80);
    expect(decoded!.name.startsWith("Sneaky build")).toBe(true);
    expect(decoded!.steps[0].name).toBe("Pylon");
  });

  it("rejects a name that is empty after sanitization", () => {
    expect(
      decodeGhostTarget(
        rawParam({ v: 1, name: "\0​  ", steps: [{ t: 1, name: "P" }] }),
      ),
    ).toBeNull();
  });

  it("normalizeGhostTarget rejects garbage shapes directly", () => {
    expect(normalizeGhostTarget(null)).toBeNull();
    expect(normalizeGhostTarget([])).toBeNull();
    expect(normalizeGhostTarget("x")).toBeNull();
    expect(normalizeGhostTarget({ v: 1, name: "x", steps: "nope" })).toBeNull();
  });
});

describe("fromOptimizerResult", () => {
  const step = (
    name: string,
    startSec: number,
    kind: BuildOrderStep["kind"] = "build",
    supply = 14,
  ): BuildOrderStep => ({ supply, name, kind, startSec, doneSec: startSec + 10 });

  it("keeps timed build/train/research steps and maps fields", () => {
    const target = fromOptimizerResult({
      referenceName: "2 SG Void Ray",
      profileId: "lotv-5016",
      sim: {
        steps: [
          step("Pylon", 17.4, "build", 14),
          step("Adept", 95, "train", 21),
          step("WarpGateResearch", 130, "research", 23),
        ],
      },
    });
    expect(target).not.toBeNull();
    expect(target!.name).toBe("2 SG Void Ray (lotv-5016)");
    expect(target!.steps).toEqual([
      { supply: 14, t: 17, name: "Pylon" },
      { supply: 21, t: 95, name: "Adept" },
      { supply: 23, t: 130, name: "WarpGateResearch" },
    ]);
  });

  it("drops workers, chrono, and warpgate transforms", () => {
    const target = fromOptimizerResult({
      referenceName: "Macro opener",
      profileId: "lotv-base",
      sim: {
        steps: [
          step("Probe", 12, "train"),
          step("SCV", 12, "train"),
          step("Drone", 12, "train"),
          step("Nexus", 60, "chrono"),
          step("WarpGate", 200, "transform-warpgate"),
          step("Pylon", 17, "build"),
        ],
      },
    });
    expect(target!.steps).toEqual([{ supply: 14, t: 17, name: "Pylon" }]);
  });

  it("caps at MAX_GHOST_STEPS", () => {
    const target = fromOptimizerResult({
      referenceName: "Long",
      profileId: "p",
      sim: {
        steps: Array.from({ length: 300 }, (_, i) => step("Zealot", i + 1, "train")),
      },
    });
    expect(target!.steps).toHaveLength(MAX_GHOST_STEPS);
  });

  it("returns null when nothing armable remains", () => {
    const target = fromOptimizerResult({
      referenceName: "Workers only",
      profileId: "p",
      sim: { steps: [step("Probe", 12, "train")] },
    });
    expect(target).toBeNull();
  });
});

describe("fromBuildLog", () => {
  it("parses [m:ss] Name lines into timed steps (no supply)", () => {
    const target = fromBuildLog("Roach opener", [
      "[0:17] Overlord",
      "[1:05] SpawningPool",
      "[2:41] RoachWarren",
    ]);
    expect(target).not.toBeNull();
    expect(target!.steps).toEqual([
      { supply: null, t: 17, name: "Overlord" },
      { supply: null, t: 65, name: "SpawningPool" },
      { supply: null, t: 161, name: "RoachWarren" },
    ]);
  });

  it("skips garbage lines and worker entries", () => {
    const target = fromBuildLog("Messy log", [
      "not a log line",
      "[xx:yy] Broken",
      "[0:12] Drone",
      "[0:20] Probe",
      "[0:25] SCV",
      "[1:00] Gateway",
    ]);
    expect(target!.steps).toEqual([{ supply: null, t: 60, name: "Gateway" }]);
  });

  it("returns null when no timed steps survive", () => {
    expect(fromBuildLog("Empty", [])).toBeNull();
    expect(fromBuildLog("Workers", ["[0:12] Drone"])).toBeNull();
    expect(fromBuildLog("Garbage", ["hello", "world"])).toBeNull();
  });

  it("caps at MAX_GHOST_STEPS", () => {
    const lines = Array.from(
      { length: 200 },
      (_, i) => `[${Math.floor(i / 60)}:${String(i % 60).padStart(2, "0")}] Zergling`,
    );
    const target = fromBuildLog("Ling flood", lines);
    expect(target!.steps).toHaveLength(MAX_GHOST_STEPS);
  });
});

describe("appendGhostToUrl", () => {
  it("appends ?ghost= to a bare URL and &ghost= after existing params", () => {
    const target = makeTarget();
    const bare = appendGhostToUrl("https://x.test/overlay/t/widget/ghost-build", target);
    expect(bare).toContain(`?${GHOST_BUILD_PARAM}=`);
    const chained = appendGhostToUrl(
      "https://x.test/overlay/t/widget/ghost-build?theme=abc",
      target,
    );
    expect(chained).toContain(`&${GHOST_BUILD_PARAM}=`);
    // The appended value must itself decode.
    const value = chained.split(`${GHOST_BUILD_PARAM}=`)[1];
    expect(decodeGhostTarget(value)).toEqual(target);
  });

  it("leaves the URL untouched for null/invalid targets", () => {
    const url = "https://x.test/overlay/t/widget/ghost-build";
    expect(appendGhostToUrl(url, null)).toBe(url);
    const invalid = { v: 1, name: "", steps: [] } as unknown as GhostTarget;
    expect(appendGhostToUrl(url, invalid)).toBe(url);
  });
});

describe("v2 exact-matchup storage and saved-build library", () => {
  it("writes and reads a v2 config while legacy reads stay unambiguous", () => {
    const config = assignGhostTarget(
      emptyGhostBuildConfig(),
      "PvZ",
      makeTarget({ name: "PvZ Stargate" }),
    );
    expect(writeArmedGhostConfig(config)).toBe(true);
    expect(readArmedGhostConfig()).toEqual(config);
    // A caller without both races must not receive an arbitrary v2 target.
    expect(readArmedGhostTarget()).toBeNull();
  });

  it("removes storage when the final config is empty", () => {
    const config = assignGhostTarget(
      emptyGhostBuildConfig(),
      "PvZ",
      makeTarget(),
    );
    expect(writeArmedGhostConfig(config)).toBe(true);
    expect(window.localStorage.getItem(GHOST_BUILD_STORAGE_KEY)).toBeTruthy();
    expect(writeArmedGhostConfig(clearGhostTarget(config, "PvZ"))).toBe(true);
    expect(window.localStorage.getItem(GHOST_BUILD_STORAGE_KEY)).toBeNull();
  });

  it("saves prior targets with a required exact matchup and de-dupes copies", () => {
    const target = makeTarget({ name: "PvT Blink" });
    const first = saveGhostBuild("PvT", target);
    const second = saveGhostBuild("PvT", target);
    expect(first).not.toBeNull();
    expect(second?.id).toBe(first?.id);
    expect(readSavedGhostBuilds()).toHaveLength(1);
    expect(readSavedGhostBuilds()[0]).toMatchObject({
      id: first!.id,
      matchup: "PvT",
      target,
    });
    expect(window.localStorage.getItem(GHOST_BUILD_LIBRARY_STORAGE_KEY)).toBeTruthy();
  });

  it("keeps identical target timings separate when their source matchups differ", () => {
    const target = makeTarget({ name: "Safe macro" });
    const pvt = saveGhostBuild("PvT", target)!;
    const pvz = saveGhostBuild("PvZ", target)!;
    expect(pvt.id).not.toBe(pvz.id);
    expect(readSavedGhostBuilds().map((build) => build.matchup).sort()).toEqual([
      "PvT",
      "PvZ",
    ]);
  });

  it("removes saved builds and rejects a tampered library", () => {
    const saved = saveGhostBuild("TvP", makeTarget({ name: "TvP timing" }))!;
    expect(removeSavedGhostBuild(saved.id)).toBe(true);
    expect(removeSavedGhostBuild(saved.id)).toBe(false);
    expect(readSavedGhostBuilds()).toEqual([]);

    window.localStorage.setItem(
      GHOST_BUILD_LIBRARY_STORAGE_KEY,
      JSON.stringify([{
        id: "bad",
        matchup: "TvR",
        target: makeTarget(),
        savedAt: "2026-07-12T12:00:00.000Z",
      }]),
    );
    expect(readSavedGhostBuilds()).toEqual([]);
  });

  it("arm-from-game saves and assigns only that game's exact matchup", () => {
    const pvt = makeTarget({ name: "PvT Blink" });
    expect(armGhostTargetForMatchup("Protoss", "Terran", pvt)).toBe(true);
    expect(readArmedGhostConfig()?.slots.PvT).toEqual(pvt);
    expect(readArmedGhostConfig()?.slots.PvZ).toBeUndefined();
    expect(readSavedGhostBuilds()).toHaveLength(1);
    expect(readSavedGhostBuilds()[0].matchup).toBe("PvT");

    const pvz = makeTarget({ name: "PvZ Stargate" });
    expect(armGhostTargetForMatchup("P", "Z", pvz)).toBe(true);
    expect(readArmedGhostConfig()?.slots.PvT).toEqual(pvt);
    expect(readArmedGhostConfig()?.slots.PvZ).toEqual(pvz);
    expect(readSavedGhostBuilds()).toHaveLength(2);
  });

  it.each([
    ["Random", "Terran"],
    ["Protoss", "Random"],
    ["?", "Zerg"],
    ["Terran", "unknown"],
  ])("never arms a non-concrete matchup %s vs %s", (mine, theirs) => {
    expect(armGhostTargetForMatchup(mine, theirs, makeTarget())).toBe(false);
    expect(readArmedGhostConfig()).toBeNull();
    expect(readSavedGhostBuilds()).toEqual([]);
  });

  it("treats corrupted v2 config storage as unarmed", () => {
    window.localStorage.setItem(GHOST_BUILD_STORAGE_KEY, "tampered!!!");
    expect(readArmedGhostConfig()).toBeNull();
  });
});

describe("legacy v1 arm / disarm localStorage mirror", () => {
  it("arms, reads back, and disarms", () => {
    const target = makeTarget();
    expect(armGhostTarget(target)).toBe(true);
    expect(readArmedGhostTarget()).toEqual(target);
    disarmGhostTarget();
    expect(readArmedGhostTarget()).toBeNull();
  });

  it("stores the ENCODED form so reads run hostile-input validation", () => {
    armGhostTarget(makeTarget());
    const stored = window.localStorage.getItem(GHOST_BUILD_STORAGE_KEY);
    expect(stored).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("migrates a legacy build only after an exact matchup is chosen", () => {
    const target = makeTarget({ name: "Old ladder build" });
    expect(armGhostTarget(target)).toBe(true);

    expect(migrateLegacyGhostTargetInStorage(target, "TvZ")).toBe(true);
    expect(readArmedGhostTarget()).toBeNull();
    expect(readArmedGhostConfig()?.slots).toEqual({ TvZ: target });
    expect(readSavedGhostBuilds()).toHaveLength(1);
    expect(readSavedGhostBuilds()[0]).toMatchObject({
      matchup: "TvZ",
      target,
    });
  });

  it("keeps the legacy build untouched when the library write fails", () => {
    const target = makeTarget({ name: "Do not lose me" });
    expect(armGhostTarget(target)).toBe(true);
    const legacyValue = window.localStorage.getItem(GHOST_BUILD_STORAGE_KEY);
    const originalSetItem = Storage.prototype.setItem;
    let rejectedLibraryWrite = false;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (
        key === GHOST_BUILD_LIBRARY_STORAGE_KEY
        && !rejectedLibraryWrite
      ) {
        rejectedLibraryWrite = true;
        throw new DOMException("Storage full", "QuotaExceededError");
      }
      return originalSetItem.call(this, key, value);
    });

    expect(migrateLegacyGhostTargetInStorage(target, "PvP")).toBe(false);
    expect(window.localStorage.getItem(GHOST_BUILD_STORAGE_KEY)).toBe(legacyValue);
    expect(readArmedGhostTarget()).toEqual(target);
    expect(readArmedGhostConfig()).toBeNull();
    expect(readSavedGhostBuilds()).toEqual([]);
  });

  it("returns null for tampered storage instead of crashing", () => {
    window.localStorage.setItem(GHOST_BUILD_STORAGE_KEY, "tampered!!!");
    expect(readArmedGhostTarget()).toBeNull();
    window.localStorage.setItem(
      GHOST_BUILD_STORAGE_KEY,
      rawParam({ v: 99, name: "evil", steps: [] }),
    );
    expect(readArmedGhostTarget()).toBeNull();
  });

  it("refuses to arm an invalid target", () => {
    const invalid = { v: 1, name: "x", steps: [] } as unknown as GhostTarget;
    expect(armGhostTarget(invalid)).toBe(false);
    expect(readArmedGhostTarget()).toBeNull();
  });
});

describe("normalizeGhostName", () => {
  it("lowercases and strips punctuation/whitespace", () => {
    expect(normalizeGhostName("Spawning Pool")).toBe("spawningpool");
    expect(normalizeGhostName("spawning_pool")).toBe("spawningpool");
    expect(normalizeGhostName("SpawningPool")).toBe("spawningpool");
  });
});
