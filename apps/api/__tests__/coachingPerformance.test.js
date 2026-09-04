// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { buildCoachingRouter } = require("../src/routes/coaching");
const { AggregationsService } = require("../src/services/aggregations");
const { CoachingService } = require("../src/services/coaching");

describe("CoachingService.performanceRecord", () => {
  test("uses one ranked-filtered slim-game facet and groups exact race matchups", async () => {
    const toArray = jest.fn().mockResolvedValue([{
      summary: [{ games: 10, wins: 6, losses: 4 }],
      matchups: [
        { _id: { myRace: "Z", opponentRace: "P" }, games: 3, wins: 2, losses: 1 },
        { _id: { myRace: "P", opponentRace: "T" }, games: 6, wins: 3, losses: 3 },
      ],
    }]);
    const aggregate = jest.fn(() => ({ toArray }));
    const service = new CoachingService({ db: { games: { aggregate } } });
    const since = new Date("2026-08-01T04:00:00.000Z");
    const until = new Date("2026-08-24T03:59:59.999Z");

    await expect(service.performanceRecord("student-user", {
      since,
      until,
      mapPool: "ladder",
      gameSize: "1v1",
    })).resolves.toEqual({
      summary: {
        games: 10,
        wins: 6,
        losses: 4,
        winRate: 0.6,
        classifiedGames: 9,
        unclassifiedGames: 1,
      },
      matchups: [
        {
          matchup: "PvT",
          myRace: "P",
          opponentRace: "T",
          games: 6,
          wins: 3,
          losses: 3,
          winRate: 0.5,
        },
        {
          matchup: "ZvP",
          myRace: "Z",
          opponentRace: "P",
          games: 3,
          wins: 2,
          losses: 1,
          winRate: 2 / 3,
        },
      ],
    });

    const pipeline = aggregate.mock.calls[0][0];
    expect(pipeline[0].$match).toMatchObject({
      userId: "student-user",
      isResumedFromReplay: { $ne: true },
      date: { $gte: since, $lte: until },
    });
    expect(pipeline[0].$match.$and).toEqual(expect.arrayContaining([
      { isLadderGame: true },
      {
        $or: [
          { matchFormat: "1v1" },
          { matchFormat: { $exists: false }, playerCount: 2 },
        ],
      },
    ]));
    expect(pipeline[2].$facet.summary[0]).toEqual({
      $match: { _coachingResult: { $in: ["win", "loss"] } },
    });
    expect(pipeline[2].$facet.matchups[0].$match).toMatchObject({
      _coachingResult: { $in: ["win", "loss"] },
      _coachingMyRace: { $in: ["P", "T", "Z"] },
      _coachingOpponentRace: { $in: ["P", "T", "Z"] },
    });
    expect(toArray).toHaveBeenCalledTimes(1);
  });
});

describe("AggregationsService.netMmrByMatchup exact matchup mode", () => {
  test("groups all exact matchups inside one canonical history window and facet", async () => {
    let pipeline;
    const games = {
      aggregate(value) {
        pipeline = value;
        return {
          toArray: async () => [{
            summary: [{ totalGames: 8, eligibleGames: 7, terminalGame: 1 }],
            coverage: [{
              _id: "Z",
              totalGames: 8,
              eligibleGames: 7,
              measuredGames: 6,
              terminalGame: 1,
            }],
            keptPairs: [
              {
                _id: { myRace: "P", opponentRace: "Z" },
                netMmr: 31.6,
                avgDelta: 10.53,
                pairs: 3,
                wins: 2,
                losses: 1,
              },
              {
                _id: { myRace: "T", opponentRace: "Z" },
                netMmr: -20.2,
                avgDelta: -6.73,
                pairs: 3,
                wins: 1,
                losses: 2,
              },
            ],
          }],
        };
      },
    };
    const service = new AggregationsService({ games });

    const result = await service.netMmrByMatchup("student-user", {}, {
      tz: "America/New_York",
      groupByOwnRace: true,
    });

    expect(result.matchups).toEqual([
      {
        matchup: "PvZ",
        myRace: "P",
        opponentRace: "Z",
        netMmr: 32,
        avgDelta: 10.5,
        pairs: 3,
        games: 3,
        wins: 2,
        losses: 1,
        winRate: 2 / 3,
      },
      {
        matchup: "TvZ",
        myRace: "T",
        opponentRace: "Z",
        netMmr: -20,
        avgDelta: -6.7,
        pairs: 3,
        games: 3,
        wins: 1,
        losses: 2,
        winRate: 1 / 3,
      },
    ]);
    expect(pipeline.filter((stage) => stage.$setWindowFields)).toHaveLength(1);
    expect(pipeline.filter((stage) => stage.$facet)).toHaveLength(1);
    const facet = pipeline.find((stage) => stage.$facet).$facet;
    expect(facet.keptPairs[0]).toEqual({
      $match: {
        _dropReason: null,
        _myPlayedRace: { $in: ["P", "T", "Z"] },
        _oppRace: { $in: ["P", "T", "Z"] },
      },
    });
    expect(facet.keptPairs[1].$group._id).toEqual({
      myRace: "$_myPlayedRace",
      opponentRace: "$_oppRace",
    });
    expect(facet).toHaveProperty("summary");
    expect(facet).toHaveProperty("coverage");
    expect(facet).toHaveProperty("dailyTotals");
  });
});

describe("GET /v1/coaching/students/:studentId/performance", () => {
  test("resolves an assigned student server-side, forces ranked 1v1, and strips account identifiers", async () => {
    const harness = performanceHarness({
      auth: { userId: "coach-user", clerkUserId: "clerk-coach", source: "clerk" },
      role: { role: "coach", coachId: "coach-1" },
    });

    const response = await request(harness.app)
      .get("/v1/coaching/students/student-1/performance")
      .query({
        since: "2026-08-01T04:00:00.000Z",
        until: "2026-08-24T03:59:59.999Z",
        interval: "week",
        tz: "America/New_York",
        race: "P",
        map_pool: "nonladder",
        game_size: "team",
      });

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.body).toMatchObject({
      student: {
        id: "student-1",
        name: "Student One",
        coach: { id: "coach-1", name: "Coach One" },
      },
      scope: {
        since: "2026-08-01T04:00:00.000Z",
        until: "2026-08-24T03:59:59.999Z",
        interval: "week",
        tz: "America/New_York",
      },
      summary: {
        games: 4,
        wins: 3,
        losses: 1,
        winRate: 0.75,
        classifiedGames: 3,
        unclassifiedGames: 1,
      },
      matchups: [
        {
          matchup: "PvT",
          netMmr: -20,
          measuredGames: 2,
          avgDelta: -10,
        },
        {
          matchup: "PvZ",
          netMmr: null,
          measuredGames: 0,
          avgDelta: null,
        },
      ],
      mmr: {
        interval: "week",
        seriesMeta: { total: 2, returned: 2, truncated: false, limit: 12 },
        series: [
          { label: "NA · Protoss 1", region: "NA", ladderRace: "P" },
          { label: "NA · Protoss 2", region: "NA", ladderRace: "P" },
        ],
      },
      dailySwings: {
        timezone: "America/New_York",
        measuredDays: 1,
        measuredGames: 2,
      },
      coverage: {
        totalGames: 3,
        eligibleGames: 2,
        measuredGames: 2,
      },
    });
    expect(response.body.matchups).toHaveLength(2);

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("target-internal-user");
    expect(serialized).not.toContain("1-S2-1-private");
    expect(serialized).not.toContain("private-series-key");
    expect(serialized).not.toContain("NA 123456");
    expect(serialized).not.toContain("accounts");
    expect(serialized).not.toContain("toonHandle");
    expect(serialized).not.toContain("seriesKey");
    expect(serialized).not.toContain("summary-private-poison");
    expect(serialized).not.toContain("matchup-private-poison");
    expect(serialized).not.toContain("random-private-poison");

    expect(harness.coaching.performanceRecord).toHaveBeenCalledWith(
      "target-internal-user",
      expect.objectContaining({
        since: expect.any(Date),
        until: expect.any(Date),
        race: "P",
        mapPool: "ladder",
        gameSize: "1v1",
      }),
    );
    expect(harness.aggregations.mmrProgression).toHaveBeenCalledWith(
      "target-internal-user",
      { interval: "week", tz: "America/New_York" },
      expect.objectContaining({ mapPool: "ladder", gameSize: "1v1" }),
    );
    expect(harness.aggregations.netMmrByMatchup).toHaveBeenCalledTimes(1);
    expect(harness.aggregations.netMmrByMatchup).toHaveBeenCalledWith(
      "target-internal-user",
      expect.objectContaining({ race: "P", mapPool: "ladder", gameSize: "1v1" }),
      { tz: "America/New_York", groupByOwnRace: true },
    );
  });

  test("denies an attached coach before approval and immediately after revocation", async () => {
    for (const sharingStatus of ["pending", "revoked"]) {
      const harness = performanceHarness({
        auth: { userId: "coach-user", clerkUserId: "clerk-coach", source: "clerk" },
        role: { role: "coach", coachId: "coach-1" },
        sharingStatus,
      });

      const response = await request(harness.app)
        .get("/v1/coaching/students/student-1/performance");

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "not_found" });
      expect(harness.coaching.performanceRecord).not.toHaveBeenCalled();
      expect(harness.aggregations.mmrProgression).not.toHaveBeenCalled();
      expect(harness.aggregations.netMmrByMatchup).not.toHaveBeenCalled();
    }
  });

  test("caps account-derived MMR series and uses one net-MMR scan without a race filter", async () => {
    const harness = performanceHarness({
      auth: { userId: "coach-user", clerkUserId: "clerk-coach", source: "clerk" },
      role: { role: "coach", coachId: "coach-1" },
      seriesCount: 14,
    });
    const response = await request(harness.app)
      .get("/v1/coaching/students/student-1/performance?tz=UTC");

    expect(response.status).toBe(200);
    expect(response.body.mmr.series).toHaveLength(12);
    expect(response.body.mmr.seriesMeta).toEqual({
      total: 14,
      returned: 12,
      truncated: true,
      limit: 12,
    });
    expect(JSON.stringify(response.body)).not.toContain("private-13");
    expect(harness.aggregations.netMmrByMatchup).toHaveBeenCalledTimes(1);
    expect(harness.aggregations.netMmrByMatchup).toHaveBeenCalledWith(
      "target-internal-user",
      expect.not.objectContaining({ race: expect.anything() }),
      { tz: "UTC", groupByOwnRace: true },
    );
  });

  test.each([
    [
      "an admin",
      { userId: "admin-user", clerkUserId: "clerk-admin", source: "clerk" },
      { role: "admin" },
    ],
    [
      "the exact linked student",
      { userId: "target-internal-user", clerkUserId: "clerk-student", source: "clerk" },
      { role: "student", studentId: "student-1" },
    ],
  ])("allows %s", async (_label, auth, role) => {
    const harness = performanceHarness({ auth, role });
    const response = await request(harness.app)
      .get("/v1/coaching/students/student-1/performance?race=P");
    expect(response.status).toBe(200);
    expect(harness.coaching.performanceRecord).toHaveBeenCalledWith(
      "target-internal-user",
      expect.any(Object),
    );
  });

  test.each([
    [
      "device credentials",
      { userId: "target-internal-user", source: "device" },
      { role: "student", studentId: "student-1" },
      "student-1",
    ],
    [
      "an unassigned coach",
      { userId: "other-coach", clerkUserId: "clerk-other", source: "clerk" },
      { role: "coach", coachId: "coach-2" },
      "student-1",
    ],
    [
      "a different student linkage",
      { userId: "target-internal-user", clerkUserId: "clerk-student", source: "clerk" },
      { role: "student", studentId: "student-2" },
      "student-1",
    ],
    [
      "an internal user id used as the route key",
      { userId: "coach-user", clerkUserId: "clerk-coach", source: "clerk" },
      { role: "coach", coachId: "coach-1" },
      "target-internal-user",
    ],
  ])("returns a privacy-safe 404 for %s", async (_label, auth, role, routeId) => {
    const harness = performanceHarness({ auth, role });
    const response = await request(harness.app)
      .get(`/v1/coaching/students/${routeId}/performance`);
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "not_found" });
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(harness.coaching.performanceRecord).not.toHaveBeenCalled();
    expect(harness.aggregations.mmrProgression).not.toHaveBeenCalled();
    expect(harness.aggregations.netMmrByMatchup).not.toHaveBeenCalled();
  });
});

function performanceHarness({ auth, role, seriesCount = 2, sharingStatus = "accepted" }) {
  const roster = {
    coaches: [
      { id: "coach-1", name: "Coach One", userId: "coach-user" },
      { id: "coach-2", name: "Coach Two", userId: "other-coach" },
    ],
    students: [
      {
        id: "student-1",
        name: "Student One",
        userId: "target-internal-user",
        coachId: "coach-1",
      },
    ],
  };
  const coaching = {
    roleFor: jest.fn(async () => role),
    getRoster: jest.fn(async () => roster),
    practiceSharingFor: jest.fn(async () => ({
      rev: 1,
      relationships: role.role === "coach"
        && role.coachId === "coach-1"
        && auth.userId === "coach-user"
        ? [{ student: { id: "student-1", name: "Student One" }, status: sharingStatus }]
        : [],
    })),
    performanceRecord: jest.fn(async () => ({
      summary: {
        games: 999,
        wins: 3,
        losses: 1,
        winRate: 99,
        toonHandle: "summary-private-poison",
      },
      matchups: [
        {
          matchup: "PvT",
          myRace: "P",
          opponentRace: "T",
          games: 2,
          wins: 1,
          losses: 1,
          winRate: 0.5,
          accounts: ["matchup-private-poison"],
        },
        {
          matchup: "PvZ",
          myRace: "P",
          opponentRace: "Z",
          games: 1,
          wins: 1,
          losses: 0,
          winRate: 1,
          toonHandle: "matchup-private-poison",
        },
        {
          matchup: "RvZ",
          myRace: "Random",
          opponentRace: "Zerg",
          games: 99,
          wins: 99,
          losses: 0,
          toonHandle: "random-private-poison",
        },
      ],
    })),
  };
  const rawSeries = (suffix) => ({
    seriesKey: `private-series-key-${suffix}`,
    toonHandle: `1-S2-1-private-${suffix}`,
    label: `NA 123456 · Protoss ${suffix}`,
    region: "NA",
    ladderRace: "P",
    points: [{
      bucket: new Date("2026-08-20T04:00:00.000Z"),
      openMmr: 4000,
      closeMmr: 4010,
      minMmr: 3995,
      maxMmr: 4010,
      wins: 1,
      losses: 0,
      total: 1,
      toonHandle: "point-private-handle",
    }],
    peak: { bucket: new Date("2026-08-20T04:00:00.000Z"), mmr: 4010 },
    trough: { bucket: new Date("2026-08-20T04:00:00.000Z"), mmr: 3995 },
    latest: { bucket: new Date("2026-08-20T04:00:00.000Z"), mmr: 4010 },
  });
  const rawMmr = {
    interval: "week",
    series: Array.from({ length: seriesCount }, (_value, index) =>
      rawSeries(String(index))),
    accounts: [{ toonHandle: "accounts-private-handle" }],
    peak: null,
    trough: null,
    latest: null,
    coverage: { filteredGames: 3, eligibleGames: 2, toonHandle: "coverage-private" },
  };
  const rawNet = {
    matchups: [{
      matchup: "PvT",
      myRace: "P",
      opponentRace: "T",
      netMmr: -20,
      avgDelta: -10,
      pairs: 2,
      toonHandle: "net-private-poison",
    }, {
      matchup: "RvZ",
      myRace: "Random",
      opponentRace: "Zerg",
      netMmr: 999,
      avgDelta: 999,
      pairs: 99,
      toonHandle: "random-private-poison",
    }],
    totalGames: 3,
    eligibleGames: 2,
    dropped: { terminalGame: 1, toonHandle: "dropped-private" },
    coverage: [{
      race: "T",
      totalGames: 3,
      eligibleGames: 2,
      measuredGames: 2,
      dropped: { terminalGame: 1 },
    }],
    dailySwings: {
      timezone: "America/New_York",
      bestGain: {
        day: new Date("2026-08-20T04:00:00.000Z"),
        netMmr: 20,
        measuredGames: 2,
        wins: 2,
        losses: 0,
        toonHandle: "daily-private",
      },
      biggestLoss: null,
      measuredDays: 1,
      measuredGames: 2,
      regions: [],
    },
  };
  const aggregations = {
    mmrProgression: jest.fn(async () => rawMmr),
    netMmrByMatchup: jest.fn(async () => rawNet),
  };
  const router = buildCoachingRouter({
    auth: (req, _res, next) => {
      req.auth = auth;
      next();
    },
    isAdmin: () => role.role === "admin",
    coaching,
    aggregations,
    users: { getSummary: jest.fn() },
  });
  const app = express();
  app.use(express.json());
  app.use("/v1", router);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.code || err.message });
  });
  return { app, coaching, aggregations };
}
