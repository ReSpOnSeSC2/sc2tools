import { describe, expect, it } from "vitest";
import { defaultPolicies } from "../sim/engine";
import { evaluateCandidate } from "../search/optimize";
import { resolveProfile } from "../patch/profiles";
import { threatCatalog } from "../threats/store";
import {
  CUSTOM_BUILD_PUT_PATH,
  toCustomBuildPayload,
} from "../export/toCustomBuild";
import type { BuildAction, OptimizeRequest, OptimizeResult } from "../types";

const profile = resolveProfile("5.0.16");
const eightPool = threatCatalog(null).find((t) => t.id === "z-8pool")!;

function makeResult(): OptimizeResult {
  const actions: BuildAction[] = [
    { kind: "build", name: "Pylon" },
    { kind: "build", name: "Gateway" },
    { kind: "build", name: "Forge" },
    { kind: "train", name: "Zealot" },
    { kind: "build", name: "PhotonCannon" },
    { kind: "build", name: "Nexus" },
  ];
  const request: OptimizeRequest = {
    profileId: "5.0.16",
    race: "Protoss",
    vsRace: "Zerg",
    objective: { id: "earliest-safe-expansion", atSec: 360 },
    threats: [{ threat: eightPool, probability: 0.8 }],
    policies: defaultPolicies(),
    safety: { hasWall: true, allowWorkerPull: true },
    seed: 7,
    budget: { maxGenerations: 1, maxMillis: 1000 },
    horizonSec: 360,
  };
  const candidate = evaluateCandidate(actions, profile, request);
  return {
    actions,
    sim: candidate.sim,
    safety: candidate.safety,
    score: candidate.score,
    generations: 1,
    evaluations: 1,
    seed: 7,
    objective: request.objective,
    profileId: "5.0.16",
  };
}

// Mirror of the constraints in apps/api/src/validation/customBuild.js.
const SLUG_PATTERN = /^[a-zA-Z0-9._-]+$/;

describe("export to custom builds", () => {
  const result = makeResult();
  const payload = toCustomBuildPayload(result, {
    name: "PvZ safe expand vs 8-pool",
    vsRace: "Zerg",
    description: "Optimizer output",
  });

  it("produces an API-valid slug, name, and races", () => {
    expect(payload.slug).toMatch(SLUG_PATTERN);
    expect(payload.slug.length).toBeLessThanOrEqual(80);
    expect(payload.name.length).toBeLessThanOrEqual(120);
    expect(payload.race).toBe("Protoss");
    expect(payload.vsRace).toBe("Zerg");
    expect(payload.perspective).toBe("you");
    expect(payload.isPublic).toBe(false);
  });

  it("produces a schema-valid signature (counts, times, limits)", () => {
    expect(payload.signature.length).toBeGreaterThan(0);
    expect(payload.signature.length).toBeLessThanOrEqual(200);
    for (const item of payload.signature) {
      expect(item.unit.length).toBeLessThanOrEqual(80);
      expect(Number.isInteger(item.count)).toBe(true);
      expect(item.count).toBeGreaterThanOrEqual(1);
      expect(item.count).toBeLessThanOrEqual(200);
      expect(Number.isInteger(item.beforeSec)).toBe(true);
      expect(item.beforeSec).toBeGreaterThanOrEqual(0);
    }
  });

  it("excludes workers and merges repeat units with earliest time", () => {
    const units = payload.signature.map((s) => s.unit);
    expect(units).not.toContain("probe");
    // pylon appears multiple times in the sim (auto-supply) but the
    // signature compresses to one entry with a count
    const pylons = payload.signature.filter((s) => s.unit === "pylon");
    expect(pylons).toHaveLength(1);
    expect(pylons[0].count).toBeGreaterThanOrEqual(1);
  });

  it("notes carry the build order, safety report, and provenance", () => {
    expect(payload.notes).toContain("Build order:");
    expect(payload.notes).toContain("Safety report:");
    expect(payload.notes).toContain("8-pool");
    expect(payload.notes).toContain("Patch profile: 5.0.16");
    expect(payload.notes!.length).toBeLessThanOrEqual(8000);
  });

  it("builds the PUT path with the encoded slug", () => {
    expect(CUSTOM_BUILD_PUT_PATH(payload.slug)).toBe(
      `/v1/custom-builds/${payload.slug}`,
    );
    expect(CUSTOM_BUILD_PUT_PATH("a b")).toBe("/v1/custom-builds/a%20b");
  });
});
