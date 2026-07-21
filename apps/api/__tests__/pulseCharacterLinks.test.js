// @ts-nocheck
"use strict";

/**
 * PulseCharacterLinkService — the shared SC2Pulse character →
 * account/pro linkage cache behind the Opponents tab's "group by
 * player" view — plus the /v1/opponents/pulse-links route contract.
 *
 * Service invariants:
 *   - one batch request per ≤500 uncached ids, results parsed into
 *     {accountId, proId, proNickname}
 *   - positive rows served from the cache without upstream traffic
 *   - ids SC2Pulse doesn't know are negative-cached (no refetch storm)
 *   - the per-call upstream budget bounds traffic and flags partial
 *   - an upstream failure degrades to stale data + partial, never throws
 */

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { PulseMmrService } = require("../src/services/pulseMmr");
const {
  PulseCharacterLinkService,
  __internal: { sanitizeIds },
} = require("../src/services/pulseCharacterLinks");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "test-token") return { sub: "clerk_user_links" };
    throw new Error("invalid");
  }),
}));

/** Shape-accurate group/character/full entry (captured live 2026-07-21). */
function fullEntry({ id, accountId, name, proId, proNickname }) {
  return {
    leagueMax: 6,
    ratingMax: 5000,
    totalGamesPlayed: 1000,
    members: {
      character: {
        realm: 1,
        name,
        id,
        accountId,
        region: "US",
        battlenetId: id * 10,
      },
      account: { battleTag: `${name.split("#")[0]}#999`, id: accountId },
      ...(proId ? { proId, proNickname } : {}),
      raceGames: { PROTOSS: 1000 },
    },
  };
}

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  };
}

describe("PulseCharacterLinkService", () => {
  let mongo;
  let db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_pulse_links",
    });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.pulseCharacterLinks.deleteMany({});
  });

  function build({ fetchImpl, now, ...rest } = {}) {
    return new PulseCharacterLinkService(db.pulseCharacterLinks, {
      fetchImpl,
      now,
      ...rest,
    });
  }

  test("fetches a batch, parses linkage, and persists it", async () => {
    const calls = [];
    const svc = build({
      fetchImpl: async (url) => {
        calls.push(url);
        return jsonResponse([
          fullEntry({ id: 111, accountId: 900, name: "Main#1" }),
          fullEntry({
            id: 222,
            accountId: 901,
            name: "IIIIIIII#2",
            proId: 55,
            proNickname: "Star",
          }),
        ]);
      },
    });
    const { links, partial } = await svc.getLinks(["111", "222", "333"]);
    expect(partial).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("characterId=111,222,333");
    expect(links.get("111")).toEqual({
      accountId: "900",
      proId: null,
      proNickname: null,
    });
    expect(links.get("222")).toEqual({
      accountId: "901",
      proId: "55",
      proNickname: "Star",
    });
    // 333 wasn't in the response → negative row persisted, no link.
    expect(links.has("333")).toBe(false);
    const negative = await db.pulseCharacterLinks.findOne({
      pulseCharacterId: "333",
    });
    expect(negative).toBeTruthy();
    expect(negative.accountId).toBeNull();
  });

  test("serves the cache without upstream traffic on the second call", async () => {
    let fetches = 0;
    const fetchImpl = async () => {
      fetches += 1;
      return jsonResponse([fullEntry({ id: 111, accountId: 900, name: "A#1" })]);
    };
    const svc = build({ fetchImpl });
    await svc.getLinks(["111"]);
    expect(fetches).toBe(1);
    const again = await svc.getLinks(["111"]);
    expect(fetches).toBe(1);
    expect(again.links.get("111").accountId).toBe("900");
    expect(again.partial).toBe(false);
  });

  test("negative-caches unknown ids within the miss TTL, retries after", async () => {
    let clock = 1_000_000;
    let fetches = 0;
    const svc = build({
      fetchImpl: async () => {
        fetches += 1;
        return jsonResponse([]);
      },
      now: () => clock,
      missTtlMs: 1000,
    });
    await svc.getLinks(["444"]);
    await svc.getLinks(["444"]);
    expect(fetches).toBe(1);
    clock += 1001;
    await svc.getLinks(["444"]);
    expect(fetches).toBe(2);
  });

  test("caps upstream traffic per call and reports partial", async () => {
    const calls = [];
    const svc = build({
      fetchImpl: async (url) => {
        calls.push(url);
        return jsonResponse([]);
      },
      maxBatchesPerCall: 1,
    });
    // 501 ids → one full batch of 500 fetched, 1 left over.
    const ids = Array.from({ length: 501 }, (_, i) => String(10_000 + i));
    const { partial } = await svc.getLinks(ids);
    expect(calls).toHaveLength(1);
    expect(partial).toBe(true);
  });

  test("serves stale rows and flags partial when upstream fails", async () => {
    let clock = 1_000_000;
    let shouldFail = false;
    const svc = build({
      fetchImpl: async () => {
        if (shouldFail) throw new Error("network down");
        return jsonResponse([
          fullEntry({ id: 111, accountId: 900, name: "A#1" }),
        ]);
      },
      now: () => clock,
      linkTtlMs: 1000,
    });
    await svc.getLinks(["111"]);
    clock += 1001; // row is now stale
    shouldFail = true;
    const { links, partial } = await svc.getLinks(["111"]);
    expect(partial).toBe(true);
    expect(links.get("111").accountId).toBe("900");
  });

  test("sanitizeIds keeps deduped numeric strings only", () => {
    expect(
      sanitizeIds(["111", 222, "111", "1-S2-1-267727", "", null, "abc"]),
    ).toEqual(["111", "222"]);
  });
});

describe("GET /v1/opponents/pulse-links", () => {
  let mongo;
  let db;
  let app;
  let userId;
  const linkCalls = [];

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_pulse_links_route",
    clerkSecretKey: "sk_test",
    clerkJwtIssuer: undefined,
    clerkJwtAudience: undefined,
    serverPepper: Buffer.alloc(32, 7),
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
      pulseLinks: {
        getLinks: async (ids) => {
          linkCalls.push([...ids]);
          return {
            links: new Map([
              ["777", { accountId: "42", proId: null, proNickname: null }],
              ["778", { accountId: "42", proId: null, proNickname: null }],
            ]),
            partial: false,
          };
        },
      },
    });
    app = built.app;

    const me = await request(app)
      .get("/v1/me")
      .set("authorization", "Bearer test-token");
    expect(me.status).toBe(200);
    userId = me.body.userId;
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  test("returns the caller's resolved character ids mapped to linkage", async () => {
    await db.opponents.insertMany([
      { userId, pulseId: "1-S2-1-1", pulseCharacterId: "777", gameCount: 2 },
      { userId, pulseId: "1-S2-1-2", pulseCharacterId: "778", gameCount: 1 },
      // Unresolved row — must not reach the service.
      { userId, pulseId: "1-S2-1-3", gameCount: 1 },
      // Someone else's opponent — must not leak into the id set.
      {
        userId: "someone_else",
        pulseId: "1-S2-1-4",
        pulseCharacterId: "999",
        gameCount: 5,
      },
    ]);
    const res = await request(app)
      .get("/v1/opponents/pulse-links")
      .set("authorization", "Bearer test-token");
    expect(res.status).toBe(200);
    expect(res.body.partial).toBe(false);
    expect(res.body.links).toEqual({
      777: { accountId: "42", proId: null, proNickname: null },
      778: { accountId: "42", proId: null, proNickname: null },
    });
    expect(linkCalls).toHaveLength(1);
    expect([...linkCalls[0]].sort()).toEqual(["777", "778"]);
  });

  test("requires auth", async () => {
    const res = await request(app).get("/v1/opponents/pulse-links");
    expect(res.status).toBe(401);
  });
});
