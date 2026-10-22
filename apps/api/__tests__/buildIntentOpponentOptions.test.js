// @ts-nocheck
"use strict";

/**
 * Build check-in options, unit level: the opponent side's fit rules, the
 * per-side cache (separate keys, one invalidation for both) and the request
 * validation of ``side`` and ``opponentBuildKey``. Fake collections, no
 * Mongo.
 */

const {
  BuildIntentOptions,
  fitsOpponentMatchup,
  mirrorMatchup,
} = require("../src/services/buildIntentOptions");
const {
  parseSideParam,
  validateGameIntentBody,
} = require("../src/validation/buildIntent");

function fakeDb() {
  const calls = { aggregate: 0, customFind: [] };
  return {
    calls,
    games: {
      aggregate: () => {
        calls.aggregate += 1;
        return { toArray: async () => [] };
      },
    },
    customBuilds: {
      find: (filter) => {
        calls.customFind.push(filter);
        return { toArray: async () => [] };
      },
      findOne: async () => null,
    },
    users: { findOne: async () => null },
  };
}

describe("opponent fit", () => {
  test("mirrors the matchup", () => {
    expect(mirrorMatchup("PvZ")).toBe("ZvP");
    expect(mirrorMatchup("TvT")).toBe("TvT");
  });

  test("custom opponent builds fit by their race and the user's race", () => {
    const custom = (race, vsRace) => ({
      ref: { key: "custom:x", name: "X", slug: "x", source: "custom" }, race, vsRace,
    });
    expect(fitsOpponentMatchup(custom("Zerg", "Protoss"), "PvZ")).toBe(true);
    expect(fitsOpponentMatchup(custom("Zerg", "Any"), "PvZ")).toBe(true);
    expect(fitsOpponentMatchup(custom("Zerg", null), "PvZ")).toBe(true);
    expect(fitsOpponentMatchup(custom("Zerg", "Terran"), "PvZ")).toBe(false);
    expect(fitsOpponentMatchup(custom("Protoss", "Zerg"), "PvZ")).toBe(false);
    expect(fitsOpponentMatchup(custom("Zerg", "Protoss"), null)).toBe(false);
  });

  test("catalog builds fit when they are one of the matchup's opponent strategies", () => {
    const catalog = (name) => ({ ref: { key: "k", name, slug: null, source: "catalog" }, race: null, vsRace: null });
    expect(fitsOpponentMatchup(catalog("Zerg - 12 Pool"), "PvZ")).toBe(true);
    expect(fitsOpponentMatchup(catalog("Zerg - 8 Pool"), "PvZ")).toBe(true);
    expect(fitsOpponentMatchup(catalog("Protoss - DT Rush"), "ZvP")).toBe(true);
    expect(fitsOpponentMatchup(catalog("ZvP - Ling Bane Bust"), "ZvP")).toBe(false);
    expect(fitsOpponentMatchup(catalog("PvZ - 2 Stargate Phoenix"), "PvZ")).toBe(false);
    expect(fitsOpponentMatchup(catalog("Zerg - Standard Play (Unclassified)"), "PvZ")).toBe(false);
  });
});

describe("options cache", () => {
  test("each side has its own entry and invalidate drops both", async () => {
    const db = fakeDb();
    let nowMs = 1_000;
    const options = new BuildIntentOptions(db, { now: () => nowMs });
    const you = await options.forMatchup("u1", "PvZ");
    const opp = await options.forOpponent("u1", "PvZ");
    expect(you.side).toBe("you");
    expect(opp.side).toBe("opponent");
    expect(db.calls.aggregate).toBe(2);
    expect(db.calls.customFind.map((f) => f.perspective)).toEqual([{ $ne: "opponent" }, "opponent"]);
    await options.forSide("u1", "PvZ", "you");
    await options.forSide("u1", "PvZ", "opponent");
    await options.forOpponent("u2", "PvZ");
    expect(db.calls.aggregate).toBe(3);
    options.invalidate("u1");
    await options.forMatchup("u1", "PvZ");
    await options.forOpponent("u1", "PvZ");
    // u2's entry survives u1's invalidation.
    await options.forOpponent("u2", "PvZ");
    expect(db.calls.aggregate).toBe(5);
    nowMs += 61_000;
    await options.forOpponent("u2", "PvZ");
    expect(db.calls.aggregate).toBe(6);
  });

  test("an opponent key resolves only among opponent options or opponent builds", async () => {
    const db = fakeDb();
    const lookups = [];
    db.customBuilds.findOne = async (filter) => {
      lookups.push(filter);
      return filter.perspective === "opponent" && filter.slug === "theirs"
        ? { slug: "theirs", name: "Theirs", race: "Zerg", vsRace: "Protoss" }
        : null;
    };
    const options = new BuildIntentOptions(db);
    expect(await options.resolveOpponentKey("u1", "PvZ", "zerg-12-pool"))
      .toEqual({ key: "zerg-12-pool", name: "Zerg - 12 Pool", slug: null, source: "catalog" });
    expect(await options.resolveOpponentKey("u1", "PvZ", "custom:theirs"))
      .toEqual({ key: "custom:theirs", name: "Theirs", slug: "theirs", source: "custom" });
    expect(await options.resolveOpponentKey("u1", "TvZ", "custom:theirs")).toBeNull();
    expect(await options.resolveOpponentKey("u1", "PvZ", "pvz-2-stargate-phoenix")).toBeNull();
    expect(await options.resolveOpponentKey("u1", "PvZ", "Bad Key")).toBeNull();
    expect(await options.resolveOpponentKey("u1", "PvX", "zerg-12-pool")).toBeNull();
    expect(lookups.every((f) => f.perspective === "opponent" && f.deletedAt.$exists === false)).toBe(true);
  });
});

describe("request validation", () => {
  test("side defaults to you and accepts only you / opponent", () => {
    expect(parseSideParam(undefined)).toBe("you");
    expect(parseSideParam("you")).toBe("you");
    expect(parseSideParam("opponent")).toBe("opponent");
    for (const raw of ["", "Opponent", "them", ["opponent"], 1]) expect(parseSideParam(raw)).toBeNull();
  });

  test("opponentBuildKey is a key or null, on every action", () => {
    for (const action of ["confirm", "skip", "defer", "notes", "opponent"]) {
      const body = { action, notes: "n", opponentBuildKey: "zerg-12-pool" };
      expect(validateGameIntentBody(body)).toEqual({ valid: true, value: body });
      expect(validateGameIntentBody({ ...body, opponentBuildKey: null }).valid).toBe(true);
    }
    for (const opponentBuildKey of [7, "", "x".repeat(201), {}, false]) {
      expect(validateGameIntentBody({ action: "skip", opponentBuildKey })).toEqual(expect.objectContaining({
        valid: false, code: "unknown_opponent_build",
      }));
    }
    expect(validateGameIntentBody({ action: "opponent" })).toEqual(expect.objectContaining({
      valid: false, code: "invalid_request",
    }));
    expect(validateGameIntentBody({ action: "opponent", opponentBuildKey: 7 }).code).toBe("unknown_opponent_build");
    expect(validateGameIntentBody({ action: "explode", opponentBuildKey: 7 }).code).toBe("invalid_action");
    expect(validateGameIntentBody({ action: "skip", side: "opponent" }).code).toBe("invalid_request");
  });
});
