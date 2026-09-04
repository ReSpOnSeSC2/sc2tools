// @ts-nocheck
"use strict";

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { CoachingService } = require("../src/services/coaching");

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
      displayName: "Profile Default",
      battleTag: "ProfileBattle#1234",
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

    test("publishes under the profile name by default and only anonymizes on explicit opt-in", async () => {
      await services.customBuilds.upsert("u_a", {
        slug: "identity-default-named",
        name: "Identity Default Named",
        race: "Protoss",
        vsRace: "Terran",
      });
      const named = await request(app)
        .post("/v1/community/builds")
        .set("authorization", "Bearer user-a")
        .send({ slug: "identity-default-named" });
      expect(named.status).toBe(201);
      const namedDetail = await request(app).get(
        `/v1/community/builds/${named.body.slug}`,
      );
      expect(namedDetail.body.authorName).toBe("Profile Default");
      expect(namedDetail.body.ownerUserId).toBe("u_a");

      await services.customBuilds.upsert("u_a", {
        slug: "identity-explicit-anonymous",
        name: "Identity Explicit Anonymous",
        race: "Zerg",
        vsRace: "Protoss",
      });
      const anonymous = await request(app)
        .post("/v1/community/builds")
        .set("authorization", "Bearer user-a")
        .send({
          slug: "identity-explicit-anonymous",
          publishAnonymously: true,
        });
      expect(anonymous.status).toBe(201);
      const anonymousDetail = await request(app).get(
        `/v1/community/builds/${anonymous.body.slug}`,
      );
      expect(anonymousDetail.body.authorName).toBe("");
      expect(anonymousDetail.body.ownerUserId).toBeUndefined();

      const settings = await request(app)
        .get("/v1/community/my-build-publication/identity-explicit-anonymous")
        .set("authorization", "Bearer user-a");
      expect(settings.status).toBe(200);
      expect(settings.body).toMatchObject({
        published: true,
        publicSlug: anonymous.body.slug,
        authorName: "Profile Default",
        publishAnonymously: true,
      });

      // A lightweight save/update that omits identity must preserve the
      // existing anonymous choice. The owner can explicitly switch it off.
      await services.community.publish("u_a", "identity-explicit-anonymous", {
        title: "Anonymous update",
      });
      expect(
        (await request(app).get(`/v1/community/builds/${anonymous.body.slug}`))
          .body.ownerUserId,
      ).toBeUndefined();
      await services.community.publish("u_a", "identity-explicit-anonymous", {
        publishAnonymously: false,
      });
      const switched = await request(app).get(
        `/v1/community/builds/${anonymous.body.slug}`,
      );
      expect(switched.body.authorName).toBe("Profile Default");
      expect(switched.body.ownerUserId).toBe("u_a");
    });

    test("retries a transient private Published-badge mirror after the public commit", async () => {
      const sourceSlug = "identity-mirror-rollback";
      await services.customBuilds.upsert("u_a", {
        slug: sourceSlug,
        name: "Identity Mirror Rollback",
        race: "Terran",
        vsRace: "Zerg",
      });
      jest
        .spyOn(services.community, "_setPrivateIsPublic")
        .mockRejectedValueOnce(new Error("private_mirror_failed"));

      const publish = await request(app)
        .post("/v1/community/builds")
        .set("authorization", "Bearer user-a")
        .send({ slug: sourceSlug });
      expect(publish.status).toBe(201);
      expect(
        await db.communityBuilds.countDocuments({
          ownerUserId: "u_a",
          sourceSlug,
        }),
      ).toBe(1);
      const privateBuild = await db.customBuilds.findOne({
        userId: "u_a",
        slug: sourceSlug,
      });
      expect(privateBuild.isPublic).toBe(true);
    });

    test("serializes concurrent first publishes on one opaque source reservation", async () => {
      const sourceSlug = "private-source-must-not-leak";
      await services.customBuilds.upsert("u_a", {
        slug: sourceSlug,
        name: "Concurrent source",
        race: "Protoss",
        vsRace: "Zerg",
      });
      const [first, second] = await Promise.all([
        services.community.publish("u_a", sourceSlug, {
          title: "First public title",
          description: "Initial description",
        }),
        services.community.publish("u_a", sourceSlug, {
          title: "Different concurrent title",
        }),
      ]);
      expect(first.slug).toBe(second.slug);
      expect(first.slug).toMatch(/^build-[a-f0-9]{32}(?:-\d+)?$/);
      expect(first.slug).not.toContain(sourceSlug);
      expect(
        await db.communityBuilds.countDocuments({ ownerUserId: "u_a", sourceSlug }),
      ).toBe(1);

      const renamed = await services.community.publish("u_a", sourceSlug, {
        title: "Renamed later",
        description: "",
      });
      expect(renamed.slug).toBe(first.slug);
      expect((await services.community.getPublic(first.slug)).description).toBe("");
    });

    test("reports committed-public success when the private mirror stays pending", async () => {
      const sourceSlug = "identity-mirror-compensation-failure";
      await services.customBuilds.upsert("u_a", {
        slug: sourceSlug,
        name: "Identity Mirror Compensation Failure",
        race: "Zerg",
        vsRace: "Terran",
      });
      const mirrorSpy = jest
        .spyOn(services.community, "_setPrivateIsPublic")
        .mockRejectedValue(new Error("private_mirror_failed"));

      const publish = await request(app)
        .post("/v1/community/builds")
        .set("authorization", "Bearer user-a")
        .send({ slug: sourceSlug });
      expect(publish.status).toBe(201);
      expect(publish.body).toMatchObject({
        created: true,
        mirrorPending: true,
      });
      const live = await request(app).get(
        `/v1/community/builds/${publish.body.slug}`,
      );
      expect(live.status).toBe(200);
      expect(live.body.authorName).toBe("Profile Default");
      const settings = await request(app)
        .get(`/v1/community/my-build-publication/${sourceSlug}`)
        .set("authorization", "Bearer user-a");
      expect(settings.body.mirrorPending).toBe(true);
      mirrorSpy.mockRestore();
    });

    test("recognizes publish and removal commits when Mongo reports a late error", async () => {
      const sourceSlug = "late-commit-confirmation";
      await services.customBuilds.upsert("u_a", {
        slug: sourceSlug,
        name: "Late commit confirmation",
        race: "Terran",
        vsRace: "Protoss",
      });
      const originalUpdateOne = db.communityBuilds.updateOne.bind(
        db.communityBuilds,
      );
      const publishWrite = jest
        .spyOn(db.communityBuilds, "updateOne")
        .mockImplementationOnce(async (...args) => {
          await originalUpdateOne(...args);
          throw new Error("network_closed_after_commit");
        });
      const published = await services.community.publish("u_a", sourceSlug, {});
      publishWrite.mockRestore();
      expect((await services.community.getPublic(published.slug)).slug).toBe(
        published.slug,
      );

      const originalUpdateMany = db.communityBuilds.updateMany.bind(
        db.communityBuilds,
      );
      const removeWrite = jest
        .spyOn(db.communityBuilds, "updateMany")
        .mockImplementationOnce(async (...args) => {
          await originalUpdateMany(...args);
          throw new Error("network_closed_after_commit");
        });
      const removed = await services.community.unpublishBySource(
        "u_a",
        sourceSlug,
      );
      removeWrite.mockRestore();
      expect(removed.removed).toBe(true);
      expect(await services.community.getPublic(published.slug)).toBeNull();
    });

    test("preserves legacy identity rows with no mode flag and falls back to BattleTag safely", async () => {
      const ownerUserId = "u_legacy_identity_modes";
      const anonymousSource = "legacy-anonymous-source";
      const namedSource = "legacy-named-source";
      const nestedAnonymousSource = "legacy-nested-anonymous-source";
      await db.users.insertOne({
        userId: ownerUserId,
        displayName: "Legacy Profile",
        createdAt: new Date(),
      });
      await services.customBuilds.upsert(ownerUserId, {
        slug: anonymousSource,
        name: "Legacy anonymous",
        race: "Protoss",
      });
      await services.customBuilds.upsert(ownerUserId, {
        slug: namedSource,
        name: "Legacy named",
        race: "Terran",
      });
      await services.customBuilds.upsert(ownerUserId, {
        slug: nestedAnonymousSource,
        name: "Legacy nested anonymous",
        race: "Zerg",
      });
      await db.communityBuilds.insertMany([
        {
          slug: "legacy-anonymous-public",
          ownerUserId,
          sourceSlug: anonymousSource,
          title: "Legacy anonymous",
          authorName: "",
          votes: 0,
          publishedAt: new Date(),
          updatedAt: new Date(),
          removed: false,
          build: { name: "Legacy anonymous", race: "Protoss" },
        },
        {
          slug: "legacy-named-public",
          ownerUserId,
          sourceSlug: namedSource,
          title: "Legacy named",
          authorName: "Old Handle",
          votes: 0,
          publishedAt: new Date(),
          updatedAt: new Date(),
          removed: false,
          build: { name: "Legacy named", race: "Terran" },
        },
        {
          slug: "legacy-nested-anonymous-public",
          ownerUserId,
          title: "Legacy nested anonymous",
          authorName: "",
          votes: 0,
          publishedAt: new Date(),
          updatedAt: new Date(),
          removed: false,
          build: {
            slug: nestedAnonymousSource,
            name: "Legacy nested anonymous",
            race: "Zerg",
          },
        },
      ]);
      try {
        expect(
          await services.community.getOwnerPublicationSettings(
            ownerUserId,
            anonymousSource,
          ),
        ).toMatchObject({
          authorName: "Legacy Profile",
          publishAnonymously: true,
        });
        expect(
          await services.community.getOwnerPublicationSettings(
            ownerUserId,
            namedSource,
          ),
        ).toMatchObject({
          authorName: "Old Handle",
          publishAnonymously: false,
        });
        await services.community.publish(ownerUserId, anonymousSource, {
          title: "Legacy anonymous updated",
        });
        const anonymousPublic = await services.community.getPublic(
          "legacy-anonymous-public",
        );
        expect(anonymousPublic.authorName).toBe("");
        expect(anonymousPublic.ownerUserId).toBeUndefined();

        expect(
          await services.community.getOwnerPublicationSettings(
            ownerUserId,
            nestedAnonymousSource,
          ),
        ).toMatchObject({
          published: true,
          publishAnonymously: true,
        });
        const ownerStats = await services.community.listOwnerReplayStats(ownerUserId);
        expect(ownerStats).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              publicSlug: "legacy-nested-anonymous-public",
              total: 0,
            }),
          ]),
        );
        const nestedRepublished = await services.community.publish(
          ownerUserId,
          nestedAnonymousSource,
          { title: "Legacy nested anonymous updated" },
        );
        expect(nestedRepublished.slug).toBe("legacy-nested-anonymous-public");
        expect(
          (await services.community.getPublic(nestedRepublished.slug)).ownerUserId,
        ).toBeUndefined();
        expect(
          await db.communityBuilds.countDocuments({
            ownerUserId,
            $or: [
              { sourceSlug: nestedAnonymousSource },
              { "build.slug": nestedAnonymousSource },
            ],
          }),
        ).toBe(1);
        await services.community.unpublishBySource(ownerUserId, nestedAnonymousSource);
        expect(
          await db.communityBuilds.countDocuments({
            ownerUserId,
            sourceSlug: nestedAnonymousSource,
            removed: false,
          }),
        ).toBe(0);
      } finally {
        await db.communityBuilds.deleteMany({ ownerUserId });
        await db.customBuilds.deleteMany({ userId: ownerUserId });
        await db.users.deleteOne({ userId: ownerUserId });
      }

      const battleOwner = "u_battle_tag_fallback";
      await db.users.insertOne({
        userId: battleOwner,
        battleTag: "BattleFallback#9876",
        createdAt: new Date(),
      });
      await services.customBuilds.upsert(battleOwner, {
        slug: "battle-fallback-source",
        name: "Battle fallback build",
        race: "Zerg",
      });
      try {
        const published = await services.community.publish(
          battleOwner,
          "battle-fallback-source",
          {},
        );
        expect(
          (await services.community.getPublic(published.slug)).authorName,
        ).toBe("BattleFallback");
      } finally {
        await db.communityBuilds.deleteMany({ ownerUserId: battleOwner });
        await db.customBuilds.deleteMany({ userId: battleOwner });
        await db.users.deleteOne({ userId: battleOwner });
      }
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
      // Eight PvX builds with high vote counts are enough to exercise the
      // per-matchup cap without exhausting the per-user publish limiter used
      // by the identity-route regressions in this same integration app.
      for (let i = 0; i < 8; i++) {
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
      await db.games.insertOne({
        userId: "u_a",
        gameId: "community-classified-opponent-1",
        date: new Date("2026-08-13T12:01:00Z"),
        result: "Defeat",
        _customOpponentStrategySlug: "my-build",
      });
      const mine = await request(app)
        .get("/v1/community/my-build-stats")
        .set("authorization", "Bearer user-a");
      expect(mine.status).toBe(200);
      expect(mine.body.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ total: 2, wins: 1, losses: 1 }),
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
        {
          title: "Unrelated Public Build",
          authorName: "Unrelated Author",
        },
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
      const anonymousOwner = "u_only_anonymous";
      await db.communityBuilds.insertOne({
        slug: "only-anonymous-profile-fixture",
        ownerUserId: anonymousOwner,
        sourceSlug: "only-anonymous-source",
        title: "Anonymous only",
        authorName: "",
        publishAnonymously: true,
        votes: 3,
        publishedAt: new Date(),
        removed: false,
        build: { name: "Anonymous only", race: "Terran" },
      });
      try {
        const res = await request(app).get(
          `/v1/community/authors/${anonymousOwner}`,
        );
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("author_not_found");
      } finally {
        await db.communityBuilds.deleteOne({
          slug: "only-anonymous-profile-fixture",
        });
      }
    });

    test("a named profile never includes the same owner's anonymous builds or stats", async () => {
      const ownerUserId = "u_mixed_identity";
      await db.communityBuilds.insertMany([
        {
          slug: "mixed-named-build",
          ownerUserId,
          sourceSlug: "mixed-named-source",
          title: "Mixed named build",
          authorName: "Named Author",
          publishAnonymously: false,
          votes: 4,
          publishedAt: new Date("2026-08-10T00:00:00Z"),
          removed: false,
          build: { name: "Mixed named build", race: "Protoss" },
        },
        {
          slug: "mixed-anonymous-build",
          ownerUserId,
          sourceSlug: "mixed-anonymous-source",
          title: "Mixed anonymous build",
          authorName: "",
          publishAnonymously: true,
          votes: 999,
          publishedAt: new Date("2026-08-11T00:00:00Z"),
          removed: false,
          build: { name: "Mixed anonymous build", race: "Zerg" },
        },
      ]);
      try {
        const res = await request(app).get(
          `/v1/community/authors/${ownerUserId}`,
        );
        expect(res.status).toBe(200);
        expect(res.body.displayName).toBe("Named Author");
        expect(res.body.totalBuilds).toBe(1);
        expect(res.body.totalVotes).toBe(4);
        expect(res.body.builds.map((build) => build.slug)).toEqual([
          "mixed-named-build",
        ]);
        expect(res.body.topBuild.slug).toBe("mixed-named-build");
        expect(res.body.recent.map((build) => build.slug)).not.toContain(
          "mixed-anonymous-build",
        );
      } finally {
        await db.communityBuilds.deleteMany({ ownerUserId });
      }
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
      await db.coaching.updateOne(
        { _id: "locker" },
        {
          $set: {
            state: {
              coaches: [
                {
                  id: "coach-export",
                  name: "Coach",
                  userId: "u_coach",
                  email: "coach-private@example.test",
                },
                { id: "coach-other", name: "Other", userId: "u_other_coach" },
              ],
              students: [
                { id: "student-export", name: "Player", userId: "u_a", coachId: "coach-export" },
                { id: "student-other", name: "Private", userId: "u_other", coachId: "coach-other" },
              ],
            },
          },
        },
        { upsert: true },
      );
      await db.coaching.insertMany([
        {
          _id: "assignment:export-mine",
          kind: "game_requirement",
          id: "export-mine",
          studentUserId: "u_a",
          coachUserId: "u_coach",
          practiceSharingGrantId: "grant-must-not-export",
          note: "My exported practice note",
        },
        {
          _id: "assignment:export-other",
          kind: "game_requirement",
          id: "export-other",
          studentUserId: "u_other",
          coachUserId: "u_other_coach",
          note: "Must not leak",
        },
        {
          _id: "calendar:coach-export",
          coachId: "coach-export",
          coachName: "Coach",
          coachUserId: "u_coach",
          availability: { timeZone: "UTC", durations: [60], windows: [] },
          bookings: [
            {
              id: "booking-mine",
              studentId: "student-export",
              studentUserId: "u_a",
              studentName: "Player",
              status: "booked",
            },
            {
              id: "booking-other",
              studentId: "student-other",
              studentUserId: "u_other",
              studentName: "Private",
              status: "booked",
            },
          ],
        },
      ]);

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
      expect(res.body.data.coachingAssignments).toEqual([
        expect.objectContaining({ id: "export-mine", note: "My exported practice note" }),
      ]);
      expect(res.body.data.coachingRelationships).toEqual([
        expect.objectContaining({
          role: "student",
          student: expect.objectContaining({ id: "student-export", userId: "u_a" }),
          coach: { id: "coach-export", name: "Coach" },
        }),
      ]);
      expect(res.body.data.coachingCalendars).toEqual([
        {
          role: "student",
          calendar: expect.objectContaining({
            coachId: "coach-export",
            bookings: [expect.objectContaining({ id: "booking-mine", studentUserId: "u_a" })],
          }),
        },
      ]);
      expect(JSON.stringify(res.body.data)).not.toContain("Must not leak");
      expect(JSON.stringify(res.body.data)).not.toContain("student-other");
      expect(JSON.stringify(res.body.data)).not.toContain("booking-other");
      expect(JSON.stringify(res.body.data)).not.toContain("coach-private@example.test");

      const coachExport = await services.gdpr.export("u_coach");
      expect(coachExport.data.coachingAssignments).toEqual([
        expect.objectContaining({ id: "export-mine" }),
      ]);
      expect(coachExport.data.coachingAssignments[0]).not.toHaveProperty("studentUserId");
      expect(coachExport.data.coachingAssignments[0]).not.toHaveProperty("practiceSharingGrantId");
      expect(coachExport.data.coachingCalendars).toHaveLength(1);
      expect(coachExport.data.coachingCalendars[0]).toMatchObject({
        role: "coach",
        calendar: { coachId: "coach-export" },
      });
      expect(JSON.stringify(coachExport.data.coachingCalendars)).not.toContain("u_a");
      expect(JSON.stringify(coachExport.data.coachingCalendars)).not.toContain("grant-must-not-export");
      expect(JSON.stringify(coachExport.data.coachingRelationships)).not.toContain("u_a");
    });

    test("manual snapshots exclude non-restorable shared coaching data", async () => {
      const userId = "u_snapshot_coaching";
      await db.users.insertOne({
        userId,
        clerkUserId: "clerk_snapshot_coaching",
        createdAt: new Date(),
        lastSeenAt: new Date(),
      });
      await db.coaching.insertOne({
        _id: "assignment:snapshot-shared",
        kind: "game_requirement",
        id: "snapshot-shared",
        studentUserId: userId,
        coachUserId: "u_coach",
      });

      const snapshot = await services.gdpr.snapshot(userId);
      const stored = await db.db.collection("user_backups").findOne({ id: snapshot.id });

      expect(stored.payload.data).not.toHaveProperty("coachingAssignments");
      expect(stored.payload.data).not.toHaveProperty("coachingRelationships");
      expect(stored.payload.data).not.toHaveProperty("coachingCalendars");
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

    test("delete erases coaching relationships and preserves unrelated data", async () => {
      const userId = "u_del_coaching";
      const clerkUserId = "clerk_del_coaching";
      await db.users.insertOne({
        userId,
        clerkUserId,
        createdAt: new Date(),
        lastSeenAt: new Date(),
      });
      await db.coaching.updateOne(
        { _id: "locker" },
        {
          $set: {
            rev: 40,
            state: {
              coaches: [
                { id: "coach-delete", name: "Delete Coach", userId },
                { id: "coach-keep", name: "Keep Coach", userId: "u_keep_coach" },
              ],
              students: [
                {
                  id: "student-delete",
                  name: "Delete Student",
                  userId,
                  coachId: "coach-keep",
                  shelf: [
                    { asset: "asset-delete-only" },
                    { asset: "asset-shared" },
                  ],
                  practiceSharing: {
                    status: "accepted",
                    studentUserId: userId,
                    coachUserId: "u_keep_coach",
                    grantId: "grant-delete-student",
                  },
                },
                {
                  id: "student-of-deleted-coach",
                  name: "Linked Student",
                  userId: "u_linked_student",
                  coachId: "coach-delete",
                  practiceSharing: {
                    status: "accepted",
                    studentUserId: "u_linked_student",
                    coachUserId: userId,
                    grantId: "grant-delete-coach",
                  },
                },
                {
                  id: "student-keep",
                  name: "Keep Student",
                  userId: "u_keep_student",
                  coachId: "coach-keep",
                  shelf: [
                    { asset: "asset-shared" },
                    { asset: "asset-keep" },
                  ],
                  practiceSharing: {
                    status: "accepted",
                    studentUserId: "u_keep_student",
                    coachUserId: "u_keep_coach",
                    grantId: "grant-keep",
                  },
                },
              ],
              assets: {
                "asset-delete-only": { n: "private-replay.SC2Replay", b64: "private" },
                "asset-shared": { n: "shared.pdf", b64: "shared" },
                "asset-keep": { n: "keep.pdf", b64: "keep" },
              },
            },
          },
        },
        { upsert: true },
      );
      await db.coaching.insertMany([
        {
          _id: "assignment:delete-as-student",
          kind: "game_requirement",
          studentUserId: userId,
          coachUserId: "u_keep_coach",
          createdByUserId: "u_keep_coach",
        },
        {
          _id: "assignment:delete-as-coach",
          kind: "game_requirement",
          studentUserId: "u_linked_student",
          coachUserId: userId,
          createdByUserId: userId,
        },
        {
          _id: "assignment:delete-as-creator",
          kind: "game_requirement",
          studentUserId: "u_keep_student",
          coachUserId: "u_keep_coach",
          createdByUserId: userId,
        },
        {
          _id: "assignment:keep",
          kind: "game_requirement",
          studentUserId: "u_keep_student",
          coachUserId: "u_keep_coach",
          createdByUserId: "u_keep_coach",
        },
        {
          _id: "calendar:delete-owned",
          coachId: "coach-delete",
          coachUserId: userId,
          calendarRev: 2,
          bookings: [],
        },
        {
          _id: "calendar:delete-owned-legacy",
          coachId: "coach-delete",
          calendarRev: 1,
          bookings: [],
        },
        {
          _id: "calendar:keep",
          coachId: "coach-keep",
          coachUserId: "u_keep_coach",
          calendarRev: 7,
          bookings: [
            {
              id: "booking-delete-by-user",
              studentId: "student-delete",
              studentUserId: userId,
            },
            {
              id: "booking-delete-legacy-id",
              studentId: "student-delete",
            },
            {
              id: "booking-keep",
              studentId: "student-keep",
              studentUserId: "u_keep_student",
            },
          ],
        },
        {
          _id: "coaching-misc-keep",
          kind: "other",
          marker: "unrelated",
          coachUserId: userId,
          createdByUserId: userId,
          studentUserId: "u_keep_student",
        },
      ]);

      // Simulate already-authorized writes committing immediately after the
      // first cleanup pass. deleteAll's final deterministic pass must remove
      // all of them before the account row disappears.
      const cleanup = services.gdpr._deleteCoachingData.bind(services.gdpr);
      let cleanupPasses = 0;
      const cleanupSpy = jest.spyOn(services.gdpr, "_deleteCoachingData")
        .mockImplementation(async (...args) => {
          const result = await cleanup(...args);
          cleanupPasses += 1;
          if (cleanupPasses === 1) {
            await db.coaching.insertMany([
              {
                _id: "assignment:delete-late",
                kind: "game_requirement",
                studentUserId: "u_linked_late",
                coachUserId: userId,
                createdByUserId: userId,
              },
              {
                _id: "calendar:delete-owned-late",
                coachId: "coach-delete-late",
                coachUserId: userId,
                calendarRev: 0,
                bookings: [],
              },
            ]);
            await db.coaching.updateOne(
              { _id: "calendar:keep" },
              { $push: { bookings: {
                id: "booking-delete-late",
                studentId: "student-delete-late",
                studentUserId: userId,
              } } },
            );
            await db.coaching.updateOne(
              { _id: "locker" },
              {
                $push: {
                  "state.coaches": {
                    id: "coach-delete-late",
                    name: "Late Coach",
                    userId,
                  },
                  "state.students": {
                    id: "student-of-late-coach",
                    name: "Late Linked Student",
                    userId: "u_linked_late",
                    coachId: "coach-delete-late",
                    practiceSharing: {
                      status: "accepted",
                      studentUserId: "u_linked_late",
                      coachUserId: userId,
                      grantId: "grant-delete-late",
                    },
                  },
                },
              },
            );
          }
          return result;
        });
      let counts;
      try {
        counts = await services.gdpr.deleteAll(userId);
      } finally {
        cleanupSpy.mockRestore();
      }
      expect(cleanupPasses).toBe(2);
      expect(counts.coachingAssignments).toBe(4);
      expect(counts.coachingCalendars).toBe(3);
      expect(counts.coachingCalendarsScrubbed).toBe(2);
      expect(counts.coachingLockerScrubbed).toBe(4);
      expect(counts.coachingAssets).toBe(1);
      expect(counts.coachingUnknownReferencesScrubbed).toBe(2);

      const locker = await db.coaching.findOne({ _id: "locker" });
      expect(locker.state.coaches).toEqual([
        { id: "coach-keep", name: "Keep Coach", userId: "u_keep_coach" },
      ]);
      expect(locker.state.students.map((student) => student.id)).toEqual([
        "student-of-deleted-coach",
        "student-keep",
        "student-of-late-coach",
      ]);
      const severedStudents = locker.state.students.filter((student) =>
        student.id === "student-of-deleted-coach"
        || student.id === "student-of-late-coach");
      expect(severedStudents).toHaveLength(2);
      for (const student of severedStudents) {
        expect(student).not.toHaveProperty("coachId");
        expect(student).not.toHaveProperty("practiceSharing");
      }
      expect(locker.state.assets).toEqual({
        "asset-shared": { n: "shared.pdf", b64: "shared" },
        "asset-keep": { n: "keep.pdf", b64: "keep" },
      });
      expect(JSON.stringify(locker)).not.toContain(userId);
      expect(JSON.stringify(locker)).not.toContain("grant-delete");

      expect(await db.coaching.countDocuments({
        kind: "game_requirement",
        $or: [
          { studentUserId: userId },
          { coachUserId: userId },
          { createdByUserId: userId },
        ],
      })).toBe(0);
      expect(await db.coaching.findOne({ _id: "assignment:keep" })).toBeTruthy();
      expect(await db.coaching.findOne({ _id: "calendar:delete-owned" })).toBeNull();
      expect(await db.coaching.findOne({ _id: "calendar:delete-owned-legacy" })).toBeNull();
      expect(await db.coaching.findOne({ _id: "calendar:delete-owned-late" })).toBeNull();
      const keptCalendar = await db.coaching.findOne({ _id: "calendar:keep" });
      expect(keptCalendar.bookings).toEqual([
        expect.objectContaining({ id: "booking-keep", studentUserId: "u_keep_student" }),
      ]);
      expect(keptCalendar.calendarRev).toBe(9);
      const misc = await db.coaching.findOne({ _id: "coaching-misc-keep" });
      expect(misc).toMatchObject({
        kind: "other",
        marker: "unrelated",
        studentUserId: "u_keep_student",
      });
      expect(misc).not.toHaveProperty("coachUserId");
      expect(misc).not.toHaveProperty("createdByUserId");

      // Re-provisioning the same internal id simulates a retry after the first
      // operation completed; every coaching cleanup becomes a safe no-op.
      await db.users.insertOne({
        userId,
        clerkUserId,
        createdAt: new Date(),
        lastSeenAt: new Date(),
      });
      const retry = await services.gdpr.deleteAll(userId);
      expect(retry.coachingAssignments).toBe(0);
      expect(retry.coachingCalendars).toBe(0);
      expect(retry.coachingCalendarsScrubbed).toBe(0);
      expect(retry.coachingLockerScrubbed).toBe(0);
      expect(retry.coachingAssets).toBe(0);
      expect(retry.coachingUnknownReferencesScrubbed).toBe(0);
      expect(await db.coaching.findOne({ _id: "assignment:keep" })).toBeTruthy();
      expect((await db.coaching.findOne({ _id: "calendar:keep" })).bookings).toHaveLength(1);
    });

    test("delete drains an active coaching writer before its final cleanup", async () => {
      const userId = "u_del_coaching_race";
      await db.users.insertOne({
        userId,
        clerkUserId: "clerk_del_coaching_race",
        createdAt: new Date(),
        lastSeenAt: new Date(),
      });
      let writerEntered;
      const entered = new Promise((resolve) => { writerEntered = resolve; });
      let resumeWriter;
      const resume = new Promise((resolve) => { resumeWriter = resolve; });
      const coaching = new CoachingService({ db });
      const writer = coaching._withCoachingMutation([userId], async () => {
        writerEntered();
        await resume;
        await db.coaching.insertOne({
          _id: "assignment:delete-race",
          kind: "game_requirement",
          studentUserId: userId,
          coachUserId: "u_keep_coach",
          createdByUserId: "u_keep_coach",
        });
      });
      await entered;

      const deletion = services.gdpr.deleteAll(userId);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const fenced = await db.users.findOne({ userId });
      expect(fenced._coachingMutations).toHaveLength(1);
      expect(fenced).not.toHaveProperty("_gdprMutation");

      resumeWriter();
      await writer;
      const counts = await deletion;
      expect(counts.coachingAssignments).toBe(1);
      expect(counts.users).toBe(1);
      expect(await db.coaching.findOne({ _id: "assignment:delete-race" })).toBeNull();
      expect(await db.users.findOne({ userId })).toBeNull();
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

    test("sequential account deletions anonymize every signup event", async () => {
      const accounts = [
        {
          userId: "u_del_signup_one",
          clerkUserId: "clerk_del_signup_one",
          email: "delete-one@example.com",
        },
        {
          userId: "u_del_signup_two",
          clerkUserId: "clerk_del_signup_two",
          email: "delete-two@example.com",
        },
      ];
      const now = new Date();
      await db.users.insertMany(
        accounts.map(({ userId, clerkUserId }) => ({
          userId,
          clerkUserId,
          createdAt: now,
          lastSeenAt: now,
        })),
      );
      await db.adminEvents.insertMany(
        accounts.map(({ userId, clerkUserId, email }, index) => ({
          eventId: `signup-delete-${index + 1}`,
          type: "user_signup",
          createdAt: now,
          readAt: null,
          payload: { clerkUserId, userId, email, source: "test" },
        })),
      );

      for (const account of accounts) {
        const counts = await services.gdpr.deleteAll(account.userId);
        expect(counts.users).toBe(1);
        expect(counts.adminEventsScrubbed).toBe(1);
      }

      const events = await db.adminEvents
        .find({ eventId: { $in: ["signup-delete-1", "signup-delete-2"] } })
        .sort({ eventId: 1 })
        .toArray();
      expect(events).toHaveLength(2);
      for (const event of events) {
        expect(event.payload.email).toBeNull();
        expect(event.payload.clerkUserId).toBeNull();
        expect(event.anonymizedAt).toBeInstanceOf(Date);
      }
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
