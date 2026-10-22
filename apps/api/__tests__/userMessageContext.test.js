// @ts-nocheck
"use strict";

/**
 * Report type + diagnostics context on POST /v1/messages:
 *   - the storage-side sanitiser keeps only whitelisted fields and
 *     strips overlay tokens, pairing codes and sensitive query values;
 *   - the request schema refuses unknown types, unknown fields and
 *     anything over 2 KB;
 *   - a report's type and context reach the admin feed.
 */

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const {
  REPORT_CONTEXT_MAX_BYTES,
  contextBytes,
  sanitiseReportContext,
  sanitiseReportPagePath,
} = require("../src/services/reportContext");
const { validateReportExtras } = require("../src/validation/userMessage");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "admin-token") return { sub: "clerk_admin" };
    if (token === "user-token") return { sub: "clerk_context_user" };
    throw new Error("invalid");
  }),
}));

const FULL_CONTEXT = {
  page: "/app/opponents/1-S2-1-99",
  build: "4f9c2ab1d0e3",
  browser: "Chrome 129 on Windows",
  viewport: "1440x900",
  agentVersion: "0.19.0",
  agentStatus: "online",
  failedRequests: [
    { path: "/v1/games?limit=50", status: 500, code: "internal_error", requestId: "req-1" },
  ],
};

describe("report context sanitiser", () => {
  test("strips page queries and browser-source tokens", () => {
    expect(sanitiseReportPagePath("/settings?tab=overlay#widgets")).toBe("/settings");
    expect(sanitiseReportPagePath("/overlay/secret-token/widget/scout?x=1"))
      .toBe("/overlay/[redacted]/widget/scout");
    expect(sanitiseReportPagePath("/dock/secret-token")).toBe("/dock/[redacted]");
    expect(sanitiseReportPagePath("https://evil.test/x")).toBe("");
  });

  test("redacts credentials in failed request paths", () => {
    const stored = sanitiseReportContext({
      failedRequests: [
        { path: "/v1/multichat/overlay-key/config", status: 404 },
        { path: "/v1/overlay-tokens/tok_abc/widgets?apiKey=k&limit=5", status: 500 },
        { path: "/v1/device-pairings/PAIR-1234", status: 410 },
        { path: "/v1/games?token=abc&limit=5", status: 502, code: "bad_gateway" },
      ],
    });
    const serialized = JSON.stringify(stored);
    for (const secret of ["overlay-key", "tok_abc", "apiKey=k", "PAIR-1234", "token=abc"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(stored.failedRequests.map((r) => r.path)).toEqual([
      "/v1/multichat/[redacted]/config",
      "/v1/overlay-tokens/[redacted]/widgets?apiKey=%5Bredacted%5D&limit=5",
      "/v1/device-pairings/[redacted]",
      "/v1/games?token=%5Bredacted%5D&limit=5",
    ]);
  });

  test("keeps only whitelisted fields and drops malformed requests", () => {
    const stored = sanitiseReportContext({
      ...FULL_CONTEXT,
      cookie: "session=secret",
      agentStatus: "hacking",
      failedRequests: [{ path: "no-slash", status: 500 }, { path: "/v1/x", status: 1000 }],
    });
    expect(stored).toEqual({
      page: FULL_CONTEXT.page,
      build: FULL_CONTEXT.build,
      browser: FULL_CONTEXT.browser,
      viewport: FULL_CONTEXT.viewport,
      agentVersion: FULL_CONTEXT.agentVersion,
    });
    expect(sanitiseReportContext({ cookie: "x" })).toBeNull();
    expect(sanitiseReportContext("nope")).toBeNull();
  });
});

describe("report extras schema", () => {
  test("accepts a typed report with a full context", () => {
    expect(validateReportExtras({ type: "idea", context: FULL_CONTEXT }))
      .toEqual({ valid: true, type: "idea", context: FULL_CONTEXT });
    expect(validateReportExtras({})).toEqual({ valid: true, type: null, context: null });
  });

  test.each([
    ["an unknown type", { type: "rant" }],
    ["an unknown context field", { context: { ...FULL_CONTEXT, cookie: "x" } }],
    ["a non-object context", { context: "page=/app" }],
    ["too many failed requests", {
      context: { failedRequests: Array.from({ length: 6 }, () => ({ path: "/v1/x", status: 500 })) },
    }],
    ["a request without a status", { context: { failedRequests: [{ path: "/v1/x" }] } }],
    ["an over-long field", { context: { page: `/${"a".repeat(300)}` } }],
  ])("refuses %s", (_label, body) => {
    expect(validateReportExtras(body).valid).toBe(false);
  });

  test("refuses a context over 2 KB even when every field fits", () => {
    const big = {
      page: `/${"p".repeat(199)}`,
      build: "b".repeat(40),
      browser: "c".repeat(120),
      viewport: "1".repeat(20),
      agentVersion: "v".repeat(32),
      agentStatus: "not_paired",
      failedRequests: Array.from({ length: 5 }, () => ({
        path: `/${"x".repeat(159)}`, status: 500, code: "c".repeat(64), requestId: "r".repeat(64),
      })),
    };
    expect(contextBytes(big)).toBeGreaterThan(REPORT_CONTEXT_MAX_BYTES);
    expect(validateReportExtras({ context: big })).toEqual({
      valid: false,
      message: "The details attached to this report are too large.",
    });
  });
});

function baseConfig() {
  return {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_user_message_context",
    clerkSecretKey: "sk_test",
    clerkJwtIssuer: undefined,
    clerkJwtAudience: undefined,
    clerkWebhookSecret: "whsec_" + Buffer.from("ctx-test").toString("base64"),
    serverPepper: Buffer.alloc(32, 7),
    corsAllowedOrigins: [],
    rateLimitPerMinute: 5000,
    agentReleaseAdminToken: "admin",
    pythonExe: null,
    pythonAnalyzerDir: "/tmp/__nonexistent__",
    adminUserIds: ["clerk_admin"],
    gameDetailsStore: "mongo",
    r2: null,
    maxUserMessagesPerWindow: 5000,
  };
}

const harness = { mongo: null, db: null, app: null };
const asUser = (req) => req.set("authorization", "Bearer user-token");
const asAdmin = (req) => req.set("authorization", "Bearer admin-token");
const send = (body) => asUser(request(harness.app).post("/v1/messages"))
  .send({ subject: "Opponents page is blank", message: "It spins forever.", ...body });

beforeAll(async () => {
  harness.mongo = await MongoMemoryServer.create();
  harness.db = await connect({ uri: harness.mongo.getUri(), dbName: baseConfig().mongoDb });
  const built = buildApp({ db: harness.db, logger: pino({ level: "silent" }), config: baseConfig() });
  harness.app = built.app;
  await built.services.users.ensureFromClerk("clerk_admin");
});

afterAll(async () => {
  if (harness.db) await harness.db.close();
  if (harness.mongo) await harness.mongo.stop();
});

beforeEach(async () => {
  await harness.db.adminEvents.deleteMany({});
});

describe("POST /v1/messages with a type and context", () => {
  test("stores both, sanitised, and shows them in the admin feed", async () => {
    const res = await send({
      type: "problem",
      context: {
        ...FULL_CONTEXT,
        page: "/overlay/secret-token?debug=1",
        failedRequests: [{ path: "/v1/chatbot/bot-token/mmr", status: 401, code: "unauthorized" }],
      },
    });
    expect(res.status).toBe(201);

    const feed = await asAdmin(request(harness.app).get("/v1/admin/events?type=user_message"));
    const payload = feed.body.items[0].payload;
    expect(payload.type).toBe("problem");
    expect(payload.context).toEqual({
      ...FULL_CONTEXT,
      page: "/overlay/[redacted]",
      failedRequests: [{ path: "/v1/chatbot/[redacted]/mmr", status: 401, code: "unauthorized" }],
    });
    expect(JSON.stringify(payload)).not.toMatch(/secret-token|bot-token/);
  });

  test("keeps reports without a type or context unchanged", async () => {
    expect((await send({})).status).toBe(201);
    const stored = await harness.db.adminEvents.findOne({ type: "user_message" });
    expect(stored.payload).not.toHaveProperty("type");
    expect(stored.payload).not.toHaveProperty("context");
  });

  test.each([
    [{ type: "rant" }],
    [{ context: { ...FULL_CONTEXT, headers: { authorization: "Bearer x" } } }],
  ])("rejects an invalid type or context with 400", async (body) => {
    const res = await send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
    expect(await harness.db.adminEvents.countDocuments({ type: "user_message" })).toBe(0);
  });
});
