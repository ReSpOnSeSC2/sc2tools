// @ts-nocheck
/* eslint-disable max-lines-per-function */
"use strict";

/**
 * Build library safety and community trust, through the full app (real
 * Mongo, real routes, mocked Clerk):
 *  - version history: every save keeps the replaced version (20 per
 *    build), "Restore this version" goes through the normal save;
 *  - the 30-day trash: restore brings a published build back privately,
 *    the purge hard-deletes expired builds with their history;
 *  - pin/tags and the library filters (pinned first, 400 on bad values,
 *    cursors scoped per filter set);
 *  - import (preview, skip/copy/overwrite, validation, 500 cap) and export;
 *  - community: one save per account, versions bumped by content edits,
 *    "Apply update" keeping the saver's notes and skill level, the author
 *    record hidden by default, "Most saved" sort.
 */

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { CustomBuildLibraryService } = require("../src/services/customBuildLibrary");
const { buildCustomBuildTrashPurgeJob } = require("../src/jobs/customBuildTrashPurgeJob");

const TOKENS = { author: "clerk_lib_author", saver: "clerk_lib_saver", third: "clerk_lib_third" };

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    const subs = { author: "clerk_lib_author", saver: "clerk_lib_saver", third: "clerk_lib_third" };
    if (subs[token]) return { sub: subs[token] };
    throw new Error("invalid");
  }),
}));

const DAY_MS = 24 * 60 * 60 * 1000;

describe("custom build library and community trust", () => {
  let mongo;
  let db;
  let app;
  let services;
  const ids = {};

  const config = {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    mongoUri: "",
    mongoDb: "sc2tools_test_build_library",
    clerkSecretKey: "sk_test",
    clerkJwtIssuer: undefined,
    clerkJwtAudience: undefined,
    serverPepper: Buffer.alloc(32, 5),
    corsAllowedOrigins: [],
    rateLimitPerMinute: 10_000,
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
    services = built.services;
    for (const who of Object.keys(TOKENS)) {
      const me = await as(who, request(app).get("/v1/me")).expect(200);
      ids[who] = me.body.userId;
    }
    await db.users.updateOne({ userId: ids.author }, { $set: { displayName: "Library Author" } });
  });

  afterAll(async () => {
    if (services?.customBuilds) await services.customBuilds.stopReclassifications();
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.customBuilds.deleteMany({});
    await db.customBuildRevisions.deleteMany({});
    await db.communityBuilds.deleteMany({});
    await db.communitySaves.deleteMany({});
  });

  function as(who, req) {
    return req.set("authorization", `Bearer ${who}`);
  }

  const build = (extra = {}) => ({
    name: "Stargate Opener",
    race: "Protoss",
    vsRace: "Zerg",
    description: "Phoenix first",
    notes: "my notes",
    rules: [{ type: "before", name: "BuildStargate", time_lt: 240 }],
    reclassify: false,
    ...extra,
  });
  const put = (who, slug, body) => as(who, request(app).put(`/v1/custom-builds/${slug}`).send(body));
  const get = (who, path) => as(who, request(app).get(`/v1${path}`));
  const post = (who, path, body = {}) => as(who, request(app).post(`/v1${path}`).send(body));

  describe("version history", () => {
    test("keeps each replaced version, skips no-op saves and caps at 20 per build", async () => {
      await put("author", "capped", build({ description: "v0" })).expect(200);
      await put("author", "capped", build({ description: "v0" })).expect(200);
      expect(await db.customBuildRevisions.countDocuments({ slug: "capped" })).toBe(0);
      for (let n = 1; n <= 23; n += 1) await put("author", "capped", build({ description: `v${n}` })).expect(200);
      const res = await get("author", "/custom-builds/capped/revisions").expect(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(res.body.items).toHaveLength(20);
      expect(res.body.items[0]).toEqual(expect.objectContaining({ rev: 23, build: expect.objectContaining({ description: "v22" }) }));
      expect(res.body.items.at(-1)).toEqual(expect.objectContaining({ rev: 4, build: expect.objectContaining({ description: "v3" }) }));
      expect(res.body.items[0].build).not.toHaveProperty("isPublic");
      await get("saver", "/custom-builds/capped/revisions").expect(404);
    });

    test("restores a version through the normal save, keeping the current one in history", async () => {
      await put("author", "restore-me", build({ rules: [{ type: "before", name: "BuildStargate", time_lt: 240 }] })).expect(200);
      await put("author", "restore-me", build({ rules: [{ type: "before", name: "BuildRoboticsFacility", time_lt: 300 }] })).expect(200);
      await as("author", request(app).patch("/v1/custom-builds/restore-me/meta").send({ pinned: true, tags: ["Cheese"] })).expect(200);
      const restored = await post("author", "/custom-builds/restore-me/revisions/1/restore").expect(200);
      expect(restored.body).toEqual(expect.objectContaining({ saved: true, restoredRev: 1 }));
      const current = await get("author", "/custom-builds/restore-me").expect(200);
      expect(current.body.rules).toEqual([expect.objectContaining({ type: "before", name: "BuildStargate", time_lt: 240 })]);
      expect(current.body).toEqual(expect.objectContaining({ pinned: true, tags: ["Cheese"] }));
      const history = await get("author", "/custom-builds/restore-me/revisions").expect(200);
      expect(history.body.items.map((item) => item.rev)).toEqual([2, 1]);
      expect(history.body.items[0].build.rules[0].name).toBe("BuildRoboticsFacility");
      await post("author", "/custom-builds/restore-me/revisions/9/restore").expect(404);
      await post("author", "/custom-builds/restore-me/revisions/zero/restore").expect(400);
    });
  });

  describe("recently deleted", () => {
    test("restoring a deleted published build brings it back privately", async () => {
      await put("author", "public-one", build({ shareWithCommunity: true })).expect(200);
      const listing = await db.communityBuilds.findOne({ sourceSlug: "public-one" });
      expect(listing.removed).toBe(false);
      await as("author", request(app).delete("/v1/custom-builds/public-one")).expect(204);
      const trash = await get("author", "/custom-builds/trash").expect(200);
      expect(trash.body).toEqual(expect.objectContaining({ total: 1, retentionDays: 30 }));
      expect(trash.body.items[0]).toEqual(expect.objectContaining({ slug: "public-one", name: "Stargate Opener" }));
      expect((await get("saver", "/custom-builds/trash").expect(200)).body.total).toBe(0);
      await get("author", `/community/builds/${listing.slug}`).expect(404);

      const res = await post("author", "/custom-builds/public-one/restore").expect(200);
      expect(res.body).toEqual(expect.objectContaining({ restored: true, republished: false }));
      const restored = await get("author", "/custom-builds/public-one").expect(200);
      expect(restored.body.isPublic).toBe(false);
      await get("author", `/community/builds/${listing.slug}`).expect(404);
      expect((await get("author", "/custom-builds/trash").expect(200)).body.total).toBe(0);
      await post("author", "/custom-builds/public-one/restore").expect(404);
    });

    test("the trash window is 30 days and the purge removes expired builds with their history", async () => {
      await put("author", "old-one", build()).expect(200);
      await put("author", "old-one", build({ description: "edited" })).expect(200);
      await put("author", "recent-one", build()).expect(200);
      await as("author", request(app).delete("/v1/custom-builds/old-one")).expect(204);
      await as("author", request(app).delete("/v1/custom-builds/recent-one")).expect(204);
      await db.customBuilds.updateOne({ slug: "old-one" }, { $set: { deletedAt: new Date(Date.now() - 31 * DAY_MS) } });
      const trash = await get("author", "/custom-builds/trash").expect(200);
      expect(trash.body.items.map((item) => item.slug)).toEqual(["recent-one"]);
      await post("author", "/custom-builds/old-one/restore").expect(404);

      const job = buildCustomBuildTrashPurgeJob({ db, logger: pino({ level: "silent" }) });
      await job.runOnce();
      expect(await new CustomBuildLibraryService(db).purgeExpiredTrash()).toEqual({ purged: 0 });
      expect(await db.customBuilds.findOne({ slug: "old-one" })).toBeNull();
      expect(await db.customBuildRevisions.countDocuments({ slug: "old-one" })).toBe(0);
      expect(await db.customBuilds.findOne({ slug: "recent-one" })).not.toBeNull();
    });
  });

  describe("pin, tags and filters", () => {
    test("PATCH meta validates, and the list puts pinned builds first with tag, perspective, published and race filters", async () => {
      await put("author", "a-protoss", build({ name: "A Protoss" })).expect(200);
      await put("author", "b-zerg", build({ name: "B Zerg", race: "Zerg", vsRace: "Protoss", rules: [{ type: "before", name: "BuildSpawningPool", time_lt: 60 }] })).expect(200);
      await put("author", "c-opponent", build({ name: "C Opponent", perspective: "opponent" })).expect(200);
      await db.customBuilds.updateOne({ slug: "a-protoss" }, { $set: { isPublic: true } });
      const patched = await as("author", request(app).patch("/v1/custom-builds/c-opponent/meta").send({ pinned: true, tags: [" Cheese ", "cheese", "Macro"] })).expect(200);
      expect(patched.body).toEqual({ slug: "c-opponent", pinned: true, tags: ["Cheese", "Macro"] });
      await as("author", request(app).patch("/v1/custom-builds/a-protoss/meta").send({ tags: ["macro"] })).expect(200);
      for (const body of [{}, { pinned: "yes" }, { tags: Array.from({ length: 9 }, (_, n) => `t${n}`) }, { tags: ["x".repeat(25)] }, { name: "nope" }]) {
        await as("author", request(app).patch("/v1/custom-builds/a-protoss/meta").send(body)).expect(400);
      }
      await as("saver", request(app).patch("/v1/custom-builds/a-protoss/meta").send({ pinned: true })).expect(404);

      const all = await get("author", "/custom-builds?sort=name").expect(200);
      expect(all.body.items.map((item) => item.slug)).toEqual(["c-opponent", "a-protoss", "b-zerg"]);
      expect(all.body.availableTags).toEqual([{ tag: "Macro", count: 2 }, { tag: "Cheese", count: 1 }]);
      const slugsFor = async (query) => (await get("author", `/custom-builds?sort=name&${query}`).expect(200)).body.items.map((item) => item.slug);
      expect(await slugsFor("tags=cheese")).toEqual(["c-opponent"]);
      expect(await slugsFor("tags=macro,cheese")).toEqual(["c-opponent"]);
      expect(await slugsFor("perspective=opponent")).toEqual(["c-opponent"]);
      expect(await slugsFor("perspective=you")).toEqual(["a-protoss", "b-zerg"]);
      expect(await slugsFor("published=1")).toEqual(["a-protoss"]);
      expect(await slugsFor("race=Z")).toEqual(["b-zerg"]);
      for (const query of ["perspective=both", "published=maybe", "race=Q", `tags=${"x".repeat(25)}`]) {
        const bad = await get("author", `/custom-builds?${query}`).expect(400);
        expect(bad.body.error.code).toBe("invalid_custom_build_page");
      }

      const firstPage = await get("author", "/custom-builds?sort=name&limit=1").expect(200);
      expect(firstPage.body.nextCursor).toEqual(expect.any(String));
      const second = await get("author", `/custom-builds?sort=name&limit=1&cursor=${firstPage.body.nextCursor}`).expect(200);
      expect(second.body.items.map((item) => item.slug)).toEqual(["a-protoss"]);
      // A cursor belongs to its filter set.
      await get("author", `/custom-builds?sort=name&limit=1&race=P&cursor=${firstPage.body.nextCursor}`).expect(400);
    });
  });

  describe("import and export", () => {
    test("previews new, conflict and invalid, then skips, copies or overwrites per item", async () => {
      await put("author", "existing", build({ name: "Existing", description: "original" })).expect(200);
      await put("author", "skip-me", build({ name: "Skip Me" })).expect(200);
      const items = [
        { build: { slug: "fresh", name: "Fresh", race: "Terran", vsRace: "Zerg", isPublic: true } },
        { build: { slug: "existing", name: "Existing", race: "Protoss", description: "imported" }, onConflict: "overwrite" },
        { build: { slug: "skip-me", name: "Skip Me", race: "Protoss" }, onConflict: "skip" },
        { build: { slug: "existing", name: "Existing", race: "Protoss" }, onConflict: "copy" },
        { build: { name: "", race: "Protoss" } },
        { build: { slug: "bad-race", name: "Bad", race: "Elf" } },
        { build: "not a build" },
      ];
      const preview = await post("author", "/custom-builds/import", { items, dryRun: true }).expect(200);
      expect(preview.body.results.map((result) => result.status)).toEqual(["new", "conflict", "conflict", "conflict", "invalid", "invalid", "invalid"]);
      expect(await db.customBuilds.countDocuments({ userId: ids.author })).toBe(2);

      const res = await post("author", "/custom-builds/import", { items, reclassify: true }).expect(200);
      expect(res.body.results.map((result) => result.status)).toEqual(["created", "overwritten", "skipped", "copied", "invalid", "invalid", "invalid"]);
      expect(res.body.results[3]).toEqual(expect.objectContaining({ slug: "existing-copy" }));
      const fresh = await db.customBuilds.findOne({ userId: ids.author, slug: "fresh" });
      expect(fresh).toEqual(expect.objectContaining({ source: "import", name: "Fresh" }));
      expect(fresh.isPublic).toBeUndefined();
      expect((await db.customBuilds.findOne({ slug: "existing" })).description).toBe("imported");
      expect((await db.customBuilds.findOne({ slug: "existing-copy" })).name).toBe("Existing (copy)");
      expect(await db.customBuildRevisions.countDocuments({ slug: "existing" })).toBe(1);
      await post("author", "/custom-builds/import", { items: [] }).expect(400);
      await post("author", "/custom-builds/import", { items: Array.from({ length: 101 }, () => items[0]) }).expect(400);
    });

    test("refuses an import past 500 builds with 409", async () => {
      const now = new Date();
      await db.customBuilds.insertMany(Array.from({ length: 499 }, (_, n) => ({
        userId: ids.saver, slug: `bulk-${n}`, name: `Bulk ${n}`, race: "Zerg", createdAt: now, updatedAt: now,
      })));
      const items = [{ build: { slug: "one", name: "One", race: "Zerg" } }, { build: { slug: "two", name: "Two", race: "Zerg" } }];
      const res = await post("saver", "/custom-builds/import", { items }).expect(409);
      expect(res.body.error.code).toBe("library_full");
      expect(await db.customBuilds.countDocuments({ userId: ids.saver })).toBe(499);
      await post("saver", "/custom-builds/import", { items: items.slice(0, 1) }).expect(200);
    });

    test("exports every live build as validated JSON without publication state", async () => {
      await put("author", "exported", build({ shareWithCommunity: false })).expect(200);
      await db.customBuilds.updateOne({ slug: "exported" }, { $set: { isPublic: true, tags: ["Macro"] } });
      await put("author", "gone", build({ name: "Gone" })).expect(200);
      await as("author", request(app).delete("/v1/custom-builds/gone")).expect(204);
      const res = await get("author", "/custom-builds/export").expect(200);
      expect(res.headers["content-disposition"]).toContain("sc2tools-builds.json");
      expect(res.body).toEqual(expect.objectContaining({ format: "sc2tools-custom-builds", version: 1 }));
      expect(res.body.builds).toHaveLength(1);
      expect(res.body.builds[0]).toEqual(expect.objectContaining({ slug: "exported", name: "Stargate Opener", tags: ["Macro"] }));
      expect(res.body.builds[0]).not.toHaveProperty("isPublic");
      expect(res.body.builds[0]).not.toHaveProperty("userId");
    });
  });

  describe("community trust", () => {
    async function publishAuthorBuild(extra = {}) {
      await put("author", "author-build", build({ skillLevel: "gold", ...extra })).expect(200);
      const res = await post("author", "/community/builds", { slug: "author-build", title: "Phoenix Opener" }).expect(201);
      return res.body.slug;
    }
    const saveCopy = (who, slug, publicSlug, version = "1", extra = {}) => put(who, slug, build({
      name: "My copy", notes: "saver notes", skillLevel: "diamond", createOnly: true,
      forkedFrom: { communitySlug: publicSlug, version, savedAt: new Date().toISOString() }, ...extra,
    }));

    test("counts one save per account and never the author's own", async () => {
      const publicSlug = await publishAuthorBuild();
      await saveCopy("saver", "copy-1", publicSlug).expect(200);
      await saveCopy("saver", "copy-2", publicSlug).expect(200);
      await saveCopy("author", "own-copy", publicSlug).expect(200);
      expect((await get("third", `/community/builds/${publicSlug}`).expect(200)).body.saves).toBe(1);
      await saveCopy("third", "third-copy", publicSlug).expect(200);
      const detail = await get("third", `/community/builds/${publicSlug}`).expect(200);
      expect(detail.body).toEqual(expect.objectContaining({ saves: 2, version: 1 }));
      expect(await db.communitySaves.countDocuments({ slug: publicSlug })).toBe(2);
    });

    test("content edits bump the version; Apply update keeps the saver's notes and skill level", async () => {
      const publicSlug = await publishAuthorBuild();
      await saveCopy("saver", "my-copy", publicSlug).expect(200);
      let versions = await get("saver", `/community/builds/versions?slugs=${publicSlug},missing-slug`).expect(200);
      expect(versions.body.items).toEqual([expect.objectContaining({ slug: publicSlug, version: 1 })]);

      await post("author", "/community/builds", { slug: "author-build", title: "Phoenix Opener" }).expect(201);
      versions = await get("saver", `/community/builds/versions?slugs=${publicSlug}`).expect(200);
      expect(versions.body.items[0].version).toBe(1);
      await put("author", "author-build", build({ skillLevel: "gold", rules: [{ type: "before", name: "BuildStargate", time_lt: 200 }] })).expect(200);
      const republished = await post("author", "/community/builds", { slug: "author-build", title: "Phoenix Opener" }).expect(201);
      expect(republished.body.version).toBe(2);
      versions = await get("saver", `/community/builds/versions?slugs=${publicSlug}`).expect(200);
      expect(versions.body.items[0]).toEqual(expect.objectContaining({ version: 2, updatedAt: expect.any(String) }));
      for (const slugs of ["", "a/b", Array.from({ length: 51 }, (_, n) => `s${n}`).join(",")]) {
        await get("saver", `/community/builds/versions?slugs=${encodeURIComponent(slugs)}`).expect(400);
      }

      const applied = await post("saver", "/custom-builds/my-copy/apply-update").expect(200);
      expect(applied.body).toEqual(expect.objectContaining({ saved: true, version: 2 }));
      const copy = await get("saver", "/custom-builds/my-copy").expect(200);
      expect(copy.body.rules).toEqual([expect.objectContaining({ type: "before", name: "BuildStargate", time_lt: 200 })]);
      expect(copy.body).toEqual(expect.objectContaining({ notes: "saver notes", skillLevel: "diamond", name: "My copy" }));
      expect(copy.body.forkedFrom).toEqual(expect.objectContaining({ communitySlug: publicSlug, version: "2" }));
      expect((await get("saver", "/custom-builds/my-copy/revisions").expect(200)).body.items).toHaveLength(1);

      await post("saver", "/custom-builds/my-copy/dismiss-update", { version: 3 }).expect(200);
      expect((await db.customBuilds.findOne({ userId: ids.saver, slug: "my-copy" })).forkedFrom.version).toBe("3");
      await post("saver", "/custom-builds/my-copy/dismiss-update", { version: "abc" }).expect(400);
      await put("saver", "plain", build()).expect(200);
      await post("saver", "/custom-builds/plain/apply-update").expect(409);
      await post("saver", "/custom-builds/plain/dismiss-update", { version: 2 }).expect(404);
    });

    test("the author's record is hidden by default and shown only after opting in", async () => {
      const publicSlug = await publishAuthorBuild();
      await db.games.insertOne({ userId: ids.author, gameId: "rec-1", date: new Date(), result: "Victory", _customBuildSlug: "author-build" });
      let detail = await get("third", `/community/builds/${publicSlug}`).expect(200);
      expect(detail.body).not.toHaveProperty("authorRecord");
      expect((await get("third", "/community/builds").expect(200)).body.items[0]).not.toHaveProperty("authorRecord");
      expect(detail.body).not.toHaveProperty("showAuthorRecord");

      await post("author", "/community/builds", { slug: "author-build", title: "Phoenix Opener", showRecord: true }).expect(201);
      services.community.authorRecords.cache.clear();
      detail = await get("third", `/community/builds/${publicSlug}`).expect(200);
      expect(detail.body.authorRecord).toEqual({ wins: 1, losses: 0 });
      const settings = await get("author", "/community/my-build-publication/author-build").expect(200);
      expect(settings.body.showAuthorRecord).toBe(true);
      // Omitting the choice on a later publish keeps it.
      await post("author", "/community/builds", { slug: "author-build", title: "Phoenix Opener" }).expect(201);
      expect((await get("author", "/community/my-build-publication/author-build").expect(200)).body.showAuthorRecord).toBe(true);
    });

    test("sorts by most saved", async () => {
      await put("author", "less-saved", build({ name: "Less" })).expect(200);
      await put("author", "more-saved", build({ name: "More" })).expect(200);
      const less = (await post("author", "/community/builds", { slug: "less-saved", title: "Less saved" }).expect(201)).body.slug;
      const more = (await post("author", "/community/builds", { slug: "more-saved", title: "More saved" }).expect(201)).body.slug;
      await saveCopy("saver", "s1", more).expect(200);
      await saveCopy("third", "s2", more).expect(200);
      await saveCopy("saver", "s3", less).expect(200);
      const res = await get("third", "/community/builds?sort=saves").expect(200);
      expect(res.body.items.map((item) => [item.slug, item.saves])).toEqual([[more, 2], [less, 1]]);
    });
  });
});
