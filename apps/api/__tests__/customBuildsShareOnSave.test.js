// @ts-nocheck
"use strict";

/**
 * Save-time community sharing for custom builds.
 *
 * Spec: the BuildEditor "Share with community" toggle (and the sheet's
 * "Build is public" toggle) sends a share flag with PUT /custom-builds.
 * The server must honour it — publishing on true, unpublishing on
 * false — so a build "shared" from a replay actually reaches the
 * community tab. Re-publishing must preserve the public slug + votes,
 * the public snapshot must strip private fields (notes), and the
 * matchup must be derived from race/vsRace for v3 builds.
 */

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "test-clerk-token") return { sub: "clerk_user_share" };
    throw new Error("invalid");
  }),
}));

describe("PUT /v1/custom-builds/:slug — community share on save", () => {
  let mongo;
  let db;
  let app;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_share_on_save",
    clerkSecretKey: "sk_test",
    clerkJwtIssuer: undefined,
    clerkJwtAudience: undefined,
    serverPepper: Buffer.alloc(32, 3),
    corsAllowedOrigins: [],
    rateLimitPerMinute: 1000,
    agentReleaseAdminToken: "admin-token-for-tests",
    pythonExe: null,
    pythonAnalyzerDir: "/tmp/__definitely_missing__",
    adminUserIds: [],
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: config.mongoDb });
    const built = buildApp({ db, logger: pino({ level: "silent" }), config });
    app = built.app;
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  function withAuth(req) {
    return req.set("authorization", "Bearer test-clerk-token");
  }

  async function bootstrapUserId() {
    const me = await withAuth(request(app).get("/v1/me"));
    expect(me.status).toBe(200);
    return me.body.userId;
  }

  test("saving with shareWithCommunity:true publishes and strips private notes", async () => {
    const userId = await bootstrapUserId();

    const put = await withAuth(
      request(app).put("/v1/custom-builds/pvt-macro").send({
        slug: "pvt-macro",
        name: "PvT Macro",
        race: "Protoss",
        vsRace: "Terran",
        description: "Greedy nexus-first into double stargate.",
        notes: "my private scouting tells — do not share",
        rules: [{ type: "before", name: "BuildStargate", time_lt: 300 }],
        shareWithCommunity: true,
        schemaVersion: 3,
      }),
    );
    expect(put.status).toBe(200);
    expect(put.body.community).toMatchObject({ action: "published" });
    const publicSlug = put.body.community.slug;
    expect(typeof publicSlug).toBe("string");
    expect(publicSlug.length).toBeGreaterThan(0);

    // It shows up on the public listing, tagged with the derived matchup.
    const list = await request(app).get("/v1/community/builds");
    expect(list.status).toBe(200);
    const row = list.body.items.find((b) => b.slug === publicSlug);
    expect(row).toBeTruthy();
    expect(row.title).toBe("PvT Macro");
    expect(row.matchup).toBe("PvT");
    expect(row.ownerUserId).toBe(userId);

    // The public snapshot must NOT carry the author's private notes.
    const detail = await request(app).get(
      `/v1/community/builds/${publicSlug}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.build).toBeTruthy();
    expect(detail.body.build.name).toBe("PvT Macro");
    expect(detail.body.build.notes).toBeUndefined();
    expect(detail.body.build.userId).toBeUndefined();

    // The private doc's badge flag is mirrored.
    const priv = await withAuth(
      request(app).get("/v1/custom-builds/pvt-macro"),
    );
    expect(priv.status).toBe(200);
    expect(priv.body.isPublic).toBe(true);
    // ...but the private doc still keeps the notes for the owner.
    expect(priv.body.notes).toBe("my private scouting tells — do not share");
  });

  test("re-saving a published build keeps the same public slug and votes", async () => {
    await bootstrapUserId();

    const first = await withAuth(
      request(app).put("/v1/custom-builds/zvp-ling-flood").send({
        slug: "zvp-ling-flood",
        name: "ZvP Ling Flood",
        race: "Zerg",
        vsRace: "Protoss",
        rules: [{ type: "count_min", name: "BuildZergling", time_lt: 200, count: 6 }],
        shareWithCommunity: true,
        schemaVersion: 3,
      }),
    );
    expect(first.status).toBe(200);
    const slug = first.body.community.slug;
    expect(first.body.community.action).toBe("published");

    // Simulate the public earning some votes.
    await db.communityBuilds.updateOne({ slug }, { $set: { votes: 9 } });

    // Edit + re-save (still shared).
    const second = await withAuth(
      request(app).put("/v1/custom-builds/zvp-ling-flood").send({
        slug: "zvp-ling-flood",
        name: "ZvP Ling Flood (refined)",
        race: "Zerg",
        vsRace: "Protoss",
        rules: [{ type: "count_min", name: "BuildZergling", time_lt: 180, count: 8 }],
        shareWithCommunity: true,
        schemaVersion: 3,
      }),
    );
    expect(second.status).toBe(200);
    expect(second.body.community.action).toBe("updated");
    expect(second.body.community.slug).toBe(slug); // stable URL

    const detail = await request(app).get(`/v1/community/builds/${slug}`);
    expect(detail.status).toBe(200);
    expect(detail.body.votes).toBe(9); // not reset
    expect(detail.body.title).toBe("ZvP Ling Flood (refined)"); // metadata refreshed
  });

  test("saving with shareWithCommunity:false unpublishes", async () => {
    await bootstrapUserId();

    const pub = await withAuth(
      request(app).put("/v1/custom-builds/tvz-mech").send({
        slug: "tvz-mech",
        name: "TvZ Mech",
        race: "Terran",
        vsRace: "Zerg",
        rules: [{ type: "before", name: "BuildFactory", time_lt: 200 }],
        shareWithCommunity: true,
        schemaVersion: 3,
      }),
    );
    expect(pub.status).toBe(200);
    const slug = pub.body.community.slug;
    expect((await request(app).get(`/v1/community/builds/${slug}`)).status).toBe(
      200,
    );

    // Flip the toggle off and save again.
    const unpub = await withAuth(
      request(app).put("/v1/custom-builds/tvz-mech").send({
        slug: "tvz-mech",
        name: "TvZ Mech",
        race: "Terran",
        vsRace: "Zerg",
        rules: [{ type: "before", name: "BuildFactory", time_lt: 200 }],
        shareWithCommunity: false,
        schemaVersion: 3,
      }),
    );
    expect(unpub.status).toBe(200);
    expect(unpub.body.community).toMatchObject({ action: "unpublished" });

    // Public detail is gone (soft-removed) and the badge flag flips back.
    expect((await request(app).get(`/v1/community/builds/${slug}`)).status).toBe(
      404,
    );
    const priv = await withAuth(request(app).get("/v1/custom-builds/tvz-mech"));
    expect(priv.body.isPublic).toBe(false);
  });

  test("saving without a share flag never touches community state", async () => {
    await bootstrapUserId();

    const put = await withAuth(
      request(app).put("/v1/custom-builds/pvp-blink").send({
        slug: "pvp-blink",
        name: "PvP Blink",
        race: "Protoss",
        vsRace: "Protoss",
        rules: [{ type: "before", name: "ResearchBlink", time_lt: 400 }],
        schemaVersion: 3,
      }),
    );
    expect(put.status).toBe(200);
    // No flag in the body → no publish/unpublish attempted.
    expect(put.body.community).toBeNull();

    const list = await request(app).get("/v1/community/builds?q=PvP Blink");
    expect(list.body.items.length).toBe(0);
  });
});
