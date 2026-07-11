// @ts-nocheck
"use strict";

/**
 * Skill Fingerprint — service math + route contract, end-to-end
 * through the real app wiring (buildApp + mongodb-memory-server), with
 * the percentile tables recomputed by the REAL leaguePercentiles
 * service over a seeded corpus (same pattern as
 * benchmarksRoute.test.js).
 *
 * Covers:
 *   1. Axis percentile plausibility against known uniform
 *      distributions (top-decile player reads high on every axis;
 *      Aggression inverts the duration ladder).
 *   2. The n < 10 gate (404 not_enough_games) and the 50-game window.
 *   3. Playstyle determinism — the pure decision table directly, plus
 *      repeat-request stability through the route.
 *   4. Route contract: 400 on bad matchup, 401 unauth, band labelling
 *      without a percentile table, null-axis hiding.
 */

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { PulseMmrService } = require("../src/services/pulseMmr");
const { derivePlaystyle } = require("../src/services/skillFingerprint");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "test-token") return { sub: "clerk_user_fingerprint" };
    throw new Error("invalid");
  }),
}));

const DIAMOND = 4;
const MASTER = 5;

describe("skill fingerprint", () => {
  let mongo;
  let db;
  let app;
  let services;
  let userId;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_fingerprint",
    clerkSecretKey: "sk_test",
    clerkJwtIssuer: undefined,
    clerkJwtAudience: undefined,
    serverPepper: Buffer.alloc(32, 9),
    corsAllowedOrigins: [],
    rateLimitPerMinute: 5000,
    agentReleaseAdminToken: "admin",
    pythonExe: null,
    pythonAnalyzerDir: "/tmp/__nonexistent__",
    adminUserIds: [],
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: config.mongoDb });
    const built = buildApp({
      db,
      logger: pino({ level: "silent" }),
      config,
      pulseMmr: new PulseMmrService({
        fetchImpl: async () => {
          throw new Error("network_disabled_in_tests");
        },
      }),
    });
    app = built.app;
    services = built.services;

    // Resolve the internal userId behind the mocked Clerk token — the
    // fingerprint user's games must be seeded under it.
    const me = await request(app)
      .get("/v1/me")
      .set("authorization", "Bearer test-token");
    expect(me.status).toBe(200);
    userId = me.body.userId;
    expect(typeof userId).toBe("string");

    await seedCorpusAndRecompute();
    await seedFingerprintUser();
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  function getFingerprint(query) {
    return request(app)
      .get(`/v1/me/fingerprint${query}`)
      .set("authorization", "Bearer test-token");
  }

  /**
   * Corpus: 100 Diamond-PvZ games across 10 corpus users with known
   * uniform metric spreads (identical maths to
   * leaguePercentiles.test.js so decile k ≈ known values):
   *   macroScore  0.5..99.5    apm 100..298    spq 50..149
   *   durationSec 300..894     myMmr 3000..3990
   * Recomputed through the REAL service so lookup + percentileOf run
   * against genuine $percentile output.
   */
  async function seedCorpusAndRecompute() {
    const docs = [];
    for (let i = 0; i < 100; i += 1) {
      docs.push({
        userId: `corpus_u_${i % 10}`,
        gameId: `fp_corpus_${i}`,
        date: new Date(Date.UTC(2026, 4, 1 + (i % 28))),
        result: i % 2 === 0 ? "Victory" : "Defeat",
        myRace: "Protoss",
        map: "Fingerprint Fields",
        playerCount: 2,
        macroScore: i + 0.5,
        apm: 100 + 2 * i,
        spq: 50 + i,
        durationSec: 300 + 6 * i,
        myMmr: 3000 + 10 * i,
        opponent: { pulseId: `1-S2-1-${i}`, race: "Zerg", leagueId: DIAMOND },
      });
    }
    await db.games.insertMany(docs);
    await services.leaguePercentiles.recompute();
  }

  /**
   * The fingerprint user's own games:
   *   PvZ — 20 identical top-decile games vs Diamond (macroScore 90,
   *     apm 290, spq 140, myMmr 3900) that all end at 5:30 → every
   *     percentile axis high, sd 0 → Consistency 100, all games under
   *     8:00 → Aggression value 100.
   *   PvT — 5 games only → under the MIN_GAMES gate.
   *   ZvT — 55 games vs Master with macroScore alternating 20/80
   *     (population sd exactly 30 → Consistency 0). No ZvT corpus
   *     band exists, so every percentile axis hides; also exercises
   *     the 50-game window (55 seeded → games: 50).
   */
  async function seedFingerprintUser() {
    const docs = [];
    for (let i = 0; i < 20; i += 1) {
      docs.push({
        userId,
        gameId: `fp_me_pvz_${i}`,
        date: new Date(Date.UTC(2026, 5, 1 + i)),
        result: "Victory",
        myRace: "Protoss",
        map: "Fingerprint Fields",
        playerCount: 2,
        macroScore: 90,
        apm: 290,
        spq: 140,
        durationSec: 330,
        myMmr: 3900,
        opponent: { pulseId: `1-S2-1-90${i}`, race: "Zerg", leagueId: DIAMOND },
      });
    }
    for (let i = 0; i < 5; i += 1) {
      docs.push({
        userId,
        gameId: `fp_me_pvt_${i}`,
        date: new Date(Date.UTC(2026, 5, 1 + i)),
        result: "Defeat",
        myRace: "Protoss",
        map: "Fingerprint Fields",
        playerCount: 2,
        macroScore: 50,
        durationSec: 700,
        opponent: { pulseId: `2-S2-1-${i}`, race: "Terran", leagueId: DIAMOND },
      });
    }
    for (let i = 0; i < 55; i += 1) {
      docs.push({
        userId,
        gameId: `fp_me_zvt_${i}`,
        date: new Date(Date.UTC(2026, 5, 1, i)),
        result: i % 2 === 0 ? "Victory" : "Defeat",
        myRace: "Zerg",
        map: "Fingerprint Fields",
        playerCount: 2,
        macroScore: i % 2 === 0 ? 20 : 80,
        durationSec: 900,
        opponent: { pulseId: `3-S2-1-${i}`, race: "Terran", leagueId: MASTER },
      });
    }
    await db.games.insertMany(docs);
  }

  test("route contract: 400 on missing/invalid matchup", async () => {
    expect((await getFingerprint("")).status).toBe(400);
    expect((await getFingerprint("?matchup=XvY")).status).toBe(400);
    expect((await getFingerprint("?matchup=PvZvT")).status).toBe(400);
    const bad = await getFingerprint("?matchup=Protoss");
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("bad_request");
  });

  test("route contract: requires auth", async () => {
    const res = await request(app).get("/v1/me/fingerprint?matchup=PvZ");
    expect(res.status).toBe(401);
  });

  test("n < 10 games in the matchup → 404 not_enough_games", async () => {
    const res = await getFingerprint("?matchup=PvT");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_enough_games");
  });

  test("axis percentiles are plausible for a top-decile player", async () => {
    const res = await getFingerprint("?matchup=PvZ");
    expect(res.status).toBe(200);
    const fp = res.body.fingerprint;

    expect(fp.matchup).toBe("PvZ");
    expect(fp.games).toBe(20);
    expect(fp.band).toEqual({ leagueId: DIAMOND, label: "Diamond" });
    expect(fp.axes.map((a) => a.key)).toEqual([
      "macro",
      "mechanics",
      "spending",
      "consistency",
      "aggression",
      "ladder",
    ]);

    const ax = Object.fromEntries(fp.axes.map((a) => [a.key, a]));
    // macroScore 90 vs uniform 0.5..99.5 → ≈ p90.
    expect(ax.macro.percentile).toBeGreaterThanOrEqual(80);
    expect(ax.macro.percentile).toBeLessThanOrEqual(99);
    expect(ax.macro.value).toBe(90);
    // apm 290 vs uniform 100..298 → above p90.
    expect(ax.mechanics.percentile).toBeGreaterThanOrEqual(85);
    // spq 140 vs uniform 50..149 → ≈ p90.
    expect(ax.spending.percentile).toBeGreaterThanOrEqual(80);
    // Identical macroScore every game → sd 0 → Consistency 100.
    expect(ax.consistency.percentile).toBe(100);
    expect(ax.consistency.value).toBe(0);
    // durationSec 330 is below the band's p10 (~359) → inverted
    // percentile lands high; every game ends before 8:00 → value 100.
    expect(ax.aggression.percentile).toBeGreaterThanOrEqual(85);
    expect(ax.aggression.value).toBe(100);
    // myMmr 3900 vs uniform 3000..3990 → ≈ p90.
    expect(ax.ladder.percentile).toBeGreaterThanOrEqual(80);

    // All axes ≥ 65 with ≥ 4 present → decision-table rule 1.
    expect(fp.playstyle).toBe("Complete Player");
  });

  test("matchup is case-insensitive and canonicalized", async () => {
    const res = await getFingerprint("?matchup=pvz");
    expect(res.status).toBe(200);
    expect(res.body.fingerprint.matchup).toBe("PvZ");
  });

  test("playstyle is deterministic across repeat requests", async () => {
    const first = await getFingerprint("?matchup=PvZ");
    const second = await getFingerprint("?matchup=PvZ");
    expect(second.body.fingerprint).toEqual(first.body.fingerprint);
  });

  test("bandless-table matchup: percentile axes hide, consistency survives, window caps at 50", async () => {
    const res = await getFingerprint("?matchup=ZvT");
    expect(res.status).toBe(200);
    const fp = res.body.fingerprint;

    // 55 games seeded → only the most recent 50 count.
    expect(fp.games).toBe(50);
    // Modal opponent league resolves even without a percentile table.
    expect(fp.band).toEqual({ leagueId: MASTER, label: "Master" });

    const ax = Object.fromEntries(fp.axes.map((a) => [a.key, a]));
    // No ZvT corpus band → every band-relative axis is null...
    expect(ax.macro.percentile).toBeNull();
    expect(ax.mechanics.percentile).toBeNull();
    expect(ax.spending.percentile).toBeNull();
    expect(ax.aggression.percentile).toBeNull();
    expect(ax.ladder.percentile).toBeNull();
    // ...but raw values still surface where the player has data.
    expect(ax.macro.value).toBe(50); // mean of alternating 20/80
    expect(ax.aggression.value).toBe(0); // all games 15:00 — no early finishes
    // Consistency is percentile-free: sd 30 ≥ ceiling 25 → 0.
    expect(ax.consistency.percentile).toBe(0);
    expect(ax.consistency.value).toBe(30);
    // Consistency < 35 → decision-table rule 8.
    expect(fp.playstyle).toBe("Coin-Flip Player");
  });

  describe("derivePlaystyle decision table (pure)", () => {
    const base = {
      macro: null,
      mechanics: null,
      spending: null,
      consistency: null,
      aggression: null,
      ladder: null,
    };

    test("rule 1: complete player needs ≥4 present axes all ≥65", () => {
      expect(
        derivePlaystyle({
          macro: 70,
          mechanics: 70,
          spending: 70,
          consistency: 70,
          aggression: 70,
          ladder: 70,
        }),
      ).toBe("Complete Player");
      // Only 3 axes present → rule 1 ineligible even though all ≥65;
      // aggression+mechanics high → rule 4 claims it instead.
      expect(
        derivePlaystyle({ ...base, macro: 70, mechanics: 70, aggression: 70 }),
      ).toBe("Tempo Attacker");
    });

    test("rules 2/3: the aggression–macro identity split", () => {
      expect(derivePlaystyle({ ...base, aggression: 80, macro: 20 })).toBe(
        "All-in Gambler",
      );
      expect(derivePlaystyle({ ...base, macro: 80, aggression: 20 })).toBe(
        "Greedy Macro Player",
      );
    });

    test("rule 2 outranks rule 4 (precedence)", () => {
      expect(
        derivePlaystyle({ ...base, aggression: 80, macro: 20, mechanics: 90 }),
      ).toBe("All-in Gambler");
    });

    test("rules 4–7: softer tendencies", () => {
      expect(
        derivePlaystyle({ ...base, aggression: 70, mechanics: 70, macro: 50 }),
      ).toBe("Tempo Attacker");
      expect(
        derivePlaystyle({
          ...base,
          spending: 80,
          macro: 60,
          aggression: 50,
          mechanics: 50,
        }),
      ).toBe("Economic Engine");
      expect(derivePlaystyle({ ...base, mechanics: 80, spending: 30 })).toBe(
        "Busy Hands, Idle Bank",
      );
      expect(
        derivePlaystyle({ ...base, consistency: 80, aggression: 30, macro: 50 }),
      ).toBe("Metronome");
    });

    test("rule 8 + fallback", () => {
      expect(derivePlaystyle({ ...base, consistency: 20 })).toBe(
        "Coin-Flip Player",
      );
      expect(
        derivePlaystyle({
          macro: 50,
          mechanics: 50,
          spending: 50,
          consistency: 50,
          aggression: 60,
          ladder: 50,
        }),
      ).toBe("Jack of All Trades");
    });

    test("rules referencing a null axis are ineligible", () => {
      // Consistency 80 would be Metronome, but aggression is hidden →
      // rule 7 can't fire; consistency ≥35 → rule 8 can't either.
      expect(derivePlaystyle({ ...base, consistency: 80 })).toBe(
        "Jack of All Trades",
      );
      expect(derivePlaystyle(base)).toBe("Jack of All Trades");
    });
  });
});
