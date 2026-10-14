// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { MultichatStudioService } = require("../src/services/multichatStudio");
const {
  DEFAULT_BUILD_PROFILE,
  prepareBuildProfileUpdate,
  sanitizeBuildProfile,
} = require("../src/services/buildProfile");
const { DEFAULT_WIDGETS, KNOWN_WIDGETS } = require("../src/services/overlayTokens");
const { buildSamplePayload, PER_WIDGET_KEYS } = require("../src/services/overlayLiveSamples");
const { buildMultichatRouter } = require("../src/routes/multichat");
const { buildErrorHandler } = require("../src/middleware/errorHandler");

const RATINGS = {
  aggressiveness: 4,
  defensiveness: 2,
  executionDifficulty: 3,
  popularity: 1,
  micro: 5,
};
const PROFILE = {
  title: "Test build", labels: DEFAULT_BUILD_PROFILE.labels, ratings: RATINGS, visible: false,
};

// The service's own Mongo-facing revision guards run here, including two
// independent API workers. No actual database, account or overlay token is used.
function memoryCollection() {
  const rows = [];
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => {
    if (key === "$or") return value.some((part) => matches(row, part));
    if (key === "$and") return value.every((part) => matches(row, part));
    if (value && typeof value === "object" && "$exists" in value) {
      return Object.hasOwn(row, key) === value.$exists;
    }
    return row[key] === value;
  });
  return {
    findOne: jest.fn(async (filter) => {
      await new Promise((resolve) => setImmediate(resolve));
      const row = rows.find((item) => matches(item, filter));
      return row ? structuredClone(row) : null;
    }),
    updateOne: jest.fn(async (filter, update, options = {}) => {
      await new Promise((resolve) => setImmediate(resolve));
      let row = rows.find((item) => matches(item, filter));
      let inserted = false;
      if (!row && options.upsert) {
        const key = update.$set?.studioKey || filter.studioKey;
        if (rows.some((item) => item.studioKey === key)) {
          throw Object.assign(new Error("Duplicate canonical key"), { code: 11000 });
        }
        row = { ...update.$setOnInsert };
        rows.push(row);
        inserted = true;
      }
      if (!row) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      Object.assign(row, structuredClone(update.$set || {}));
      for (const [key, increment] of Object.entries(update.$inc || {})) {
        row[key] = (row[key] || 0) + increment;
      }
      return {
        matchedCount: inserted ? 0 : 1,
        modifiedCount: inserted ? 0 : 1,
        upsertedCount: inserted ? 1 : 0,
      };
    }),
  };
}

describe("build-profile read and write validation", () => {
  test("starts hidden with every rating unset and independent safe defaults", () => {
    for (const value of [undefined, null, [], 42, "junk"]) {
      const result = sanitizeBuildProfile(value);
      expect(result).toEqual(DEFAULT_BUILD_PROFILE);
      expect(result).not.toBe(DEFAULT_BUILD_PROFILE);
      expect(result.ratings).not.toBe(DEFAULT_BUILD_PROFILE.ratings);
    }
  });

  test("read sanitizer strips unknown fields and fails closed on missing or coerced ratings", () => {
    const result = sanitizeBuildProfile({
      ...PROFILE,
      title: "  Test build  ",
      visible: true,
      ratings: { ...RATINGS, micro: "5", extra: 5 },
      opponentName: "must not survive",
    });
    expect(result).toEqual({
      title: "Test build",
      labels: DEFAULT_BUILD_PROFILE.labels,
      ratings: { ...RATINGS, micro: null },
      visible: false,
    });
    expect(sanitizeBuildProfile({ ...PROFILE, title: "   ", visible: true }).visible).toBe(false);
    expect(sanitizeBuildProfile({ ...PROFILE, visible: "true" }).visible).toBe(false);
  });

  test.each(["4", true, false, 0, 6, 2.5, NaN, Infinity, undefined, {}, []])(
    "does not coerce or clamp invalid rating %p", (value) => {
      expect(() => prepareBuildProfileUpdate({ ratings: { micro: value } }, PROFILE))
        .toThrow("integer from 1 to 5");
    },
  );

  test.each([null, [], "junk", 42])("rejects malformed profile patch %p", (patch) => {
    expect(() => prepareBuildProfileUpdate(patch, PROFILE)).toThrow("must be an object");
  });

  test("requires text title, object ratings and boolean visibility", () => {
    expect(() => prepareBuildProfileUpdate({ title: 4 }, PROFILE)).toThrow("must be text");
    expect(() => prepareBuildProfileUpdate({ ratings: null }, PROFILE)).toThrow("must be an object");
    expect(() => prepareBuildProfileUpdate({ visible: "false" }, PROFILE)).toThrow("true or false");
  });

  test.each(["", "  ", "x".repeat(33), 3, null, true])(
    "rejects an invalid editable axis label %p", (value) => {
      expect(() => prepareBuildProfileUpdate({ labels: { micro: value } }, PROFILE))
        .toThrow("nonblank text of at most 32 characters");
    },
  );

  test("keeps legacy axis wording usable and sanitizes malformed labels", () => {
    expect(sanitizeBuildProfile({ ...PROFILE, labels: {
      micro: "  Unit control  ",
      aggressiveness: " ",
      defensiveness: 1,
      executionDifficulty: "x".repeat(33),
      unknown: "must not survive",
    } }).labels).toEqual({ ...DEFAULT_BUILD_PROFILE.labels, micro: "Unit control" });
    expect(() => prepareBuildProfileUpdate({ labels: [] }, PROFILE)).toThrow("labels must be an object");
  });

  test("trims/caps titles and does not copy unknown keys", () => {
    const result = prepareBuildProfileUpdate({
      title: `  ${"a".repeat(100)}  `,
      ratings: { micro: 1, secret: 5 },
      privateReplay: "must not survive",
    }, PROFILE);
    expect(result).toEqual({ ...PROFILE, title: "a".repeat(80), ratings: { ...RATINGS, micro: 1 } });
  });

  test("rejects incomplete show and clearing a visible rating, but allows hidden drafts", () => {
    const draft = prepareBuildProfileUpdate({ title: "Draft", ratings: { micro: 2 } }, null);
    expect(draft.visible).toBe(false);
    expect(draft.ratings.aggressiveness).toBeNull();
    expect(() => prepareBuildProfileUpdate({ visible: true }, draft)).toThrow("all five ratings");
    expect(() => prepareBuildProfileUpdate({ ratings: { micro: null } }, { ...PROFILE, visible: true }))
      .toThrow("all five ratings");
    expect(prepareBuildProfileUpdate({ visible: false, ratings: { micro: null } }, { ...PROFILE, visible: true }))
      .toEqual({ ...PROFILE, ratings: { ...RATINGS, micro: null } });
  });
});

describe("build-profile persisted studio contract", () => {
  let col;
  let service;
  let emit;
  let io;

  beforeEach(() => {
    col = memoryCollection();
    emit = jest.fn();
    io = { to: jest.fn(() => ({ emit })) };
    service = new MultichatStudioService({ multichatStudio: col }, { io });
  });

  test("persists across fresh service boots, with manual show/hide retaining content", async () => {
    expect((await service.get("test-a")).buildProfile).toEqual(DEFAULT_BUILD_PROFILE);
    await service.update("test-a", { buildProfile: PROFILE });
    const reloaded = new MultichatStudioService({ multichatStudio: col });
    expect((await reloaded.get("test-a")).buildProfile).toEqual(PROFILE);
    expect((await service.update("test-a", { buildProfile: { visible: true } })).buildProfile)
      .toEqual({ ...PROFILE, visible: true });
    expect((await service.update("test-a", { buildProfile: { ratings: { micro: 2 } } })).buildProfile)
      .toEqual({ ...PROFILE, ratings: { ...RATINGS, micro: 2 }, visible: true });
    expect((await service.update("test-a", { buildProfile: { visible: false } })).buildProfile)
      .toEqual({ ...PROFILE, ratings: { ...RATINGS, micro: 2 } });
  });

  test("isolates token state and broadcasts the saved sanitized snapshot only to its room", async () => {
    const snapshot = await service.update("test-a", { buildProfile: PROFILE });
    expect((await service.get("test-b")).buildProfile).toEqual(DEFAULT_BUILD_PROFILE);
    expect(io.to).toHaveBeenLastCalledWith("overlay:test-a");
    expect(emit).toHaveBeenLastCalledWith("overlay:multichat", snapshot);
    expect(snapshot.buildProfile).toEqual(PROFILE);
    expect(snapshot.studioKey).toBeUndefined();
    expect(snapshot.token).toBeUndefined();
  });

  test("custom axis wording persists without changing scores or visibility", async () => {
    await service.update("test-a", { buildProfile: { ...PROFILE, visible: true } });
    const edited = await service.update("test-a", { buildProfile: {
      labels: { micro: "  Unit control  ", popularity: "Build frequency" },
    } });
    const expected = {
      ...PROFILE,
      labels: { ...PROFILE.labels, micro: "Unit control", popularity: "Build frequency" },
      visible: true,
    };
    expect(edited.buildProfile).toEqual(expected);
    const reloaded = new MultichatStudioService({ multichatStudio: col });
    expect((await reloaded.get("test-a")).buildProfile).toEqual(expected);
    const hidden = await service.update("test-a", { buildProfile: { visible: false } });
    expect(hidden.buildProfile).toEqual({ ...expected, visible: false });
  });

  test("invalid writes do not persist or broadcast", async () => {
    await service.update("test-a", { buildProfile: PROFILE });
    emit.mockClear();
    col.updateOne.mockClear();
    await expect(service.update("test-a", { buildProfile: { ratings: { micro: 9 } } }))
      .rejects.toMatchObject({ status: 400, code: "invalid_build_profile" });
    expect(col.updateOne).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect((await service.get("test-a")).buildProfile).toEqual(PROFILE);
  });

  test("two API workers merge simultaneous initial title and score edits", async () => {
    const other = new MultichatStudioService({ multichatStudio: col });
    await Promise.all([
      service.update("test-a", { buildProfile: { title: "Shared draft" } }),
      other.update("test-a", { buildProfile: { ratings: { micro: 2 } } }),
    ]);
    expect((await service.get("test-a")).buildProfile).toEqual({
      title: "Shared draft",
      labels: DEFAULT_BUILD_PROFILE.labels,
      ratings: { ...DEFAULT_BUILD_PROFILE.ratings, micro: 2 },
      visible: false,
    });
  });

  test("two API workers preserve simultaneous rating and visibility edits", async () => {
    await service.update("test-a", { buildProfile: { ...PROFILE, visible: true } });
    const other = new MultichatStudioService({ multichatStudio: col });
    await Promise.all([
      service.update("test-a", { buildProfile: { ratings: { micro: 2 } } }),
      other.update("test-a", { buildProfile: { visible: false } }),
    ]);
    expect((await service.get("test-a")).buildProfile).toEqual({
      ...PROFILE, ratings: { ...RATINGS, micro: 2 },
    });
  });

  test("profile edits keep other studio features and combined b-roll edits use both guards", async () => {
    await service.update("test-a", { goals: [{ label: "Target", current: 2, target: 5 }] });
    const snapshot = await service.update("test-a", {
      buildProfile: PROFILE,
      broll: { volume: 9 },
    });
    expect(snapshot.goals).toEqual([{ label: "Target", current: 2, target: 5 }]);
    expect(snapshot.buildProfile).toEqual(PROFILE);
    expect(snapshot.broll.volume).toBe(9);
  });
});

describe("build-profile route and widget registration", () => {
  test("is an opt-in widget and its test payload cannot light up opponent widgets", () => {
    expect(KNOWN_WIDGETS).toContain("build-profile");
    expect(DEFAULT_WIDGETS).not.toContain("build-profile");
    expect(PER_WIDGET_KEYS["build-profile"]).toEqual([]);
    expect(buildSamplePayload("build-profile")).toEqual({ myRace: "Protoss", oppRace: "Zerg", matchup: "PvZ" });
  });

  test("real studio route returns 400 for incomplete show and 401 for revoked credentials", async () => {
    const service = new MultichatStudioService({ multichatStudio: memoryCollection() });
    const app = express();
    app.use(express.json());
    app.use("/v1", buildMultichatRouter({
      overlayTokens: { resolve: async (token) => token === "test-a" ? { userId: "test-user" } : null },
      users: { getPreferences: async () => ({}) },
      studio: service,
      tiktokRelay: {},
    }));
    app.use(buildErrorHandler({ error: jest.fn() }));
    const invalid = await request(app).post("/v1/multichat/test-a/studio")
      .send({ buildProfile: { visible: true } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("incomplete_build_profile");
    expect((await service.get("test-a")).buildProfile).toEqual(DEFAULT_BUILD_PROFILE);
    const revoked = await request(app).post("/v1/multichat/revoked-test/studio")
      .send({ buildProfile: PROFILE });
    expect(revoked.status).toBe(401);
    expect((await service.get("revoked-test")).buildProfile).toEqual(DEFAULT_BUILD_PROFILE);
    const saved = await request(app).post("/v1/multichat/test-a/studio")
      .send({ buildProfile: PROFILE });
    expect(saved.status).toBe(200);
    const shown = await request(app).post("/v1/multichat/test-a/studio")
      .send({ buildProfile: { visible: true } });
    expect(shown.status).toBe(200);
    expect(shown.body.buildProfile).toEqual({ ...PROFILE, visible: true });
  });
});
