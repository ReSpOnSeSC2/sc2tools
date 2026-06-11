import { describe, expect, it } from "vitest";
import {
  actionsFromSteps,
  adaptBuild,
  referenceBuilds,
} from "../adapt/adapt";
import { resolveProfile } from "../patch/profiles";
import { defaultPolicies } from "../sim/engine";
import { threatCatalog } from "../threats/store";
import {
  CUSTOM_BUILD_PUT_PATH,
  toCustomBuildPayload,
} from "../export/toCustomBuild";
import type { AdaptResult } from "../types";

const profile = resolveProfile("5.0.16");
const eightPool = threatCatalog(null).find((t) => t.id === "z-8pool")!;

function makeResult(): AdaptResult {
  const reference = referenceBuilds().find((b) => b.id === "protoss-standard-expand")!;
  const { actions } = actionsFromSteps(profile, reference.steps);
  return adaptBuild({
    baselineProfileId: "lotv-base",
    profileId: "5.0.16",
    race: "Protoss",
    actions,
    referenceName: reference.name,
    referenceId: reference.id,
    threats: [{ threat: eightPool, probability: 0.8 }],
    policies: defaultPolicies(),
    safety: { hasWall: true, allowWorkerPull: true },
    horizonSec: 480,
  });
}

// Mirror of the constraints in apps/api/src/validation/customBuild.js.
const SLUG_PATTERN = /^[a-zA-Z0-9._-]+$/;

describe("export to custom builds", () => {
  const result = makeResult();
  const payload = toCustomBuildPayload(result, {
    name: "1-Gate Expand (5.0.16)",
    vsRace: "Zerg",
    description: "Adapted from the 12-worker standard",
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
    const gateways = payload.signature.filter((s) => s.unit === "gateway");
    expect(gateways).toHaveLength(1);
    expect(gateways[0].count).toBeGreaterThanOrEqual(2);
  });

  it("notes carry the build order, timing shifts, and safety report", () => {
    expect(payload.notes).toContain("Build order:");
    expect(payload.notes).toContain("Timing shifts vs lotv-base:");
    expect(payload.notes).toContain("Safety report:");
    expect(payload.notes).toContain("8-pool");
    expect(payload.notes).toContain('Adapted from "Standard Expand (1 Gate)"');
    expect(payload.notes!.length).toBeLessThanOrEqual(8000);
  });

  it("builds the PUT path with the encoded slug", () => {
    expect(CUSTOM_BUILD_PUT_PATH(payload.slug)).toBe(
      `/v1/custom-builds/${payload.slug}`,
    );
    expect(CUSTOM_BUILD_PUT_PATH("a b")).toBe("/v1/custom-builds/a%20b");
  });
});
