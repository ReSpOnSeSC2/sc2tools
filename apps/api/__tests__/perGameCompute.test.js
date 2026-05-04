// @ts-nocheck
"use strict";

const { parseBuildLogLines, PerGameComputeService, MacroBackfillService } = require("../src/services/perGameCompute");

describe("services/perGameCompute", () => {
  describe("parseBuildLogLines", () => {
    test("returns [] for non-array input", () => {
      expect(parseBuildLogLines(null)).toEqual([]);
      expect(parseBuildLogLines(undefined)).toEqual([]);
      expect(parseBuildLogLines("[1:23] Pylon")).toEqual([]);
    });

    test("parses [m:ss] Name lines and sorts chronologically", () => {
      const events = parseBuildLogLines([
        "[2:14] Stalker",
        "[1:23] Pylon",
        "[3:45] Stargate",
      ]);
      expect(events).toHaveLength(3);
      expect(events[0]).toMatchObject({
        time: 83,
        time_display: "1:23",
        name: "Pylon",
        display: "Pylon",
        race: "Neutral",
        category: "unknown",
        tier: 0,
        is_building: false,
      });
      expect(events.map((e) => e.name)).toEqual(["Pylon", "Stalker", "Stargate"]);
    });

    test("strips noise lines (Beacon, Reward, Spray)", () => {
      const events = parseBuildLogLines([
        "[0:00] Beacon (Place)",
        "[0:00] Reward",
        "[0:00] Spray",
        "[1:00] Pylon",
      ]);
      expect(events).toHaveLength(1);
      expect(events[0].name).toBe("Pylon");
    });

    test("uses the catalog when supplied", () => {
      const catalog = {
        lookup: (n) => {
          if (n === "Pylon") {
            return {
              display: "Pylon (Building)",
              race: "Protoss",
              category: "supply",
              tier: 1,
              isBuilding: true,
              comp: { food: 8 },
            };
          }
          return null;
        },
      };
      const events = parseBuildLogLines(["[1:00] Pylon"], catalog);
      expect(events[0]).toMatchObject({
        display: "Pylon (Building)",
        race: "Protoss",
        category: "supply",
        tier: 1,
        is_building: true,
        comp: { food: 8 },
      });
    });

    test("ignores lines that don't match the [m:ss] regex", () => {
      const events = parseBuildLogLines([
        "garbage",
        "[abc] thing",
        "[1:00] Pylon",
      ]);
      expect(events).toHaveLength(1);
    });

    test("survives a catalog lookup that throws", () => {
      const catalog = {
        lookup: () => {
          throw new Error("boom");
        },
      };
      const events = parseBuildLogLines(["[1:00] Pylon"], catalog);
      expect(events[0].display).toBe("Pylon");
    });
  });

  describe("PerGameComputeService.buildOrder", () => {
    function buildService(game) {
      const games = {
        async findOne() {
          return game;
        },
      };
      return new PerGameComputeService({ games });
    }

    test("returns null when game is missing", async () => {
      const svc = buildService(null);
      expect(await svc.buildOrder("u1", "g1")).toBeNull();
    });

    test("parses every stored build log array", async () => {
      const svc = buildService({
        gameId: "g1",
        myBuild: "P - Stargate Rush",
        myRace: "Protoss",
        opponent: { strategy: "Cheese", displayName: "Foo", race: "Z" },
        map: "Goldenaura",
        result: "Victory",
        buildLog: ["[1:00] Pylon"],
        earlyBuildLog: ["[0:30] Probe"],
        oppBuildLog: ["[1:30] Drone"],
        oppEarlyBuildLog: ["[0:30] Hatchery"],
      });
      const out = await svc.buildOrder("u1", "g1");
      expect(out.events).toHaveLength(1);
      expect(out.early_events).toHaveLength(1);
      expect(out.opp_events).toHaveLength(1);
      expect(out.opp_early_events).toHaveLength(1);
      expect(out.opponent).toBe("Foo");
    });
  });

  describe("MacroBackfillService.start", () => {
    test("emits a recompute request and returns the job id", async () => {
      const docs = [{ gameId: "g1" }, { gameId: "g2" }];
      let inserted = null;
      const games = {
        find: () => ({
          sort: () => ({
            limit: () => ({
              toArray: () => Promise.resolve(docs),
            }),
            toArray: () => Promise.resolve(docs),
          }),
        }),
      };
      const macroJobs = {
        async insertOne(doc) {
          inserted = doc;
          return { insertedId: "abc123" };
        },
      };
      const emitted = [];
      const io = {
        to: (room) => ({
          emit: (event, payload) => emitted.push({ room, event, payload }),
        }),
      };
      const svc = new MacroBackfillService({ games, macroJobs }, { io });
      const out = await svc.start("user-1");
      expect(out.total).toBe(2);
      expect(out.status).toBe("pending");
      expect(emitted[0].room).toBe("user:user-1");
      expect(emitted[0].event).toBe("macro:recompute_request");
      expect(emitted[0].payload.gameIds).toEqual(["g1", "g2"]);
      expect(inserted.total).toBe(2);
    });

    test("immediately marks done when no games need recompute", async () => {
      const games = {
        find: () => ({
          sort: () => ({ toArray: () => Promise.resolve([]) }),
        }),
      };
      const macroJobs = {
        async insertOne() {
          return { insertedId: "x" };
        },
      };
      const svc = new MacroBackfillService({ games, macroJobs });
      const out = await svc.start("user-1");
      expect(out.total).toBe(0);
      expect(out.status).toBe("done");
    });
  });
});
