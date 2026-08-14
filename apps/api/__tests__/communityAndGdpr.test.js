// @ts-nocheck
"use strict";

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "user-a") return { sub: "clerk_user_a" };
    if (token === "user-b") return { sub: "clerk_user_b" };
    if (token === "admin-x") return { sub: "clerk_admin" };
    throw new Error("invalid");
  }),
}));

describe("community + gdpr integration", () => {
  let mongo;
  let db;
  let app;
  let services;
  let userAId;

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_comm",
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
    db = await connect({ uri: mongo.getUri(), dbName: "sc2tools_test_comm" });
    // Resolve the internal user ids.
    const aRes = await db.users.insertOne({
      userId: "u_a",
      clerkUserId: "clerk_user_a",
      createdAt: new Date(),
      lastSeenAt: new Date(),
    });
    userAId = "u_a";
    await db.users.insertOne({
      userId: "u_admin",
      clerkUserId: "clerk_admin",
      createdAt: new Date(),
      lastSeenAt: new Date(),
    });

    // SC2TOOLS_ADMIN_USER_IDS holds *Clerk* user IDs (the `user_xxx`
    // strings from the Clerk dashboard), not internal UUIDs — match
    // the verifyToken mock above which returns sub: "clerk_admin"
    // for the "admin-x" bearer.
    config.adminUserIds = ["clerk_admin"];
    const built = buildApp({
      db,
      logger: pino({ level: "silent" }),
      config,
    });
    app = built.app;
    services = built.services;
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  describe("publishes a custom build then surfaces it publicly", () => {
    test("publish + list + detail", async () => {
      // Seed a private custom build for user A.
      await services.customBuilds.upsert("u_a", {
        slug: "my-build",
        name: "My PvT Macro",
        matchup: "PvT",
        steps: [{ supply: 14, time: "0:18", action: "Pylon" }],
      });

      const pub = await request(app)
        .post("/v1/community/builds")
        .set("authorization", "Bearer user-a")
        .send({ slug: "my-build", title: "Macro PvT", description: "Test" });
      expect(pub.status).toBe(201);
      expect(pub.body.slug).toBeTruthy();
      const slug = pub.body.slug;

      const list = await request(app).get("/v1/community/builds");
      expect(list.status).toBe(200);
      expect(list.body.items.length).toBe(1);
      expect(list.body.items[0].title).toBe("Macro PvT");
      // Phase 9: ownerUserId is the internal UUID (not the Clerk id) and
      // is exposed publicly so the frontend can link to the author
      // profile page.
      expect(list.body.items[0].ownerUserId).toBe("u_a");
      expect(typeof list.body.total).toBe("number");
      expect(list.body.hasMore).toBe(false);

      const detail = await request(app).get(
        `/v1/community/builds/${slug}`,
      );
      expect(detail.status).toBe(200);
      expect(detail.body.build).toBeTruthy();
      // The public document has its own shareable slug. The nested private
      // source slug is internal publishing metadata and must never serialize.
      expect(detail.body.build.slug).toBeUndefined();
      expect(detail.body.ownerUserId).toBe("u_a");
      // Per-user vote arrays must NOT be returned publicly.
      expect(detail.body.upvotes).toBeUndefined();
      expect(detail.body.downvotes).toBeUndefined();
      expect(detail.body.sourceSlug).toBeUndefined();
    });

    test("list supports sort=new and q= search", async () => {
      // Newest-first sort: the previously published build is the only
      // one in the collection, so it must appear regardless of sort.
      const newest = await request(app).get(
        "/v1/community/builds?sort=new",
      );
      expect(newest.status).toBe(200);
      expect(newest.body.items.length).toBeGreaterThan(0);

      const found = await request(app).get(
        "/v1/community/builds?q=macro",
      );
      expect(found.status).toBe(200);
      expect(found.body.items.length).toBeGreaterThan(0);

      const missed = await request(app).get(
        "/v1/community/builds?q=zzznonexistent",
      );
      expect(missed.status).toBe(200);
      expect(missed.body.items.length).toBe(0);
    });

    test("arcade-universe returns top-N from every matchup, not just top-by-votes globally", async () => {
      // Seed many high-vote PvX builds + a smaller number of ZvX / TvX
      // builds. The global-top-N path crowds Z/T out; the universe path
      // must surface at least one from each populated matchup so the
      // Stock Market spans the full meta, not just the dominant race.
      const seed = async (userSlug, title, matchup, votes) => {
        await services.customBuilds.upsert("u_a", {
          slug: userSlug,
          name: title,
          matchup,
          steps: [{ supply: 14, time: "0:18", action: "Pylon" }],
        });
        const r = await request(app)
          .post("/v1/community/builds")
          .set("authorization", "Bearer user-a")
          .send({ slug: userSlug, title, description: matchup });
        expect(r.status).toBe(201);
        // Stamp votes directly so we don't have to script vote casts.
        await db.communityBuilds.updateOne(
          { slug: r.body.slug },
          { $set: { votes } },
        );
      };
      // 15 PvX builds with high vote counts
      for (let i = 0; i < 15; i++) {
        await seed(`pvx-flood-${i}`, `PvX Flood ${i}`, "PvT", 1000 - i);
      }
      // One ZvP, one TvZ — both with low votes so they'd lose any global
      // top-100 sort
      await seed("zvp-rare", "ZvP Spire Rush", "ZvP", 1);
      await seed("tvz-rare", "TvZ Hellbat Drop", "TvZ", 2);

      const res = await request(app).get(
        "/v1/community/arcade-universe?perMatchup=3",
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      const matchups = new Set(res.body.items.map((b) => b.matchup));
      expect(matchups.has("PvT")).toBe(true);
      expect(matchups.has("ZvP")).toBe(true);
      expect(matchups.has("TvZ")).toBe(true);
      // PvT bucket must be capped at perMatchup=3 — it would otherwise
      // dominate the response.
      const pvtCount = res.body.items.filter((b) => b.matchup === "PvT").length;
      expect(pvtCount).toBe(3);
    });

    test("legacy private build fields are scrubbed from every public build read", async () => {
      const publicSlug = "legacy-public-sanitizer";
      const privateSlug = "private-source-never-public";
      const secretNote = "legacy-private-scouting-note";
      const sourceGameId = "private-replay-identity";
      await db.communityBuilds.insertOne({
        slug: publicSlug,
        ownerUserId: "u_legacy_public_owner",
        sourceSlug: privateSlug,
        title: "Legacy Public Boundary Fixture",
        description: "Public description",
        matchup: "LvL",
        authorName: "LegacyAuthor",
        votes: 9999,
        upvotes: ["private-voter"],
        downvotes: [],
        publishedAt: new Date("2026-08-13T13:00:00Z"),
        updatedAt: new Date("2026-08-13T13:00:00Z"),
        removed: false,
        build: {
          slug: privateSlug,
          name: "Safe build name",
          race: "Protoss",
          notes: secretNote,
          sourceGameId,
          userId: "private-internal-user",
          _id: "private-build-id",
          rules: [{ type: "before", name: "BuildPylon", time_lt: 30 }],
        },
      });

      try {
        // The controversial request runs the real Mongo aggregation and
        // regresses the formerly illegal mixed inclusion/exclusion project.
        const responses = [
          await request(app).get(
            "/v1/community/builds?q=Legacy%20Public%20Boundary%20Fixture",
          ),
          await request(app).get(
            "/v1/community/builds?sort=controversial&q=Legacy%20Public%20Boundary%20Fixture",
          ),
          await request(app).get(`/v1/community/builds/${publicSlug}`),
          await request(app).get(
            "/v1/community/arcade-universe?perMatchup=50&totalCap=500",
          ),
          await request(app).get(
            "/v1/community/authors/u_legacy_public_owner",
          ),
        ];

        for (const res of responses) {
          expect(res.status).toBe(200);
          const serialized = JSON.stringify(res.body);
          expect(serialized).not.toContain(privateSlug);
          expect(serialized).not.toContain(secretNote);
          expect(serialized).not.toContain(sourceGameId);
          expect(serialized).not.toContain("private-internal-user");
          expect(serialized).not.toContain("private-build-id");
          expect(serialized).not.toContain("private-voter");
        }

        const detail = responses[2].body;
        expect(detail.slug).toBe(publicSlug);
        expect(detail.build.name).toBe("Safe build name");
        expect(detail.build.slug).toBeUndefined();
        expect(detail.build.notes).toBeUndefined();
        expect(detail.build.sourceGameId).toBeUndefined();
        expect(detail.build.userId).toBeUndefined();
      } finally {
        await db.communityBuilds.deleteOne({ slug: publicSlug });
      }
    });

    test("creator-only community stats reflect durable replay classification", async () => {
      await db.games.insertOne({
        userId: "u_a",
        gameId: "community-classified-1",
        date: new Date("2026-08-13T12:00:00Z"),
        result: "Victory",
        _customBuildSlug: "my-build",
      });
      const mine = await request(app)
        .get("/v1/community/my-build-stats")
        .set("authorization", "Bearer user-a");
      expect(mine.status).toBe(200);
      expect(mine.body.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ total: 1, wins: 1, losses: 0 }),
        ]),
      );
      expect(mine.body.items[0].sourceSlug).toBeUndefined();

      const otherViewer = await request(app)
        .get("/v1/community/my-build-stats")
        .set("authorization", "Bearer user-b");
      expect(otherViewer.status).toBe(200);
      expect(otherViewer.body.items).toEqual([]);

      const publicList = await request(app).get("/v1/community/builds");
      expect(publicList.body.items[0].sourceSlug).toBeUndefined();
    });

    test("creator-only community stats include every published build beyond 200", async () => {
      const prefix = "owner-stats-over-200-";
      const sourcePrefix = "owner-source-over-200-";
      const fixtureCount = 205;
      const publishedAtBase = Date.parse("2027-01-01T00:00:00Z");
      await db.communityBuilds.insertMany(
        Array.from({ length: fixtureCount }, (_, i) => ({
          slug: `${prefix}${i}`,
          ownerUserId: "u_a",
          sourceSlug: `${sourcePrefix}${i}`,
          title: `Owner stats fixture ${i}`,
          votes: 0,
          publishedAt: new Date(publishedAtBase - i * 1000),
          removed: false,
        })),
      );
      await db.games.insertOne({
        userId: "u_a",
        gameId: "owner-stats-over-200-game",
        date: new Date("2027-01-01T00:00:00Z"),
        result: "Victory",
        _customBuildSlug: `${sourcePrefix}${fixtureCount - 1}`,
      });

      try {
        const res = await request(app)
          .get("/v1/community/my-build-stats")
          .set("authorization", "Bearer user-a");
        expect(res.status).toBe(200);
        const fixtureRows = res.body.items.filter((row) =>
          String(row.publicSlug).startsWith(prefix),
        );
        expect(fixtureRows).toHaveLength(fixtureCount);
        expect(fixtureRows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              publicSlug: `${prefix}${fixtureCount - 1}`,
              total: 1,
              wins: 1,
              losses: 0,
            }),
          ]),
        );
        expect(JSON.stringify(fixtureRows)).not.toContain(sourcePrefix);
      } finally {
        await db.games.deleteOne({ gameId: "owner-stats-over-200-game" });
        await db.communityBuilds.deleteMany({
          ownerUserId: "u_a",
          slug: { $regex: `^${prefix}` },
        });
      }
    });
  });

  describe("owner community removal", () => {
    async function publishRemovalFixture(sourceSlug) {
      await services.customBuilds.upsert("u_a", {
        slug: sourceSlug,
        name: "Owner Removal Test",
        matchup: "PvZ",
        notes: "keep this private source build",
        steps: [{ supply: 14, time: "0:18", action: "Pylon" }],
      });
      const pub = await services.community.publish("u_a", sourceSlug, {
        title: "Owner Removal Test",
      });
      return pub.slug;
    }

    test("hides ownership and leaves the listing live when another user tries to remove it", async () => {
      const sourceSlug = "owner-removal-authz";
      const publicSlug = await publishRemovalFixture(sourceSlug);

      const denied = await request(app)
        .delete(`/v1/community/builds/${publicSlug}`)
        .set("authorization", "Bearer user-b");
      expect(denied.status).toBe(404);
      expect(denied.body.error.code).toBe("not_found");

      const publicDetail = await request(app).get(
        `/v1/community/builds/${publicSlug}`,
      );
      expect(publicDetail.status).toBe(200);
      const privateBuild = await db.customBuilds.findOne({
        userId: "u_a",
        slug: sourceSlug,
      });
      expect(privateBuild.isPublic).toBe(true);
    });

    test("owner removal is idempotent and preserves the private source build", async () => {
      const sourceSlug = "owner-removal-idempotent";
      const publicSlug = await publishRemovalFixture(sourceSlug);
      await db.communityBuilds.updateOne(
        { slug: publicSlug },
        {
          $set: { votes: 7 },
          $addToSet: { upvotes: "u_existing_voter" },
        },
      );

      const first = await request(app)
        .delete(`/v1/community/builds/${publicSlug}`)
        .set("authorization", "Bearer user-a");
      expect(first.status).toBe(204);

      expect(
        (await request(app).get(`/v1/community/builds/${publicSlug}`)).status,
      ).toBe(404);
      const removed = await db.communityBuilds.findOne({ slug: publicSlug });
      expect(removed.removed).toBe(true);
      expect(removed.removedBy).toBe("u_a");
      expect(removed.removalReason).toBe("owner_unpublish");
      expect(removed.removedAt).toBeInstanceOf(Date);

      const privateBuild = await db.customBuilds.findOne({
        userId: "u_a",
        slug: sourceSlug,
      });
      expect(privateBuild).not.toBeNull();
      expect(privateBuild.deletedAt).toBeUndefined();
      expect(privateBuild.notes).toBe("keep this private source build");
      expect(privateBuild.isPublic).toBe(false);

      const removedAtMs = removed.removedAt.getTime();
      const second = await request(app)
        .delete(`/v1/community/builds/${publicSlug}`)
        .set("authorization", "Bearer user-a");
      expect(second.status).toBe(204);
      const afterSecond = await db.communityBuilds.findOne({
        slug: publicSlug,
      });
      expect(afterSecond.removedAt.getTime()).toBe(removedAtMs);

      const missing = await request(app)
        .delete("/v1/community/builds/does-not-exist")
        .set("authorization", "Bearer user-a");
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe("not_found");

      const republished = await services.community.publish(
        "u_a",
        sourceSlug,
        { title: "Owner Removal Test (restored)" },
      );
      expect(republished).toEqual({ slug: publicSlug, created: false });
      const restored = await db.communityBuilds.findOne({
        slug: publicSlug,
      });
      expect(restored.removed).toBe(false);
      expect(restored.votes).toBe(7);
      expect(restored.upvotes).toEqual(["u_existing_voter"]);
      const restoredPrivate = await db.customBuilds.findOne({
        userId: "u_a",
        slug: sourceSlug,
      });
      expect(restoredPrivate.isPublic).toBe(true);
    });

    test("legacy nested source slug remains available internally for unpublish", async () => {
      const sourceSlug = "legacy-unpublish-source";
      const publicSlug = await publishRemovalFixture(sourceSlug);
      // Simulate an old publication written before top-level sourceSlug was
      // durable. Public reads scrub build.slug, but owner removal still needs
      // this private, internal-only fallback to update the source build badge.
      await db.communityBuilds.updateOne(
        { slug: publicSlug },
        {
          $unset: { sourceSlug: "" },
          $set: { "build.slug": sourceSlug },
        },
      );

      try {
        const before = await request(app).get(
          `/v1/community/builds/${publicSlug}`,
        );
        expect(before.status).toBe(200);
        expect(before.body.build.slug).toBeUndefined();

        const removed = await request(app)
          .delete(`/v1/community/builds/${publicSlug}`)
          .set("authorization", "Bearer user-a");
        expect(removed.status).toBe(204);
        const privateBuild = await db.customBuilds.findOne({
          userId: "u_a",
          slug: sourceSlug,
        });
        expect(privateBuild.isPublic).toBe(false);
      } finally {
        await db.communityBuilds.deleteOne({ slug: publicSlug });
        await db.customBuilds.deleteOne({ userId: "u_a", slug: sourceSlug });
      }
    });

    test("moderation removal mirrors only the actual owner's private build", async () => {
      const ownerSourceSlug = "moderation-owner-build";
      const ownerPublicSlug = await publishRemovalFixture(ownerSourceSlug);
      const unrelatedUserId = "u_unrelated_owner";
      const unrelatedSourceSlug = "moderation-unrelated-build";
      await services.customBuilds.upsert(unrelatedUserId, {
        slug: unrelatedSourceSlug,
        name: "Unrelated Public Build",
        matchup: "TvP",
        notes: "must remain published",
        steps: [{ supply: 14, time: "0:18", action: "Supply Depot" }],
      });
      const unrelatedPublic = await services.community.publish(
        unrelatedUserId,
        unrelatedSourceSlug,
        { title: "Unrelated Public Build" },
      );
      const reportId = "report-moderation-owner-removal";
      await db.communityReports.insertOne({
        id: reportId,
        reporterUserId: "u_reporter",
        targetType: "build",
        targetId: ownerPublicSlug,
        reason: "moderation test",
        createdAt: new Date(),
        resolvedAt: null,
      });

      await services.community.resolveReport("u_admin", reportId, {
        action: "remove",
        note: "moderator_action",
      });

      const removedPublic = await db.communityBuilds.findOne({
        slug: ownerPublicSlug,
      });
      expect(removedPublic.removed).toBe(true);
      expect(removedPublic.removedBy).toBe("u_admin");
      expect(removedPublic.removalReason).toBe("moderator_action");
      const ownerPrivate = await db.customBuilds.findOne({
        userId: "u_a",
        slug: ownerSourceSlug,
      });
      expect(ownerPrivate.isPublic).toBe(false);

      const unrelatedPrivate = await db.customBuilds.findOne({
        userId: unrelatedUserId,
        slug: unrelatedSourceSlug,
      });
      expect(unrelatedPrivate.isPublic).toBe(true);
      const unrelatedCommunity = await db.communityBuilds.findOne({
        slug: unrelatedPublic.slug,
      });
      expect(unrelatedCommunity.removed).toBe(false);
    });
  });

  describe("public author profile (Phase 10)", () => {
    test("404 when the author has no public name on any build", async () => {
      // u_a's only published build above carries no authorName, so the
      // implicit anonymization rule yields a 404.
      const res = await request(app).get("/v1/community/authors/u_a");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("author_not_found");
    });

    test("returns aggregate after the author publishes with a name", async () => {
      await services.customBuilds.upsert("u_a", {
        slug: "named-build",
        name: "Glaive Adept Timing",
        race: "Protoss",
        matchup: "PvT",
      });
      const pub = await request(app)
        .post("/v1/community/builds")
        .set("authorization", "Bearer user-a")
        .send({
          slug: "named-build",
          title: "Glaive Adept Timing",
          description: "Punish 1-1-1.",
          authorName: "Reaver",
        });
      expect(pub.status).toBe(201);

      const res = await request(app).get("/v1/community/authors/u_a");
      expect(res.status).toBe(200);
      expect(res.body.userId).toBe("u_a");
      expect(res.body.displayName).toBe("Reaver");
      expect(Array.isArray(res.body.builds)).toBe(true);
      expect(res.body.builds.length).toBeGreaterThan(0);
      expect(typeof res.body.totalBuilds).toBe("number");
      expect(typeof res.body.totalVotes).toBe("number");
    });

    test("404 for unknown user id", async () => {
      const res = await request(app).get(
        "/v1/community/authors/u_does_not_exist",
      );
      expect(res.status).toBe(404);
    });
  });

  describe("k-anonymous opponent profile", () => {
    test("returns 404 when fewer than 5 contributors", async () => {
      // Seed games from 3 users vs the same opponent.
      const opp = "1-S2-2-99999";
      for (let i = 0; i < 3; i++) {
        const u = `user_${i}`;
        await services.games.upsert(u, {
          gameId: `g_${i}`,
          date: new Date().toISOString(),
          result: "Victory",
          myRace: "Protoss",
          map: "Goldenaura",
          durationSec: 600,
          opponent: { pulseId: opp, displayName: "x", race: "Terran" },
        });
      }
      const res = await request(app).get(
        `/v1/community/opponents/${encodeURIComponent(opp)}`,
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("k_anon_threshold_not_met");
    });

    test("returns aggregate when ≥ 5 contributors", async () => {
      const opp = "1-S2-2-77777";
      for (let i = 0; i < 6; i++) {
        const u = `user_kx_${i}`;
        await services.games.upsert(u, {
          gameId: `gkx_${i}`,
          date: new Date().toISOString(),
          result: i % 2 === 0 ? "Victory" : "Defeat",
          myRace: "Zerg",
          map: "Inside and Out",
          durationSec: 600,
          opponent: {
            pulseId: opp,
            displayName: "x",
            race: "Protoss",
            opening: "Phoenix",
          },
        });
      }
      const res = await request(app).get(
        `/v1/community/opponents/${encodeURIComponent(opp)}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.contributors).toBeGreaterThanOrEqual(5);
      expect(res.body.openings.Phoenix).toBeGreaterThan(0);
    });

    test("does not publish a capped sample dominated by one prolific user", async () => {
      const opp = "1-S2-2-k-anon-cap";
      const prolificCount = 20000;
      const rows = Array.from({ length: prolificCount }, (_, i) => ({
        userId: "a-prolific-user",
        gameId: `k-cap-prolific-${i}`,
        date: new Date(2026, 0, 1, 0, 0, 0, i),
        result: "Victory",
        map: "Privacy Test Map",
        opponent: { pulseId: opp, race: "Terran" },
      }));
      for (let i = 0; i < 4; i++) {
        rows.push({
          userId: `z-sparse-user-${i}`,
          gameId: `k-cap-sparse-${i}`,
          date: new Date(2025, 0, 1, 0, 0, i),
          result: "Defeat",
          map: "Privacy Test Map",
          opponent: { pulseId: opp, race: "Terran" },
        });
      }
      await db.games.insertMany(rows);

      try {
        // The full corpus has five distinct users, but the bounded query's
        // indexed order contains only the prolific user. The returned sample
        // must pass k-anonymity independently of the uncapped pre-check.
        const res = await request(app).get(
          `/v1/community/opponents/${encodeURIComponent(opp)}`,
        );
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("k_anon_threshold_not_met");
      } finally {
        await db.games.deleteMany({ "opponent.pulseId": opp });
      }
    }, 30000);
  });

  describe("community write protection", () => {
    test("publish rejects blocked terms and strips links from author names", async () => {
      await services.customBuilds.upsert("u_a", {
        slug: "filter-test-build",
        name: "Filter Test",
        race: "P",
        vsRace: "Z",
        steps: [],
      });
      await expect(
        services.community.publish("u_a", "filter-test-build", {
          title: "N1gg3r rush build",
          description: "",
          authorName: "",
        }),
      ).rejects.toThrow(/content_rejected/);

      const ok = await services.community.publish("u_a", "filter-test-build", {
        title: "Clean Title",
        description: "line1\n\n\n\nline2",
        authorName: "Author https://spam.example",
      });
      const row = await db.communityBuilds.findOne({ slug: ok.slug });
      expect(row.authorName).toBe("Author");
      expect(row.description).toBe("line1\n\nline2");
    });

    test("duplicate reports dedupe per (reporter, target)", async () => {
      const first = await services.community.report("u_a", {
        targetType: "build",
        targetId: "some-build",
        reason: "spam",
        note: "",
      });
      expect(first.alreadyReported).toBe(false);
      const second = await services.community.report("u_a", {
        targetType: "build",
        targetId: "some-build",
        reason: "spam again",
        note: "",
      });
      expect(second.alreadyReported).toBe(true);
      const rows = await db.communityReports.countDocuments({
        reporterUserId: "u_a",
        targetId: "some-build",
      });
      expect(rows).toBe(1);
    });
  });

  describe("GDPR export + delete", () => {
    test("export bundles per-user collections", async () => {
      await services.games.upsert("u_a", {
        gameId: "ga_export_test",
        date: new Date().toISOString(),
        result: "Victory",
        myRace: "Protoss",
        map: "Test Map",
      });

      const res = await request(app)
        .get("/v1/me/export")
        .set("authorization", "Bearer user-a");
      expect(res.status).toBe(200);
      expect(res.body.userId).toBe("u_a");
      expect(Array.isArray(res.body.data.games)).toBe(true);
      const myGame = res.body.data.games.find(
        (g) => g.gameId === "ga_export_test",
      );
      expect(myGame).toBeTruthy();
    });

    test("delete wipes per-user records", async () => {
      // Use a fresh user so we don't break the export test ordering.
      await db.users.insertOne({
        userId: "u_del",
        clerkUserId: "clerk_del",
        createdAt: new Date(),
        lastSeenAt: new Date(),
      });
      await services.games.upsert("u_del", {
        gameId: "g_to_be_deleted",
        date: new Date().toISOString(),
        result: "Defeat",
        myRace: "Terran",
        map: "M",
      });
      // Bypass the auth verify mock by calling the service directly,
      // since the integration test only knows clerk_user_a.
      const counts = await services.gdpr.deleteAll("u_del");
      expect(counts.games).toBeGreaterThanOrEqual(1);
      expect(counts.users).toBe(1);
      const after = await db.games.countDocuments({ userId: "u_del" });
      expect(after).toBe(0);
    });

    test("delete purges backups, community content, pairings, leaderboard + scrubs admin events", async () => {
      const userId = "u_del_full";
      const clerkUserId = "clerk_del_full";
      await db.users.insertOne({
        userId,
        clerkUserId,
        createdAt: new Date(),
        lastSeenAt: new Date(),
      });
      await services.games.upsert(userId, {
        gameId: "g_del_full",
        date: new Date().toISOString(),
        result: "Victory",
        myRace: "Zerg",
        map: "M",
      });

      // user_backups hold a FULL export blob — the most sensitive leak.
      await services.gdpr.snapshot(userId);
      expect(
        await db.db.collection("user_backups").countDocuments({ userId }),
      ).toBe(1);

      // Published community build owned by the user.
      await db.communityBuilds.insertOne({
        slug: "del-full-build",
        ownerUserId: userId,
        name: "Del Full Build",
        matchup: "ZvP",
        removed: false,
        votes: 0,
        createdAt: new Date(),
      });
      // A report they filed, a pairing they claimed, a leaderboard row.
      await db.communityReports.insertOne({
        id: "rep_del_full",
        reporterUserId: userId,
        targetType: "build",
        targetId: "someone-elses-build",
        createdAt: new Date(),
      });
      await db.devicePairings.insertOne({
        code: "990011",
        userId,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      await db.arcadeLeaderboard.insertOne({
        userId,
        weekKey: "2026-W28",
        pnlPct: 12.5,
        updatedAt: new Date(),
      });
      // Admin events carrying PII (email + clerk id).
      await db.adminEvents.insertOne({
        type: "user_signup",
        createdAt: new Date(),
        payload: {
          clerkUserId,
          userId,
          email: "delete-me@example.com",
          source: "test",
        },
      });

      const counts = await services.gdpr.deleteAll(userId);
      expect(counts.userBackups).toBe(1);
      expect(counts.communityBuilds).toBe(1);
      expect(counts.communityReports).toBe(1);
      expect(counts.devicePairings).toBe(1);
      expect(counts.arcadeLeaderboard).toBe(1);
      expect(counts.adminEventsScrubbed).toBe(1);

      expect(
        await db.db.collection("user_backups").countDocuments({ userId }),
      ).toBe(0);
      expect(
        await db.communityBuilds.countDocuments({ ownerUserId: userId }),
      ).toBe(0);
      expect(
        await db.communityReports.countDocuments({ reporterUserId: userId }),
      ).toBe(0);
      expect(await db.devicePairings.countDocuments({ userId })).toBe(0);
      expect(await db.arcadeLeaderboard.countDocuments({ userId })).toBe(0);
      expect(await db.gameDetails.countDocuments({ userId })).toBe(0);

      // Event row survives for aggregate stats, but the PII is gone.
      const ev = await db.adminEvents.findOne({
        "payload.userId": userId,
      });
      expect(ev).toBeTruthy();
      expect(ev.payload.email).toBeNull();
      expect(ev.payload.clerkUserId).toBeNull();
      expect(ev.anonymizedAt).toBeInstanceOf(Date);
    });

    test("wipeGames clears games + rebuilds opponents from the survivors", async () => {
      const userId = "u_wipe";
      await db.users.insertOne({
        userId,
        clerkUserId: "clerk_wipe",
        createdAt: new Date(),
        lastSeenAt: new Date(),
      });
      // Two games against the same opponent. recordGame is called once
      // per upload via the route layer; here we mirror that so the
      // opponents counter starts at 2 (the state we expect after a
      // normal upload flow).
      const oldDate = new Date("2024-01-01T00:00:00Z");
      const newDate = new Date("2026-04-01T00:00:00Z");
      const opponent = {
        pulseId: "p_wipe_1",
        displayName: "WipeFoe",
        race: "Zerg",
      };
      await services.games.upsert(userId, {
        gameId: "g_wipe_old",
        date: oldDate.toISOString(),
        result: "Victory",
        myRace: "Protoss",
        map: "M1",
        opponent,
      });
      await services.opponents.recordGame(userId, {
        ...opponent,
        result: "Victory",
        playedAt: oldDate,
      });
      await services.games.upsert(userId, {
        gameId: "g_wipe_new",
        date: newDate.toISOString(),
        result: "Defeat",
        myRace: "Protoss",
        map: "M2",
        opponent,
      });
      await services.opponents.recordGame(userId, {
        ...opponent,
        result: "Defeat",
        playedAt: newDate,
      });

      expect(await db.games.countDocuments({ userId })).toBe(2);
      const before = await db.opponents.findOne({ userId, pulseId: "p_wipe_1" });
      expect(before.gameCount).toBe(2);

      // Wipe just the OLD game (date < 2025-01-01).
      const partial = await services.gdpr.wipeGames(userId, {
        until: new Date("2025-01-01T00:00:00Z"),
      });
      expect(partial.games).toBe(1);
      expect(await db.games.countDocuments({ userId })).toBe(1);
      const afterPartial = await db.opponents.findOne({
        userId,
        pulseId: "p_wipe_1",
      });
      // Opponents got rebuilt from the surviving game — counters reset
      // to 1 (one defeat, zero wins) instead of being half-decremented.
      expect(afterPartial.gameCount).toBe(1);
      expect(afterPartial.losses).toBe(1);
      expect(afterPartial.wins).toBe(0);

      // Now wipe everything — opponents collection should empty out.
      const full = await services.gdpr.wipeGames(userId);
      expect(full.games).toBe(1);
      expect(await db.games.countDocuments({ userId })).toBe(0);
      expect(await db.opponents.countDocuments({ userId })).toBe(0);

      // User row stays intact — wipeGames is scoped, unlike deleteAll.
      const userRow = await db.users.findOne({ userId });
      expect(userRow).not.toBeNull();
    });
  });

  describe("admin gating", () => {
    test("non-admin → 403 on admin endpoints", async () => {
      const res = await request(app)
        .get("/v1/community/admin/reports")
        .set("authorization", "Bearer user-a");
      expect(res.status).toBe(403);
    });

    test("admin → 200 on admin endpoints", async () => {
      const res = await request(app)
        .get("/v1/community/admin/reports")
        .set("authorization", "Bearer admin-x");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
    });

    test("/v1/me reports isAdmin per the admin list", async () => {
      const nonAdmin = await request(app)
        .get("/v1/me")
        .set("authorization", "Bearer user-a");
      expect(nonAdmin.status).toBe(200);
      expect(nonAdmin.body.isAdmin).toBe(false);

      const admin = await request(app)
        .get("/v1/me")
        .set("authorization", "Bearer admin-x");
      expect(admin.status).toBe(200);
      expect(admin.body.isAdmin).toBe(true);
    });
  });
});
