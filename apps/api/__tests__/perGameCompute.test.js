// @ts-nocheck
"use strict";

const {
  parseBuildLogLines,
  eventsToStartTime,
  PerGameComputeService,
  MacroBackfillService,
} = require("../src/services/perGameCompute");

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
      // Pylon is recognised as a building via the local known-buildings
      // fallback even with no catalog supplied — keeps the macro
      // breakdown's Buildings roster populated for cold-start requests
      // and deployments without the JSON catalog file on disk.
      expect(events[0]).toMatchObject({
        time: 83,
        time_display: "1:23",
        name: "Pylon",
        display: "Pylon",
        race: "Neutral",
        category: "building",
        tier: 0,
        is_building: true,
      });
      expect(events.map((e) => e.name)).toEqual(["Pylon", "Stalker", "Stargate"]);
    });

    test("uses local known-buildings fallback when catalog is null", () => {
      // Without the catalog file available, parseBuildLogLines used to
      // tag every event with is_building: false. The new fallback set
      // keeps the classification correct for the common buildings.
      const events = parseBuildLogLines([
        "[0:30] Stalker",
        "[1:00] Pylon",
        "[1:15] Hatchery",
        "[1:30] CommandCenter",
        "[2:00] WarpGate",
      ]);
      const byName = new Map(events.map((e) => [e.name, e]));
      expect(byName.get("Stalker")?.is_building).toBe(false);
      expect(byName.get("Pylon")?.is_building).toBe(true);
      expect(byName.get("Hatchery")?.is_building).toBe(true);
      expect(byName.get("CommandCenter")?.is_building).toBe(true);
      expect(byName.get("WarpGate")?.is_building).toBe(true);
    });

    test("tags upgrade events with category=upgrade via the catalog-independent fallback", () => {
      // Without the catalog JSON on disk, ``parseBuildLogLines`` used
      // to set ``category: "unknown"`` for every research event — the
      // macro-breakdown Upgrades chip row, the BuildOrderTimeline
      // upgrade tier, the Save-as-Build flow, and the custom-build
      // editor all key on ``category === "upgrade"`` and dropped them.
      // The new known-upgrade fallback restores the tagging end-to-end.
      const events = parseBuildLogLines([
        "[0:30] Stalker",            // unit, category=unknown is OK
        "[1:00] WarpGateResearch",   // upgrade
        "[2:30] BlinkTech",          // upgrade
        "[3:00] AdeptPiercingAttack",// upgrade
        "[4:00] ProtossGroundWeaponsLevel1",// upgrade
        "[5:00] Charge",             // upgrade
        "[1:30] CyberneticsCore",    // building
      ]);
      const byName = new Map(events.map((e) => [e.name, e]));
      expect(byName.get("WarpGateResearch")?.category).toBe("upgrade");
      expect(byName.get("WarpGateResearch")?.is_building).toBe(false);
      expect(byName.get("BlinkTech")?.category).toBe("upgrade");
      expect(byName.get("AdeptPiercingAttack")?.category).toBe("upgrade");
      expect(byName.get("ProtossGroundWeaponsLevel1")?.category).toBe("upgrade");
      expect(byName.get("Charge")?.category).toBe("upgrade");
      // Buildings and units stay correctly classified — upgrade fallback
      // never overrides a positive building match.
      expect(byName.get("CyberneticsCore")?.is_building).toBe(true);
      expect(byName.get("CyberneticsCore")?.category).toBe("building");
      expect(byName.get("Stalker")?.is_building).toBe(false);
    });

    test("upgrade fallback recognises Terran and Zerg research names", () => {
      const events = parseBuildLogLines([
        "[3:00] Stimpack",
        "[3:30] ShieldWall",
        "[4:00] PunisherGrenades",
        "[5:00] ZerglingMovementSpeed",
        "[6:00] CentrifugalHooks",
        "[7:00] GlialReconstitution",
        "[8:00] NeuralParasite",
      ]);
      for (const ev of events) {
        expect(ev.category).toBe("upgrade");
        expect(ev.is_building).toBe(false);
      }
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

    test("preserves recorded times — rule evaluator depends on this", () => {
      // The build-rule evaluator and ML training surface are calibrated
      // against the timestamps the agent recorded (start for non-morph
      // structures, finish for units / morphs / upgrades). Display
      // surfaces apply a separate ``eventsToStartTime`` normalization.
      // If parseBuildLogLines starts shifting times silently, every
      // user-saved custom build's ``time_lt`` thresholds would
      // change semantics overnight. Lock this in.
      const events = parseBuildLogLines([
        "[1:23] Pylon",
        "[2:14] Stalker",
        "[5:00] Lair",
        "[7:00] WarpGateResearch",
      ]);
      const byName = new Map(events.map((e) => [e.name, e.time]));
      expect(byName.get("Pylon")).toBe(83);
      expect(byName.get("Stalker")).toBe(134);
      expect(byName.get("Lair")).toBe(300);
      expect(byName.get("WarpGateResearch")).toBe(420);
    });
  });

  describe("eventsToStartTime", () => {
    test("rewinds finish-time events using the build-duration table", () => {
      const recorded = parseBuildLogLines([
        "[1:23] Pylon",
        "[3:00] Stalker",
        "[5:00] Lair",
        "[5:30] OrbitalCommand",
        "[7:00] WarpGateResearch",
      ]);
      const adjusted = eventsToStartTime(recorded);
      const byName = new Map(adjusted.map((e) => [e.name, e.time]));
      // Pylon (UnitInitEvent) is already a start time — unchanged.
      expect(byName.get("Pylon")).toBe(83);
      // Stalker trains in 30s — 3:00 finish ⇒ 2:30 start.
      expect(byName.get("Stalker")).toBe(150);
      // Lair morphs in 57s — 5:00 finish ⇒ 4:03 start.
      expect(byName.get("Lair")).toBe(243);
      // Orbital morphs in 25s — 5:30 finish ⇒ 5:05 start.
      expect(byName.get("OrbitalCommand")).toBe(305);
      // WarpGate research takes 100s — 7:00 finish ⇒ 5:20 start.
      expect(byName.get("WarpGateResearch")).toBe(320);
    });

    test("does not mutate the input array", () => {
      const events = parseBuildLogLines(["[5:00] Lair"]);
      const beforeTime = events[0].time;
      const out = eventsToStartTime(events);
      expect(events[0].time).toBe(beforeTime);
      expect(out[0].time).toBe(243);
    });

    test("re-sorts by adjusted time so the timeline reads chronologically", () => {
      // With recorded times these come back as [Cyber 110, Lair 360].
      // After conversion Lair starts at 303, Cyber stays at 110 — but
      // the rule evaluator already saw the recorded order. The display
      // path needs a re-sort so events that started earlier appear
      // earlier in the timeline.
      const recorded = parseBuildLogLines([
        "[6:00] Lair",
        "[1:50] CyberneticsCore",
      ]);
      const adjusted = eventsToStartTime(recorded);
      expect(adjusted.map((e) => e.name)).toEqual([
        "CyberneticsCore",
        "Lair",
      ]);
      // Cyber (UnitInit, already start) at 1:50, Lair (morph) rewound
      // from 6:00 finish to ~5:03 start.
      expect(adjusted[0].time).toBe(110);
      expect(adjusted[1].time).toBe(303);
    });

    test("handles empty / non-array inputs without throwing", () => {
      expect(eventsToStartTime([])).toEqual([]);
      expect(eventsToStartTime(null)).toEqual([]);
      expect(eventsToStartTime(undefined)).toEqual([]);
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

    test("serves events at construction-START time", async () => {
      // The build log carries recorded times (Lair @ finish=5:00, Probe
      // @ finish=0:30). The /v1/games/:id/build-order endpoint applies
      // ``eventsToStartTime`` so the timeline UI shows when the player
      // *issued* each command instead of when sc2reader noticed the
      // unit/morph.
      const svc = buildService({
        gameId: "g1",
        myRace: "Zerg",
        opponent: { race: "T" },
        buildLog: ["[5:00] Lair", "[1:00] SpawningPool"],
        oppBuildLog: ["[3:00] Stalker"],
      });
      const out = await svc.buildOrder("u1", "g1");
      const me = new Map(out.events.map((e) => [e.name, e.time]));
      // SpawningPool is a Zerg structure (already start) — unchanged.
      expect(me.get("SpawningPool")).toBe(60);
      // Lair morphs in 57s — 5:00 finish ⇒ 4:03 start.
      expect(me.get("Lair")).toBe(243);
      // Opp Stalker (Protoss unit, 30s build) — 3:00 finish ⇒ 2:30 start.
      const opp = new Map(out.opp_events.map((e) => [e.name, e.time]));
      expect(opp.get("Stalker")).toBe(150);
    });
  });

  describe("listForRulePreview — save→match coherence", () => {
    // Regression guard: when the user saves a custom build off the
    // start-time timeline, the saved ``time_lt`` is calibrated against
    // start times. ``listForRulePreview`` is the rule evaluator's only
    // event-source, so it must serve start-time events too — otherwise
    // the saved rule would silently match the wrong games.
    function buildSvc(games) {
      const collection = {
        find() {
          return {
            sort() {
              return {
                limit() {
                  return { toArray: () => Promise.resolve(games) };
                },
              };
            },
          };
        },
      };
      return new PerGameComputeService({ games: collection });
    }

    test("returns events at start time so saved rules fire on the right games", async () => {
      const svc = buildSvc([
        {
          gameId: "g1",
          myBuild: null,
          myRace: "Zerg",
          opponent: { race: "T" },
          buildLog: ["[5:00] Lair", "[2:00] Zergling"],
          oppBuildLog: ["[3:00] Stalker"],
          result: "Victory",
          date: new Date("2026-04-01"),
          map: "Goldenaura",
        },
      ]);
      const [g] = await svc.listForRulePreview("u1", { limit: 10 });
      const me = new Map(g.events.map((e) => [e.name, e.time]));
      // Lair: morphs in 57s — finish 5:00 ⇒ start 4:03 (243s).
      expect(me.get("Lair")).toBe(243);
      // Zergling: 17s morph — finish 2:00 ⇒ start 1:43 (103s).
      expect(me.get("Zergling")).toBe(103);
      // Opponent Stalker: 30s build — finish 3:00 ⇒ start 2:30 (150s).
      const opp = new Map(g.oppEvents.map((e) => [e.name, e.time]));
      expect(opp.get("Stalker")).toBe(150);
    });

    test("a rule saved as 'Lair before 4:30 (start)' matches a game that completed Lair at 5:00", async () => {
      const { evaluateRules } = require("../src/services/buildRulesEvaluator");
      const svc = buildSvc([
        {
          gameId: "g1",
          myRace: "Zerg",
          opponent: { race: "T" },
          buildLog: ["[5:00] Lair"],
          oppBuildLog: [],
          date: new Date("2026-04-01"),
        },
      ]);
      const [g] = await svc.listForRulePreview("u1", { limit: 10 });
      // Saved-from-timeline rule: "Lair started before 4:30".
      // The user reads "4:03 Lair" off the start-time timeline and
      // commits a 4:30 threshold. The evaluator must agree.
      const rule = { type: "before", name: "BuildLair", time_lt: 270 };
      const result = evaluateRules([rule], g.events);
      expect(result.pass).toBe(true);

      // And tighter than the morph-start time fails — no spurious match.
      const tight = { type: "before", name: "BuildLair", time_lt: 240 };
      expect(evaluateRules([tight], g.events).pass).toBe(false);
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

    test("force=true also emits the dedicated resync:request event", async () => {
      // Map Intel's "Request resync" path. Per-game `macro:recompute_request`
      // alone misses agents whose path_by_game_id index is empty (older
      // state files), so the API piggy-backs a dedicated full-resync
      // event whenever the caller passes force: true. Targeted recomputes
      // (force omitted / false) deliberately don't fire it.
      const docs = [{ gameId: "g1" }, { gameId: "g2" }];
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
        async insertOne() {
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
      await svc.start("user-1", {
        force: true,
        reason: "map_intel_request_resync",
      });
      const events = emitted.map((e) => e.event);
      expect(events).toContain("macro:recompute_request");
      expect(events).toContain("resync:request");
      const resyncEvt = emitted.find((e) => e.event === "resync:request");
      expect(resyncEvt.room).toBe("user:user-1");
      expect(resyncEvt.payload.reason).toBe("map_intel_request_resync");
      expect(typeof resyncEvt.payload.jobId).toBe("string");
    });

    test("targeted recompute (force=false) does NOT emit resync:request", async () => {
      const docs = [{ gameId: "g1" }];
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
        async insertOne() {
          return { insertedId: "abc123" };
        },
      };
      const emitted = [];
      const io = {
        to: () => ({
          emit: (event, payload) => emitted.push({ event, payload }),
        }),
      };
      const svc = new MacroBackfillService({ games, macroJobs }, { io });
      await svc.start("user-1");
      const events = emitted.map((e) => e.event);
      expect(events).toContain("macro:recompute_request");
      expect(events).not.toContain("resync:request");
    });
  });
});
