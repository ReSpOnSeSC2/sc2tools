// @ts-nocheck
"use strict";
/* eslint-disable max-lines-per-function */

const {
  validateCustomBuild,
  SIGNATURE_MAX_ITEMS,
  LEGACY_STEPS_MAX_ITEMS,
} = require("../src/validation/customBuild");
const {
  publicBuildSnapshot,
  publicBuildMongoLeafProjection,
  publicBuildMongoExpression,
} = require("../src/services/communityBuildSnapshot");
const {
  CustomBuildsService,
  CUSTOM_BUILD_ACTIVE_LIMIT,
} = require("../src/services/customBuilds");
const {
  PROXY_ELIGIBLE_BUILDING_NAMES,
} = require("../src/services/knownBuildings");
const fs = require("node:fs");
const path = require("node:path");
const { CommunityService } = require("../src/services/community");

const minimalBuild = (extra = {}) => ({
  slug: "bounded-build",
  name: "Bounded build",
  race: "Protoss",
  ...extra,
});

describe("custom/community build payload bounds", () => {
  test("validation drops giant unknown fields before persistence", () => {
    const giant = "private-giant".repeat(400_000);
    const result = validateCustomBuild(minimalBuild({
      unknownTopLevel: { giant },
      signature: [{
        unit: "Probe",
        count: 1,
        beforeSec: 17,
        unknownNested: giant,
      }],
      rules: [{
        type: "before",
        name: "BuildPylon",
        time_lt: 60,
        unknownNested: giant,
      }],
      steps: [{
        supply: 14,
        time: "0:18",
        action: "Pylon",
        unknownNested: giant,
      }],
    }));

    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("expected valid build");
    expect(result.value).not.toHaveProperty("unknownTopLevel");
    expect(result.value.signature).toEqual([
      { unit: "Probe", count: 1, beforeSec: 17 },
    ]);
    expect(result.value.rules).toEqual([
      { type: "before", name: "BuildPylon", time_lt: 60 },
    ]);
    expect(result.value.steps).toEqual([
      { supply: 14, time: "0:18", action: "Pylon" },
    ]);
  });

  test("proxy rule modifier is bounded, persisted, and structure-only", () => {
    const valid = validateCustomBuild(minimalBuild({
      rules: [{
        type: "before",
        name: "BuildBarracks",
        time_lt: 120,
        proxy: true,
      }],
    }));
    expect(valid).toEqual(expect.objectContaining({ valid: true }));
    expect(valid.value.rules).toEqual([{
      type: "before",
      name: "BuildBarracks",
      time_lt: 120,
      proxy: true,
    }]);

    const invalid = validateCustomBuild(minimalBuild({
      rules: [{
        type: "not_before",
        name: "BuildMarine",
        time_lt: 120,
        proxy: true,
      }],
    }));
    expect(invalid.valid).toBe(false);

    for (const name of [
      "BuildNydusWorm",
      "BuildSupplyDepot",
      "BuildShieldBattery",
      "BuildBarracksFlying",
      "BuildWarpGate",
      "BuildLair",
    ]) {
      expect(validateCustomBuild(minimalBuild({
        rules: [{
          type: "before", name, time_lt: 120, proxy: true,
        }],
      })).valid).toBe(false);
    }
    expect(validateCustomBuild(minimalBuild({
      rules: [{
        type: "before",
        name: "BuildNydusNetwork",
        time_lt: 120,
        proxy: true,
      }],
    })).valid).toBe(true);

    expect(publicBuildSnapshot({ rules: valid.value.rules }).rules).toEqual(
      valid.value.rules,
    );
  });

  test("legacy signature proxy modifier survives every bounded contract", () => {
    const valid = validateCustomBuild(minimalBuild({
      signature: [{
        unit: "Nydus Network",
        count: 1,
        beforeSec: 180,
        proxy: true,
        unknownNested: "discard me",
      }],
    }));
    expect(valid).toEqual(expect.objectContaining({ valid: true }));
    expect(valid.value.signature).toEqual([{
      unit: "Nydus Network",
      count: 1,
      beforeSec: 180,
      proxy: true,
    }]);

    const canonicalToken = validateCustomBuild(minimalBuild({
      signature: [{
        unit: "BuildBarracks",
        count: 1,
        beforeSec: 120,
        proxy: true,
      }],
    }));
    expect(canonicalToken.valid).toBe(true);

    for (const unit of [
      "cyberneticscore",
      "commandcenter",
      "photoncannon",
      "spawningpool",
    ]) {
      expect(validateCustomBuild(minimalBuild({
        signature: [{ unit, count: 1, beforeSec: 120, proxy: true }],
      })).valid).toBe(true);
    }

    for (const unit of [
      "Marine",
      "BuildMarine",
      "Shield Battery",
      "Nydus Worm",
      "BuildBarracksFlying",
    ]) {
      const invalid = validateCustomBuild(minimalBuild({
        signature: [{ unit, count: 1, beforeSec: 120, proxy: true }],
      }));
      expect(invalid.valid).toBe(false);
      expect(invalid.errors).toEqual([
        expect.stringContaining("proxy is only valid for a known structure"),
      ]);
    }

    expect(publicBuildSnapshot({ signature: valid.value.signature }).signature)
      .toEqual(valid.value.signature);
  });

  test("API proxy eligibility exactly matches the local JSON schema", () => {
    const schema = JSON.parse(fs.readFileSync(path.resolve(
      __dirname,
      "../../replay-engine/data/custom_builds.schema.json",
    ), "utf8"));
    const schemaNames = schema.definitions.proxyStructureName.enum
      .map((token) => token.slice("Build".length))
      .sort();
    expect([...PROXY_ELIGIBLE_BUILDING_NAMES].sort()).toEqual(schemaNames);
  });

  test("validation preserves bounded legacy steps and rejects oversized arrays", () => {
    const legacy = validateCustomBuild(minimalBuild({
      matchup: "PvT",
      steps: [{ supply: null, time: 18, action: "Pylon" }],
    }));
    expect(legacy).toEqual(expect.objectContaining({ valid: true }));

    const tooManySignatures = validateCustomBuild(minimalBuild({
      signature: Array.from(
        { length: SIGNATURE_MAX_ITEMS + 1 },
        () => ({ unit: "Probe", count: 1, beforeSec: 17 }),
      ),
    }));
    expect(tooManySignatures.valid).toBe(false);

    const tooManySteps = validateCustomBuild(minimalBuild({
      steps: Array.from(
        { length: LEGACY_STEPS_MAX_ITEMS + 1 },
        () => ({ action: "Probe" }),
      ),
    }));
    expect(tooManySteps.valid).toBe(false);
  });

  test("public snapshots are bounded deep copies of safe leaves", () => {
    const giant = "x".repeat(5 * 1024 * 1024);
    const input = {
      name: giant,
      race: "Protoss",
      description: giant,
      privateNote: giant,
      signature: Array.from(
        { length: SIGNATURE_MAX_ITEMS + 10 },
        (_, index) => ({
          unit: index === 0 ? giant : "Probe",
          count: 1,
          beforeSec: 17,
          giant,
        }),
      ),
      steps: Array.from(
        { length: LEGACY_STEPS_MAX_ITEMS + 10 },
        () => ({ action: giant, secret: giant }),
      ),
    };

    const snapshot = publicBuildSnapshot(input);
    expect(snapshot.name).toHaveLength(120);
    expect(snapshot.description).toHaveLength(4000);
    expect(snapshot.signature).toHaveLength(SIGNATURE_MAX_ITEMS);
    expect(snapshot.signature[0]).toEqual({
      unit: expect.stringMatching(/^x{80}$/),
      count: 1,
      beforeSec: 17,
    });
    expect(snapshot.steps).toHaveLength(LEGACY_STEPS_MAX_ITEMS);
    expect(snapshot.steps[0].action).toHaveLength(280);
    expect(snapshot).not.toHaveProperty("privateNote");
    expect(snapshot.signature[0]).not.toBe(input.signature[0]);
    expect(snapshot.steps[0]).not.toBe(input.steps[0]);
  });

  test("Mongo public projections never request the whole nested build", () => {
    const projection = publicBuildMongoLeafProjection("build");
    expect(projection).not.toHaveProperty("build");
    expect(projection).toEqual(expect.objectContaining({
      "build.signature.unit": 1,
      "build.signature.proxy": 1,
      "build.rules.name": 1,
      "build.rules.proxy": 1,
      "build.steps.action": 1,
    }));

    const expression = publicBuildMongoExpression("$build");
    expect(expression.signature).toEqual(expect.objectContaining({
      $map: expect.any(Object),
    }));
    expect(expression.signature.$map.in.proxy).toEqual(expect.objectContaining({
      $cond: expect.any(Array),
    }));
    expect(expression.steps).toEqual(expect.objectContaining({
      $map: expect.any(Object),
    }));
    expect(expression).not.toBe("$build");
  });

  test("private list and classifier bound arrays in Mongo plus a hard limit", async () => {
    const pipelines = [];
    const cursor = {
      toArray: jest.fn(async () => []),
    };
    const aggregate = jest.fn((pipeline) => {
      pipelines.push(pipeline);
      return cursor;
    });
    const service = new CustomBuildsService(
      { customBuilds: { aggregate }, customBuildJobs: {} },
    );

    await service.list("bounded-user");
    await service._listForClassification("bounded-user");

    expect(pipelines[0]).toContainEqual({ $limit: CUSTOM_BUILD_ACTIVE_LIMIT });
    expect(pipelines[1]).toContainEqual({
      $limit: CUSTOM_BUILD_ACTIVE_LIMIT + 1,
    });
    const listProjection = pipelines[0].find((stage) => stage.$project).$project;
    const classifierProjection = pipelines[1]
      .find((stage) => stage.$project).$project;
    expect(listProjection.signature).toEqual(expect.objectContaining({
      $map: expect.any(Object),
    }));
    expect(listProjection.signature.$map.in.proxy).toEqual(
      expect.objectContaining({ $cond: expect.any(Array) }),
    );
    expect(listProjection.steps).toEqual(expect.objectContaining({
      $map: expect.any(Object),
    }));
    expect(listProjection.notes).toEqual(expect.objectContaining({
      $cond: expect.any(Array),
    }));
    expect(classifierProjection.rules).toEqual(expect.objectContaining({
      $map: expect.any(Object),
    }));
    expect(classifierProjection.signature.$map.in.proxy).toEqual(
      expect.objectContaining({ $cond: expect.any(Array) }),
    );
    expect(classifierProjection).not.toHaveProperty("steps");
  });

  test("new builds stop at the active quota while existing builds remain editable", async () => {
    const customBuilds = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ _id: "existing" }),
      countDocuments: jest.fn(async () => CUSTOM_BUILD_ACTIVE_LIMIT),
      updateOne: jest.fn(async () => ({ acknowledged: true })),
    };
    const service = new CustomBuildsService({ customBuilds, customBuildJobs: {} });

    await expect(service.upsert("quota-user", minimalBuild()))
      .rejects.toMatchObject({
        message: expect.stringContaining("100 active custom builds"),
        status: 409,
        code: "custom_build_limit_reached",
      });
    expect(customBuilds.updateOne).not.toHaveBeenCalled();

    await expect(service.upsert("quota-user", minimalBuild()))
      .resolves.toBeUndefined();
    expect(customBuilds.updateOne).toHaveBeenCalledTimes(1);
  });

  test("serializes concurrent creates so the active quota cannot be overrun", async () => {
    const slugs = new Set(Array.from(
      { length: CUSTOM_BUILD_ACTIVE_LIMIT - 1 },
      (_, index) => `existing-${index}`,
    ));
    const customBuilds = {
      findOne: jest.fn(async ({ slug }) => slugs.has(slug) ? { _id: slug } : null),
      countDocuments: jest.fn(async () => slugs.size),
      updateOne: jest.fn(async ({ slug }) => {
        await new Promise((resolve) => setImmediate(resolve));
        slugs.add(slug);
        return { acknowledged: true };
      }),
    };
    const service = new CustomBuildsService({ customBuilds, customBuildJobs: {} });

    const outcomes = await Promise.allSettled([
      service.upsert("quota-user", minimalBuild({ slug: "create-a" })),
      service.upsert("quota-user", minimalBuild({ slug: "create-b" })),
    ]);

    expect(outcomes.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((row) => row.status === "rejected")).toHaveLength(1);
    expect(slugs.size).toBe(CUSTOM_BUILD_ACTIVE_LIMIT);
    expect(customBuilds.updateOne).toHaveBeenCalledTimes(1);
  });

  test("community list requests nested leaves and sanitizes legacy rows", async () => {
    let projection;
    const cursor = {
      toArray: jest.fn(async () => [{
        slug: "public-build",
        title: "Public build",
        build: {
          name: "Safe",
          signature: [{
            unit: "Barracks",
            count: 1,
            beforeSec: 17,
            proxy: true,
            secret: "x",
          }],
          secret: "x",
        },
      }]),
    };
    const service = new CommunityService({
      communityBuilds: {
        aggregate: jest.fn((pipeline) => {
          projection = pipeline.find((stage) => stage.$project).$project;
          return cursor;
        }),
        countDocuments: jest.fn(async () => 1),
      },
    });

    const result = await service.listPublic();
    expect(projection.build).not.toBe(1);
    expect(projection.build).not.toBe("$build");
    expect(projection.build.signature).toEqual(expect.objectContaining({
      $map: expect.any(Object),
    }));
    expect(result.items[0].build).toEqual({
      name: "Safe",
      signature: [{
        unit: "Barracks",
        count: 1,
        beforeSec: 17,
        proxy: true,
      }],
    });
  });
});
