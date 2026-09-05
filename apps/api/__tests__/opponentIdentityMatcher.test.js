// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const {
  OpponentIdentityMatcherService,
  identityEligibility,
  milestoneSequenceSimilarity,
  scoreCandidate,
} = require("../src/services/opponentIdentityMatcher");

describe("OpponentIdentityMatcherService", () => {
  let mongo;
  let db;
  let matcher;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "identity_matcher_test" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await Promise.all([
      db.opponents.deleteMany({}),
      db.games.deleteMany({}),
    ]);
    matcher = new OpponentIdentityMatcherService(db, {
      now: () => new Date("2026-09-01T12:00:00.000Z"),
    });
  });

  test("returns null when the requested opponent is not owned by the caller", async () => {
    await insertOpponent(db, {
      userId: "other-user",
      pulseId: "target",
      displayNameSample: "IIIIIIII",
      race: "Protoss",
    });

    await expect(matcher.findCandidates("owner", "target")).resolves.toBeNull();
  });

  test("keeps the search private, same-race, and explainable", async () => {
    await insertOpponent(db, {
      userId: "owner",
      pulseId: "target",
      pulseCharacterId: "340886346",
      displayNameSample: "IIIIIIII",
      race: "Protoss",
      mmr: 5391,
    });
    await insertGame(db, {
      userId: "owner",
      gameId: "target-game",
      pulseId: "target",
      pulseCharacterId: "340886346",
      opponentRace: "Protoss",
      signature: playSignature({ slot: 2 }),
    });

    await insertOpponent(db, {
      userId: "owner",
      pulseId: "alpha",
      pulseCharacterId: "101",
      displayNameSample: "Alpha",
      race: "Protoss",
      mmr: 4700,
    });
    await insertGame(db, {
      userId: "owner",
      gameId: "alpha-game",
      pulseId: "alpha",
      pulseCharacterId: "101",
      opponentRace: "Protoss",
      signature: playSignature({ slot: 2 }),
    });

    // A perfect behavioral match of the wrong race is not a candidate.
    await insertOpponent(db, {
      userId: "owner",
      pulseId: "terran",
      displayNameSample: "TerranKnown",
      race: "Terran",
    });
    await insertGame(db, {
      userId: "owner",
      gameId: "terran-game",
      pulseId: "terran",
      opponentRace: "Terran",
      signature: playSignature({ slot: 2 }),
    });

    // A same-race match in another account's private history must never leak.
    await insertOpponent(db, {
      userId: "other-user",
      pulseId: "foreign",
      displayNameSample: "ForeignKnown",
      race: "Protoss",
    });
    await insertGame(db, {
      userId: "other-user",
      gameId: "foreign-game",
      pulseId: "foreign",
      opponentRace: "Protoss",
      signature: playSignature({ slot: 2 }),
    });

    const result = await matcher.findCandidates("owner", "target");

    expect(result).toMatchObject({
      status: "ready",
      calibrated: false,
      generatedAt: "2026-09-01T12:00:00.000Z",
      eligibility: {
        eligible: true,
        isBarcode: true,
        pulseResolved: true,
        mmrPresent: true,
        reasons: [],
      },
      target: {
        pulseId: "target",
        race: "Protoss",
        raceCode: "P",
        buildGames: 1,
        controlGroupGames: 1,
        evidenceMode: "build_and_control_groups",
      },
      scope: {
        source: "your_replay_history",
        searchedOpponents: 1,
      },
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      rank: 1,
      pulseId: "alpha",
      pulseCharacterId: "101",
      name: "Alpha",
      race: "Protoss",
      mmr: 4700,
      patternMatch: 1,
      confidence: "low",
      sample: {
        targetEvidenceGames: 1,
        candidateEvidenceGames: 1,
      },
    });
    expect(result.candidates[0].evidence.buildOrders.score).toBe(1);
    expect(result.candidates[0].evidence.controlGroups.score).toBe(1);
    expect(result.candidates[0].likelihood).toBeGreaterThan(0);
    expect(result.unknownLikelihood).toBeGreaterThan(0);
    expect(
      result.candidates[0].likelihood
        + result.otherLikelihood
        + result.unknownLikelihood,
    ).toBeCloseTo(1, 3);
    expect(result.otherLikelihood).toBe(0);
    if (result.otherCandidatesLikelihood !== undefined) {
      expect(result.otherCandidatesLikelihood).toBe(result.otherLikelihood);
    }
    expect(result.candidates.map((row) => row.name)).not.toContain("ForeignKnown");
    expect(result.candidates.map((row) => row.name)).not.toContain("TerranKnown");
  });

  test("uses the latest replay race and excludes other-race target evidence", async () => {
    // The aggregate row can be stale after a Random/race-switching account.
    // Replay evidence is authoritative for the race being matched.
    await insertOpponent(db, {
      userId: "owner",
      pulseId: "target",
      displayNameSample: "IIIIIIII",
      race: "Zerg",
    });
    await insertGame(db, {
      userId: "owner",
      gameId: "target-latest-protoss",
      pulseId: "target",
      opponentRace: "Protoss",
      date: new Date("2026-08-31T12:00:00Z"),
      signature: playSignature({ slot: 2 }),
      strategy: "PvT - Gateway Expand",
    });
    await insertGame(db, {
      userId: "owner",
      gameId: "target-old-zerg",
      pulseId: "target",
      opponentRace: "Zerg",
      date: new Date("2026-07-01T12:00:00Z"),
      signature: playSignature({ slot: 8 }),
      strategy: "ZvT - Ling Flood",
    });

    // This account's aggregate race is also stale, but it has comparable
    // Protoss replay evidence and therefore remains a valid candidate.
    await insertOpponent(db, {
      userId: "owner",
      pulseId: "race-switcher",
      displayNameSample: "RaceSwitcher",
      race: "Terran",
      mmr: 5100,
    });
    await insertGame(db, {
      userId: "owner",
      gameId: "switcher-protoss",
      pulseId: "race-switcher",
      opponentRace: "Protoss",
      opponentMmr: 4321,
      signature: playSignature({ slot: 2 }),
      strategy: "PvT - Gateway Expand",
    });

    // A Zerg-only profile matches the stale aggregate/old target replay but
    // must not enter a Protoss identity comparison.
    await insertOpponent(db, {
      userId: "owner",
      pulseId: "zerg-only",
      displayNameSample: "ZergOnly",
      race: "Zerg",
    });
    await insertGame(db, {
      userId: "owner",
      gameId: "zerg-only-game",
      pulseId: "zerg-only",
      opponentRace: "Zerg",
      signature: playSignature({ slot: 8 }),
      strategy: "ZvT - Ling Flood",
    });

    const result = await matcher.findCandidates("owner", "target");

    expect(result.status).toBe("ready");
    expect(result.target).toMatchObject({
      race: "Protoss",
      raceCode: "P",
      games: 1,
      buildGames: 1,
      controlGroupGames: 1,
    });
    expect(result.candidates.map((row) => row.name)).toEqual(["RaceSwitcher"]);
    expect(result.candidates[0].race).toBe("Protoss");
    expect(result.candidates[0].mmr).toBe(4321);
  });

  test("explains why a barcode target has no replay evidence", async () => {
    await insertOpponent(db, {
      userId: "owner",
      pulseId: "target",
      displayNameSample: "llll1111",
      race: "Zerg",
    });
    await insertGame(db, {
      userId: "owner",
      gameId: "target-empty",
      pulseId: "target",
      opponentRace: "Zerg",
      signature: null,
      strategy: null,
      opening: null,
    });

    const result = await matcher.findCandidates("owner", "target");

    expect(result).toMatchObject({
      status: "insufficient_data",
      target: {
        games: 1,
        buildGames: 0,
        controlGroupGames: 0,
        evidenceMode: "none",
      },
      insufficiency: {
        code: "target_signature_missing",
      },
      candidates: [],
      unknownLikelihood: 1,
      otherLikelihood: 0,
    });
  });

  test("does not mistake classifier placeholders for build-order evidence", async () => {
    await insertOpponent(db, {
      userId: "owner",
      pulseId: "target",
      displayNameSample: "IIII1111",
      race: "Protoss",
    });
    await insertGame(db, {
      userId: "owner",
      gameId: "target-too-short",
      pulseId: "target",
      opponentRace: "Protoss",
      signature: null,
      strategy: "PvT - Game Too Short",
      opening: "Unclassified",
    });

    const result = await matcher.findCandidates("owner", "target");

    expect(result).toMatchObject({
      status: "insufficient_data",
      target: {
        buildGames: 0,
        controlGroupGames: 0,
      },
      insufficiency: {
        code: "target_signature_missing",
      },
      unknownLikelihood: 1,
      otherLikelihood: 0,
    });
  });

  test("supports legacy build-only evidence without overstating confidence", async () => {
    await insertOpponent(db, {
      userId: "owner",
      pulseId: "target",
      displayNameSample: "IIII1111",
      race: "Terran",
    });
    await insertGame(db, {
      userId: "owner",
      gameId: "target-legacy",
      pulseId: "target",
      opponentRace: "Terran",
      signature: null,
      strategy: "TvP - 2-1-1",
      opening: "Reaper Expand",
    });
    await insertOpponent(db, {
      userId: "owner",
      pulseId: "known",
      displayNameSample: "KnownTerran",
      race: "Terran",
    });
    await insertGame(db, {
      userId: "owner",
      gameId: "known-legacy",
      pulseId: "known",
      opponentRace: "Terran",
      signature: null,
      strategy: "TvP - 2-1-1",
      opening: "Reaper Expand",
    });

    const result = await matcher.findCandidates("owner", "target");

    expect(result.status).toBe("ready");
    expect(result.target.evidenceMode).toBe("build_only");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      name: "KnownTerran",
      patternMatch: 0.55,
      confidence: "low",
      evidence: {
        controlGroups: null,
        coverage: 0.20,
      },
    });
    expect(result.candidates[0].caveats).toContain(
      "build_only_reprocess_for_control_groups",
    );
  });

  test("does not call one control-group replay high-confidence beside deep build evidence", async () => {
    await insertOpponent(db, {
      userId: "owner",
      pulseId: "target",
      displayNameSample: "IIII1111",
      race: "Terran",
      gameCount: 5,
    });
    await insertOpponent(db, {
      userId: "owner",
      pulseId: "known",
      displayNameSample: "KnownTerran",
      race: "Terran",
      gameCount: 5,
    });

    for (let index = 0; index < 5; index += 1) {
      await insertGame(db, {
        userId: "owner",
        gameId: `target-${index}`,
        pulseId: "target",
        opponentRace: "Terran",
        signature: index === 0 ? playSignature({ slot: 3 }) : null,
        strategy: "TvP - 2-1-1",
        opening: "Reaper Expand",
        date: new Date(`2026-08-${String(20 + index).padStart(2, "0")}T00:00:00Z`),
      });
      await insertGame(db, {
        userId: "owner",
        gameId: `known-${index}`,
        pulseId: "known",
        opponentRace: "Terran",
        signature: index === 0 ? playSignature({ slot: 3 }) : null,
        strategy: "TvP - 2-1-1",
        opening: "Reaper Expand",
        date: new Date(`2026-08-${String(20 + index).padStart(2, "0")}T01:00:00Z`),
      });
    }

    const result = await matcher.findCandidates("owner", "target");

    expect(result.status).toBe("ready");
    expect(result.target).toMatchObject({ buildGames: 5, controlGroupGames: 1 });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].evidence.buildOrders).toMatchObject({
      targetSamples: 5,
      candidateSamples: 5,
    });
    expect(result.candidates[0].evidence.controlGroups).toMatchObject({
      targetSamples: 1,
      candidateSamples: 1,
    });
    expect(result.candidates[0].confidence).not.toBe("high");
    expect(result.candidates[0].evidenceQuality).toBeLessThan(0.8);
  });

  test("collapses multiple local toon rows with the same Pulse character id", async () => {
    await insertOpponent(db, {
      userId: "owner",
      pulseId: "target",
      displayNameSample: "||||1111",
      race: "Zerg",
    });
    await insertGame(db, {
      userId: "owner",
      gameId: "target-game",
      pulseId: "target",
      opponentRace: "Zerg",
      signature: playSignature({ slot: 4 }),
    });

    await insertOpponent(db, {
      userId: "owner",
      pulseId: "old-toon",
      pulseCharacterId: "777",
      displayNameSample: "OldName",
      race: "Zerg",
      lastSeen: new Date("2026-01-01T00:00:00Z"),
    });
    await insertOpponent(db, {
      userId: "owner",
      pulseId: "new-toon",
      pulseCharacterId: "777",
      displayNameSample: "CurrentName",
      race: "Zerg",
      lastSeen: new Date("2026-08-01T00:00:00Z"),
    });
    await insertGame(db, {
      userId: "owner",
      gameId: "old-toon-game",
      pulseId: "old-toon",
      pulseCharacterId: "777",
      opponentRace: "Zerg",
      signature: playSignature({ slot: 4 }),
    });
    await insertGame(db, {
      userId: "owner",
      gameId: "new-toon-game",
      pulseId: "new-toon",
      pulseCharacterId: "777",
      opponentRace: "Zerg",
      signature: playSignature({ slot: 4 }),
    });

    const result = await matcher.findCandidates("owner", "target");

    expect(result.status).toBe("ready");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      pulseId: "new-toon",
      pulseCharacterId: "777",
      name: "CurrentName",
      sample: {
        candidateGames: 2,
        candidateEvidenceGames: 2,
      },
    });
  });

  test("collapses Pulse-linked aliases and excludes the target's linked identity", async () => {
    await insertOpponent(db, {
      userId: "owner",
      pulseId: "target",
      pulseCharacterId: "100",
      displayNameSample: "IIIIIIII",
      race: "Protoss",
    });
    await insertGame(db, {
      userId: "owner",
      gameId: "target-game",
      pulseId: "target",
      pulseCharacterId: "100",
      opponentRace: "Protoss",
      signature: playSignature({ slot: 5 }),
    });

    // Same linked human as the target: must be excluded, even though the
    // character id and toon handle differ.
    await insertOpponent(db, {
      userId: "owner",
      pulseId: "target-alias",
      pulseCharacterId: "101",
      displayNameSample: "TargetAlias",
      race: "Protoss",
    });
    await insertGame(db, {
      userId: "owner",
      gameId: "target-alias-game",
      pulseId: "target-alias",
      pulseCharacterId: "101",
      opponentRace: "Protoss",
      signature: playSignature({ slot: 5 }),
    });

    // Two characters SC2Pulse links to a different pro become one candidate.
    for (const [index, pulseCharacterId] of ["202", "203"].entries()) {
      await insertOpponent(db, {
        userId: "owner",
        pulseId: `known-${index}`,
        pulseCharacterId,
        displayNameSample: `KnownAlias${index}`,
        race: "Protoss",
        gameCount: index + 2,
        lastSeen: new Date(`2026-08-${20 + index}T00:00:00Z`),
      });
      await insertGame(db, {
        userId: "owner",
        gameId: `known-${index}-game`,
        pulseId: `known-${index}`,
        pulseCharacterId,
        opponentRace: "Protoss",
        signature: playSignature({ slot: 5 }),
      });
    }

    const pulseLinks = {
      getLinks: jest.fn(async () => ({
        links: new Map([
          ["100", { accountId: "acct-target", proId: "pro-target" }],
          ["101", { accountId: "acct-target", proId: "pro-target" }],
          ["202", { accountId: "acct-known-a", proId: "pro-known" }],
          ["203", { accountId: "acct-known-b", proId: "pro-known" }],
        ]),
        partial: false,
      })),
    };
    const linkedMatcher = new OpponentIdentityMatcherService(db, {
      pulseLinks,
    });

    const result = await linkedMatcher.findCandidates("owner", "target");

    expect(pulseLinks.getLinks).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("ready");
    expect(result.scope.searchedOpponents).toBe(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      name: "KnownAlias1",
      pulseCharacterId: "203",
      gamesInProfile: 5,
      sample: {
        candidateGames: 2,
        candidateEvidenceGames: 2,
      },
    });
    expect(result.candidates.map((row) => row.name)).not.toContain("TargetAlias");
  });

  test("hard-caps the visible ranking at five while preserving hidden mass", async () => {
    await insertOpponent(db, {
      userId: "owner",
      pulseId: "target",
      displayNameSample: "IIIIIIII",
      race: "Protoss",
    });
    await insertGame(db, {
      userId: "owner",
      gameId: "target-game",
      pulseId: "target",
      opponentRace: "Protoss",
      signature: playSignature({ slot: 1 }),
    });

    for (let index = 0; index < 6; index += 1) {
      const suffix = String.fromCharCode("A".charCodeAt(0) + index);
      const pulseId = `candidate-${suffix}`;
      await insertOpponent(db, {
        userId: "owner",
        pulseId,
        pulseCharacterId: String(200 + index),
        displayNameSample: `Player${suffix}`,
        race: "Protoss",
      });
      await insertGame(db, {
        userId: "owner",
        gameId: `game-${suffix}`,
        pulseId,
        pulseCharacterId: String(200 + index),
        opponentRace: "Protoss",
        signature: playSignature({ slot: 1 }),
      });
    }

    const result = await matcher.findCandidates("owner", "target", {
      limit: 999,
    });

    expect(result.status).toBe("ready");
    expect(result.scope.searchedOpponents).toBe(6);
    expect(result.candidates).toHaveLength(5);
    expect(result.candidates.map((row) => row.name)).toEqual([
      "PlayerA",
      "PlayerB",
      "PlayerC",
      "PlayerD",
      "PlayerE",
    ]);
    const visibleLikelihood = result.candidates.reduce(
      (sum, row) => sum + row.likelihood,
      0,
    );
    expect(result.otherLikelihood).toBeGreaterThan(0);
    expect(result.unknownLikelihood).toBeGreaterThan(0);
    expect(
      visibleLikelihood
        + result.otherLikelihood
        + result.unknownLikelihood,
    ).toBeCloseTo(1, 3);
    if (result.otherCandidatesLikelihood !== undefined) {
      expect(result.otherCandidatesLikelihood).toBe(result.otherLikelihood);
    }
  });

  test("restricts the candidate-game Mongo query to selected identities", async () => {
    const opponents = {
      findOne: jest.fn(async () => ({
        pulseId: "target",
        displayNameSample: "IIIIIIII",
        race: "Protoss",
      })),
      find: jest.fn(() => mockCursor([{
        pulseId: "known",
        pulseCharacterId: "909",
        displayNameSample: "KnownPlayer",
        race: "Protoss",
        lastSeen: new Date("2026-08-31T00:00:00Z"),
      }])),
    };
    const games = {
      find: jest.fn()
        .mockImplementationOnce(() => mockCursor([matchGame({
          gameId: "target-game",
          pulseId: "target",
        })]))
        .mockImplementationOnce(() => mockCursor([matchGame({
          gameId: "candidate-game",
          pulseId: "known",
          pulseCharacterId: "909",
        })])),
    };
    const service = new OpponentIdentityMatcherService({ opponents, games });

    const result = await service.findCandidates("owner", "target");

    expect(result.status).toBe("ready");
    expect(games.find).toHaveBeenCalledTimes(2);
    const candidateFilter = games.find.mock.calls[1][0];
    const serialized = JSON.stringify(candidateFilter);
    expect(serialized).toContain("opponent.pulseId");
    expect(serialized).toContain("opponent.pulseCharacterId");
    expect(serialized).toContain("known");
    expect(serialized).toContain("909");
    expect(serialized).not.toContain('"target"');
  });
});

describe("opponent identity matcher primitives", () => {
  test("does not block identity results on a slow live Pulse linkage lookup", async () => {
    const getLinks = jest.fn(() => new Promise(() => {}));
    const service = new OpponentIdentityMatcherService(
      { opponents: {}, games: {} },
      { pulseLinks: { getLinks }, pulseLinkDeadlineMs: 25 },
    );

    const startedAt = Date.now();
    const links = await service._candidateLinks([
      { pulseCharacterId: "slow-character" },
    ]);

    expect(links).toEqual(new Map());
    expect(getLinks).toHaveBeenCalledWith(["slow-character"]);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  test.each([
    ["IIII1111", null, null, null, true],
    ["IIII1111", "KnownPro", null, null, false],
    ["Readable", null, null, null, false],
    ["IIII1111", null, 4500, "123", true],
  ])(
    "eligibility for name=%s reveal=%s mmr=%s pulse=%s is %s",
    (displayNameSample, revealedName, mmr, pulseCharacterId, expected) => {
      expect(identityEligibility({
        displayNameSample,
        revealedName,
        mmr,
        pulseCharacterId,
      }).eligible).toBe(expected);
    },
  );

  test("milestone timing drift lowers otherwise identical build similarity", () => {
    const exact = milestoneSequenceSimilarity(
      [{ key: "gateway", atSec: 70 }],
      [{ key: "gateway", atSec: 70 }],
    );
    const late = milestoneSequenceSimilarity(
      [{ key: "gateway", atSec: 70 }],
      [{ key: "gateway", atSec: 140 }],
    );

    expect(exact).toBe(1);
    expect(late).toBeLessThan(0.2);
  });

  test("does not compare matchup-specific builds across matchups", () => {
    const target = [{
      myRace: "Terran",
      opponent: { strategy: "2-1-1", opening: "Reaper Expand" },
    }];
    const candidate = [{
      myRace: "Zerg",
      opponent: { strategy: "2-1-1", opening: "Reaper Expand" },
    }];

    expect(scoreCandidate(target, candidate, "T")).toBeNull();
  });
});

function playSignature({ slot = 1 } = {}) {
  return {
    version: 1,
    windowSec: 600,
    controlGroups: {
      events: 24,
      activeSeconds: 600,
      slots: [
        { slot, set: 3, add: 1, recall: 20, doubleTap: 4 },
      ],
      transitions: [
        { from: slot, to: (slot + 1) % 10, count: 3 },
      ],
    },
    build: {
      milestones: [
        { atSec: 70, name: "Gateway" },
        { atSec: 105, name: "CyberneticsCore" },
        { atSec: 180, name: "Nexus" },
      ],
    },
  };
}

function matchGame({ gameId, pulseId, pulseCharacterId }) {
  return {
    gameId,
    date: new Date("2026-08-31T00:00:00Z"),
    myRace: "Terran",
    opponent: {
      pulseId,
      ...(pulseCharacterId ? { pulseCharacterId } : {}),
      race: "Protoss",
      strategy: "PvT - Gateway Expand",
      opening: "Gateway Expand",
      playSignature: playSignature({ slot: 2 }),
    },
  };
}

function mockCursor(rows) {
  let limit = rows.length;
  return {
    sort() {
      return this;
    },
    limit(value) {
      limit = value;
      return this;
    },
    async toArray() {
      return rows.slice(0, limit);
    },
  };
}

async function insertOpponent(db, input) {
  await db.opponents.insertOne({
    userId: input.userId,
    pulseId: input.pulseId,
    ...(input.pulseCharacterId
      ? { pulseCharacterId: input.pulseCharacterId }
      : {}),
    displayNameSample: input.displayNameSample,
    revealedName: input.revealedName || null,
    race: input.race,
    ...(input.mmr ? { mmr: input.mmr } : {}),
    gameCount: input.gameCount || 1,
    lastSeen: input.lastSeen || new Date("2026-08-31T00:00:00Z"),
  });
}

async function insertGame(db, input) {
  const opponent = {
    pulseId: input.pulseId,
    ...(input.pulseCharacterId
      ? { pulseCharacterId: input.pulseCharacterId }
      : {}),
    race: input.opponentRace,
  };
  if (input.opponentMmr) opponent.mmr = input.opponentMmr;
  if (input.strategy !== null) {
    opponent.strategy = input.strategy || "PvT - Gateway Expand";
  }
  if (input.opening !== null) {
    opponent.opening = input.opening || "Gateway Expand";
  }
  if (input.signature) opponent.playSignature = input.signature;
  await db.games.insertOne({
    userId: input.userId,
    gameId: input.gameId,
    date: input.date || new Date("2026-08-31T00:00:00Z"),
    myRace: input.myRace || "Terran",
    gameBuild: 99999,
    isResumedFromReplay: false,
    opponent,
  });
}
