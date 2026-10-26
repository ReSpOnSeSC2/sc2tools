// @ts-nocheck
"use strict";
const request = require("supertest");
const { startHarness } = require("./helpers/browserIngestHarness");
const { createBackupStore } = require("./helpers/userBackupsStore");
jest.mock("@clerk/backend", () => ({ verifyToken: jest.fn(async () => ({ sub: "clerk_cache_owner" })) }));
const pulse = "1-S2-1-123";
describe("public Community cache lifecycle", () => {
  let h, changed;
  beforeAll(async () => { h = await startHarness("community_cache_lifecycle"); h.services.gdpr.backups.store = createBackupStore(); });
  afterAll(async () => { if (h) await h.stop(); });
  beforeEach(async () => {
    for (const key of ["users", "customBuilds", "communityBuilds", "communityReports", "games", "opponents", "userBackups"]) await h.db[key].deleteMany({});
    h.services.gdpr.backups.store.objects.clear();
    await h.db.users.insertOne({ userId: "owner", clerkUserId: "clerk_cache_owner", displayName: "Synthetic owner" });
    await h.services.customBuilds.upsert("owner", { slug: "private-source", name: "Synthetic macro", race: "Protoss", vsRace: "Zerg", steps: [{ supply: 14, time: "0:18", action: "Pylon" }] });
    h.services.community.invalidateForUser("owner");
    changed = jest.fn(); h.services.community.onPublicChanged = changed;
  });
  const publish = () => h.services.community.publish("owner", "private-source", { title: "Synthetic macro", authorName: "Synthetic author" });
  function rejectAfterCommit(collection, method, after = () => {}) {
    const original = collection[method].bind(collection);
    return jest.spyOn(collection, method).mockImplementationOnce(async (...args) => { await original(...args); after(); throw new Error("unknown commit"); });
  }
  async function games() {
    await h.db.games.insertMany(Array.from({ length: 5 }, (_, n) => ({ userId: `contributor-${n}`, gameId: `game-${n}`, result: "Win", map: "Synthetic map", opponent: { pulseId: pulse, race: "Zerg", strategy: "Synthetic strategy" } })));
    await h.db.games.insertOne({ userId: "hidden", gameId: "hidden-game", excluded: true, opponent: { pulseId: pulse } });
  }

  test("publish, update and both unpublish entry points notify after the public commit", async () => {
    const initial = await publish(); expect(changed).toHaveBeenCalledTimes(1);
    await publish(); expect(changed).toHaveBeenCalledTimes(2);
    await h.services.community.unpublishBySource("owner", "private-source"); expect(changed).toHaveBeenCalledTimes(3);
    expect(await h.services.community.getPublic(initial.slug)).toBeNull();
    await publish(); expect(changed).toHaveBeenCalledTimes(4);
    await h.services.community.unpublish("owner", initial.slug); expect(changed).toHaveBeenCalledTimes(5);
    await h.services.community.unpublish("owner", initial.slug); expect(changed).toHaveBeenCalledTimes(5);
  });
  test("identical votes do not purge, while switches and removal use authoritative integer scores", async () => {
    const { slug } = await publish(); changed.mockClear();
    await h.services.community.vote("voter", slug, 1); expect(changed).toHaveBeenCalledTimes(1);
    await h.services.community.vote("voter", slug, 1); expect(changed).toHaveBeenCalledTimes(1);
    await h.services.community.vote("voter", slug, -1); expect(changed).toHaveBeenCalledTimes(2);
    await h.services.community.vote("voter", slug, 0); expect(changed).toHaveBeenCalledTimes(3);
  });
  test("callback failure does not turn a committed publication into a visibility error", async () => {
    h.services.community.onPublicChanged = () => { throw new Error("notification unavailable"); };
    const { slug } = await publish(); expect(await h.services.community.getPublic(slug)).toMatchObject({ slug });
  });
  test("admin edits/revert and moderation removal invalidate the same public surfaces", async () => {
    const { slug } = await publish(), row = await h.db.communityBuilds.findOne({ slug });
    const studio = h.services.buildStudio; studio.onCommunityChanged = changed; changed.mockClear();
    const before = await studio.detail("community", String(row._id));
    const after = await studio.save("community", String(row._id), { expectedRevision: before.revision, build: before.build, title: "Revised synthetic title" });
    expect(changed).toHaveBeenCalledTimes(1);
    await studio.revert("community", String(row._id), after.revision, before.revision); expect(changed).toHaveBeenCalledTimes(2);
    await h.db.communityReports.insertOne({ id: "synthetic-report", targetType: "build", targetId: slug, resolvedAt: null });
    await h.services.community.resolveReport("synthetic-admin", "synthetic-report", { action: "remove" }); expect(changed).toHaveBeenCalledTimes(3);
  });
  test("public build content can cache while profile and private admission stays fresh", async () => {
    const { slug } = await publish(); await games();
    for (const path of ["/builds", `/builds/${slug}`, "/arcade-universe", "/sitemap"]) {
      const response = await request(h.app).get(`/v1/community${path}`);
      expect(response.status).toBe(200); expect(response.headers["cache-control"]).toBe("public, s-maxage=60, stale-while-revalidate=600");
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
    const author = await request(h.app).get("/v1/community/authors/owner");
    expect(author.status).toBe(200); expect(author.headers["cache-control"]).toBe("no-store");
    const opponent = await request(h.app).get(`/v1/community/opponents/${pulse}`);
    expect(opponent.status).toBe(200); expect(opponent.headers["cache-control"]).toBe("private, no-store");
    for (const path of ["/my-builds", "/my-build-stats", "/my-build-publication/private-source", `/builds/${slug}/my-vote`]) {
      const response = await request(h.app).get(`/v1/community${path}`).set("authorization", "Bearer fixture");
      expect(response.status).toBe(200); expect(response.headers["cache-control"]).toBe("private, no-store");
    }
    const missing = await request(h.app).get("/v1/community/builds/missing");
    expect(missing.status).toBe(404); expect(missing.headers["cache-control"]).toContain("no-store");
  });
  test("a warm aggregate still checks the current floor and removal before returning its cached payload", async () => {
    await games(); const service = h.services.community, spy = jest.spyOn(h.db.games, "find");
    try {
      expect(await service.aggregateOpponent(pulse)).not.toBeNull(); await service.aggregateOpponent(pulse);
      expect(spy).toHaveBeenCalledTimes(1);
      await h.db.games.deleteOne({ userId: "contributor-0" });
      expect(await service.aggregateOpponent(pulse)).toBeNull(); // Hidden sixth row never contributes to the floor.
      await h.db.games.insertOne({ userId: "replacement", gameId: "replacement", opponent: { pulseId: pulse }, result: "Win" });
      await h.db.communityReports.insertOne({ targetType: "opponent", targetId: pulse, resolution: "remove", resolvedAt: new Date() });
      expect(await service.aggregateOpponent(pulse)).toBeNull();
    } finally { spy.mockRestore(); }
  });
  test("a contribution invalidation fences an already-materialized but held late read", async () => {
    await games(); let entered, finish;
    const started = new Promise(resolve => { entered = resolve; }), hold = new Promise(resolve => { finish = resolve; });
    const find = h.db.games.find.bind(h.db.games), spy = jest.spyOn(h.db.games, "find").mockImplementationOnce((...args) => {
      const cursor = find(...args), read = cursor.toArray.bind(cursor);
      cursor.toArray = async () => { const rows = await read(); entered(); await hold; return rows; }; return cursor;
    });
    const old = h.services.community.aggregateOpponent(pulse), rejected = expect(old).rejects.toMatchObject({ code: "community_data_changed" });
    try { await started; h.services.community.invalidateForUser("contributor-0"); finish(); await rejected; expect(h.services.community.opponentAggregates.values.size).toBe(0); }
    finally { spy.mockRestore(); finish(); }
  });
  test("GDPR vote scrub and game wipe invalidate after committed contribution changes", async () => {
    const { slug } = await publish(); await h.db.users.insertOne({ userId: "voter" });
    await h.services.community.vote("voter", slug, 1); changed.mockClear();
    await h.services.gdpr.deleteAll("voter", { identityAlreadyDeleted: true }); expect(changed).toHaveBeenCalled();
    await games(); await h.db.users.insertOne({ userId: "contributor-0" });
    await h.services.community.aggregateOpponent(pulse); changed.mockClear();
    await h.services.gdpr.wipeGames("contributor-0");
    expect(changed).toHaveBeenCalled(); expect(h.services.community.opponentAggregates.values.size).toBe(0);
  });
  test("real hide, unhide and single deletion invalidate the existing public cache path", async () => {
    await games(); await h.db.users.insertOne({ userId: "contributor-0" });
    await h.services.community.aggregateOpponent(pulse); changed.mockClear();
    await h.services.gameControls.setExcluded("contributor-0", "game-0", { excluded: true, reason: "other" });
    expect(changed).toHaveBeenCalled(); expect(await h.services.community.aggregateOpponent(pulse)).toBeNull();
    changed.mockClear(); await h.services.gameControls.setExcluded("contributor-0", "game-0", { excluded: false });
    expect(changed).toHaveBeenCalled(); expect(await h.services.community.aggregateOpponent(pulse)).not.toBeNull();
    changed.mockClear(); await h.services.gameControls.deleteGame("contributor-0", "game-0");
    expect(changed).toHaveBeenCalled(); expect(await h.services.community.aggregateOpponent(pulse)).toBeNull();
  });
  test("snapshot restore clears contributions before and after replacement using mocked object storage", async () => {
    await games(); await h.db.games.insertOne({ userId: "owner", gameId: "restore-game", date: new Date(), opponent: { pulseId: pulse }, result: "Win" });
    const snapshot = await h.services.gdpr.snapshot("owner");
    await h.db.games.deleteOne({ userId: "owner", gameId: "restore-game" });
    await h.services.community.aggregateOpponent(pulse); changed.mockClear();
    await h.services.gdpr.restoreSnapshot("owner", snapshot.id);
    expect(changed.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(h.services.community.opponentAggregates.values.size).toBe(0);
    expect(await h.db.games.findOne({ userId: "owner", gameId: "restore-game" })).not.toBeNull();
  });
  test("partial erasure still invalidates committed game deletion if a later detail cleanup fails", async () => {
    await games(); await h.db.users.insertOne({ userId: "contributor-0" }); await h.services.community.aggregateOpponent(pulse); changed.mockClear();
    const stop = jest.spyOn(h.services.gdpr.gameDetails, "deleteAllForUser").mockRejectedValueOnce(new Error("fixture store unavailable"));
    try {
      await expect(h.services.gdpr.deleteAll("contributor-0", { identityAlreadyDeleted: true })).rejects.toThrow("fixture store unavailable");
      expect(changed).toHaveBeenCalled(); expect(h.services.community.opponentAggregates.values.size).toBe(0);
    } finally { stop.mockRestore(); }
  });
  test("opponent moderation commit-then-reject cannot leave its warm payload or Next tags valid", async () => {
    await games(); await h.services.community.aggregateOpponent(pulse); changed.mockClear();
    await h.db.communityReports.insertOne({ id: "uncertain-removal", targetType: "opponent", targetId: pulse, resolvedAt: null });
    const write = rejectAfterCommit(h.db.communityReports, "updateMany");
    try {
      await expect(h.services.community.resolveReport("admin", "uncertain-removal", { action: "remove" })).rejects.toThrow("unknown commit");
      expect(changed).toHaveBeenCalled(); expect(h.services.community.opponentAggregates.values.size).toBe(0);
      expect(await h.services.community.aggregateOpponent(pulse)).toBeNull();
    } finally { write.mockRestore(); }
  });
  test("a vote with an unknown committed result still invalidates, while known no-op votes remain optimized", async () => {
    const { slug } = await publish(); changed.mockClear(); const write = rejectAfterCommit(h.db.communityBuilds, "findOneAndUpdate");
    try {
      await expect(h.services.community.vote("voter", slug, 1)).rejects.toThrow("unknown commit"); expect(changed).toHaveBeenCalled();
      expect((await h.db.communityBuilds.findOne({ slug })).votes).toBe(1);
    } finally { write.mockRestore(); }
  });
  test("an unknown admin CAS result invalidates without weakening its owner lease", async () => {
    const { slug } = await publish(), row = await h.db.communityBuilds.findOne({ slug });
    const studio = h.services.buildStudio; studio.onCommunityChanged = changed; changed.mockClear();
    const before = await studio.detail("community", String(row._id)), write = rejectAfterCommit(h.db.communityBuilds, "updateOne");
    try {
      await expect(studio.save("community", String(row._id), { expectedRevision: before.revision, build: before.build, title: "Committed uncertain title" })).rejects.toThrow("unknown commit");
      expect(changed).toHaveBeenCalled(); expect((await h.db.communityBuilds.findOne({ slug })).title).toBe("Committed uncertain title");
      expect((await h.db.users.findOne({ userId: "owner" }))._dataMutations || []).toHaveLength(0);
    } finally { write.mockRestore(); }
  });
  test("unknown publish commit plus failed verification read still requests purge", async () => {
    let committed = false; const read = h.db.communityBuilds.findOne.bind(h.db.communityBuilds);
    const write = rejectAfterCommit(h.db.communityBuilds, "updateOne", () => { committed = true; });
    const verify = jest.spyOn(h.db.communityBuilds, "findOne").mockImplementation((filter, ...args) => {
      if (committed && filter.publicationRevision) return Promise.reject(new Error("verification unavailable")); return read(filter, ...args);
    });
    try { await expect(publish()).rejects.toThrow("verification unavailable"); expect(changed).toHaveBeenCalled(); }
    finally { write.mockRestore(); verify.mockRestore(); }
    expect(await h.db.communityBuilds.findOne({ ownerUserId: "owner", removed: false })).not.toBeNull();
  });
  test.each(["public", "source"])("unknown %s unpublish plus failed verification does not retain stale public caches", async kind => {
    const { slug } = await publish(); changed.mockClear(); let committed = false;
    const read = h.db.communityBuilds.findOne.bind(h.db.communityBuilds);
    const write = rejectAfterCommit(h.db.communityBuilds, "updateMany", () => { committed = true; });
    const verify = jest.spyOn(h.db.communityBuilds, "findOne").mockImplementation((...args) => committed ? Promise.reject(new Error("verification unavailable")) : read(...args));
    try {
      await expect(kind === "public" ? h.services.community.unpublish("owner", slug) : h.services.community.unpublishBySource("owner", "private-source")).rejects.toThrow("verification unavailable");
      expect(changed).toHaveBeenCalled();
    } finally { write.mockRestore(); verify.mockRestore(); }
    expect((await h.db.communityBuilds.findOne({ slug })).removed).toBe(true);
  });
  test("unknown committed game wipe invalidates before propagating uncertainty", async () => {
    await games(); await h.db.users.insertOne({ userId: "contributor-0" }); await h.services.community.aggregateOpponent(pulse); changed.mockClear();
    const write = rejectAfterCommit(h.db.games, "deleteMany");
    try {
      await expect(h.services.gdpr.wipeGames("contributor-0")).rejects.toThrow("unknown commit");
      expect(changed).toHaveBeenCalled(); expect(h.services.community.opponentAggregates.values.size).toBe(0);
    } finally { write.mockRestore(); }
  });
  test.each(["publications", "votes"])("unknown committed erasure of %s invalidates even if later cleanup cannot continue", async kind => {
    const { slug } = await publish(); await h.db.users.insertOne({ userId: "voter" }); await h.services.community.vote("voter", slug, 1); changed.mockClear();
    const write = rejectAfterCommit(h.db.communityBuilds, kind === "publications" ? "deleteMany" : "updateMany");
    try {
      await expect(h.services.gdpr.deleteAll(kind === "publications" ? "owner" : "voter", { identityAlreadyDeleted: true })).rejects.toThrow("unknown commit");
      expect(changed).toHaveBeenCalled();
    } finally { write.mockRestore(); }
  });
  test("pure validation and missing-resource rejections do not trigger a public purge", async () => {
    await expect(h.services.community.vote("owner", "missing", 2)).rejects.toThrow("delta must");
    await expect(h.services.community.unpublish("owner", "missing")).rejects.toThrow("not_found");
    await expect(h.services.community.publish("owner", "missing", { title: "No source" })).rejects.toThrow();
    await expect(h.services.community.resolveReport("admin", "missing", { action: "remove" })).rejects.toThrow("report_not_found");
    expect(changed).not.toHaveBeenCalled();
  });
});
