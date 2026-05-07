// @ts-nocheck
"use strict";

const {
  attachRecentByMap,
  attachRecentByMatchup,
  mergeRecent,
  RECENT_RESULTS_PER_BUCKET,
} = require("../src/services/recentResults");

function buildGames(handler) {
  return {
    aggregate(pipeline) {
      return {
        toArray: () => Promise.resolve(handler(pipeline)),
      };
    },
  };
}

describe("services/recentResults", () => {
  describe("mergeRecent", () => {
    test("attaches normalised win/loss arrays to matching rows", () => {
      const out = mergeRecent(
        [{ name: "vs Z" }, { name: "vs P" }],
        [
          { _id: "vs Z", results: ["Victory", "Defeat", "Victory"] },
          { _id: "vs P", results: ["Defeat", "Defeat"] },
        ],
      );
      expect(out[0].recent).toEqual(["win", "loss", "win"]);
      expect(out[1].recent).toEqual(["loss", "loss"]);
    });

    test("rows with no group entry get an empty recent[]", () => {
      const out = mergeRecent(
        [{ name: "vs Z" }, { name: "vs T" }],
        [{ _id: "vs Z", results: ["Victory"] }],
      );
      expect(out[0].recent).toEqual(["win"]);
      expect(out[1].recent).toEqual([]);
    });

    test("ties and unknowns are dropped, not counted", () => {
      const out = mergeRecent(
        [{ name: "vs Z" }],
        [
          {
            _id: "vs Z",
            results: ["Victory", "Tie", "", null, "Defeat"],
          },
        ],
      );
      expect(out[0].recent).toEqual(["win", "loss"]);
    });

    test("caps each row at RECENT_RESULTS_PER_BUCKET", () => {
      const results = Array.from(
        { length: RECENT_RESULTS_PER_BUCKET + 5 },
        () => "Victory",
      );
      const out = mergeRecent(
        [{ name: "Acropolis LE" }],
        [{ _id: "Acropolis LE", results }],
      );
      expect(out[0].recent).toHaveLength(RECENT_RESULTS_PER_BUCKET);
    });
  });

  describe("attachRecentByMap", () => {
    test("emits a sort + group pipeline on the map field", async () => {
      let captured;
      const games = buildGames((pipeline) => {
        captured = pipeline;
        return [{ _id: "Goldenaura LE", results: ["Victory", "Defeat"] }];
      });
      const out = await attachRecentByMap(
        { games },
        "u1",
        {},
        [{ name: "Goldenaura LE" }],
      );
      expect(captured[0]).toEqual({ $match: { userId: "u1" } });
      expect(captured[1]).toEqual({ $sort: { date: -1 } });
      expect(captured[2].$project.mapName).toEqual({
        $ifNull: ["$map", "Unknown"],
      });
      expect(captured[3]).toEqual({
        $group: { _id: "$mapName", results: { $push: "$result" } },
      });
      expect(out[0].recent).toEqual(["win", "loss"]);
    });

    test("noop on empty rows — no Mongo round trip", async () => {
      const games = buildGames(() => {
        throw new Error("aggregate should not be called");
      });
      const out = await attachRecentByMap({ games }, "u1", {}, []);
      expect(out).toEqual([]);
    });
  });

  describe("attachRecentByMatchup", () => {
    test("groups by `vs <Race>` label", async () => {
      let captured;
      const games = buildGames((pipeline) => {
        captured = pipeline;
        return [{ _id: "vs Z", results: ["Victory"] }];
      });
      const out = await attachRecentByMatchup(
        { games },
        "u1",
        {},
        [{ name: "vs Z" }],
      );
      const projectStage = captured.find((s) => s && s.$project);
      // Sanity: the projection emits a `matchup` field used by the
      // group below — same shape mapFacet uses for its `_id`.
      expect(projectStage.$project.matchup).toBeDefined();
      expect(out[0].recent).toEqual(["win"]);
    });
  });
});
