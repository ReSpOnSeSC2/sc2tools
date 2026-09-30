// @ts-nocheck
"use strict";

/**
 * Public build / counter / map guide pages through the full app over a
 * real guide_stats run: published payload sections, number-free
 * unpublished payloads (+ the owner's videos), exact-name community
 * builds, serve-time re-verified example replays and coach's notes
 * without the editor's id.
 */

const request = require("supertest");
const { GUIDE_CACHE_CONTROL } = require("../src/config/guides");
const {
  createGuidesHarness, seedGuideCorpus, GLAIVES, ROBO, TWELVE_POOL, SHARER_SLUG,
} = require("./helpers/guidesHarness");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const IDENTITY_BUILD_KEYS = [
  "buildKey", "buildSlug", "computedAt", "description", "era", "matchup", "matchupSlug", "name", "patch",
  "published", "videos",
];

/** Every numeric leaf of a JSON value (deep). */
function deepNumbers(value, out = []) {
  if (typeof value === "number") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => deepNumbers(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => deepNumbers(v, out));
  return out;
}

/** Every key of every object in a JSON value (deep). */
function deepKeys(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => deepKeys(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      deepKeys(v, out);
    }
  }
  return out;
}

describe("guide pages", () => {
  let h; let run;
  const get = (path) => request(h.app).get(path);

  beforeAll(async () => {
    h = await createGuidesHarness();
    run = await seedGuideCorpus(h);
    const at = new Date("2026-09-01T00:00:00Z");
    await h.db.communityBuilds.insertMany([
      { slug: "build-exact-title", title: "Stargate into Glaives", matchup: "PvZ", removed: false, votes: 5, publishedAt: at },
      { slug: "build-exact-name", title: "My SG opener", build: { name: "  pvz - STARGATE into glaives " }, matchup: "PvZ", removed: false, votes: 9, publishedAt: at },
      { slug: "build-fuzzy", title: "Stargate into Glaives v2", matchup: "PvZ", removed: false, votes: 50, publishedAt: at },
      { slug: "build-removed", title: "Stargate into Glaives", matchup: "PvZ", removed: true, votes: 99, publishedAt: at },
      { slug: "build-other-mu", title: "Stargate into Glaives", matchup: "PvT", removed: false, votes: 99, publishedAt: at },
    ]);
    await h.db.guideNotes.insertOne({
      // The channel's Glaives video is from the 8-worker patch: it shows
      // only because the admin pinned it.
      matchup: "PvZ", buildKey: GLAIVES, body: "### Plan\nHide the **Twilight**.", videos: { pinned: ["YcTMc_Ee11w"], hidden: [] },
      updatedBy: "u_admin_secret_id", updatedAt: new Date("2026-09-20T10:00:00Z"), _schemaVersion: 1,
    });
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  test("published build: every section, related, community, examples, notes; never a baseline", async () => {
    const res = await get("/v1/guides/pvz/stargate-into-glaives");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe(GUIDE_CACHE_CONTROL);
    const b = res.body;
    expect(b).toMatchObject({
      published: true, matchup: "PvZ", matchupSlug: "pvz", buildKey: GLAIVES, buildSlug: "stargate-into-glaives",
      name: "Stargate into Glaives", era: "after", patch: "5.0.17", computedAt: run.computedAt.toISOString(),
      overall: { games: 121, users: 6 }, matchupGames: 161, isNew: true, trend: null,
      headline: { scope: "league", value: 4, label: "Diamond", games: 121 },
      firstPublishedAt: run.computedAt.toISOString(),
    });
    expect(typeof b.description).toBe("string");
    expect(b.description.length).toBeGreaterThan(0);
    expect(b.bands.league).toEqual([expect.objectContaining({ value: 4, label: "Diamond", games: 121 })]);
    expect(b.bands.mmr).toEqual([expect.objectContaining({ value: 4000, label: "4000–4500" })]);
    expect(b.vsStrategy).toEqual([expect.objectContaining({
      strategyKey: TWELVE_POOL, strategySlug: "12-pool", name: "12 Pool", published: true, games: 121,
    })]);
    expect(b.maps).toEqual([expect.objectContaining({ map: "Site Delta LE", mapSlug: "site-delta-le" })]);
    expect(b.lengths).toEqual([expect.objectContaining({ bucket: "10-15", minSec: 600, maxSec: 900 })]);
    expect(b.timings.samples).toBe(36);
    expect(b.timings.milestones.map((m) => m.key)).toEqual(["Pylon", "Gateway", "Stargate"]);
    expect(b.army["360"].units.map((u) => u.unit)).toEqual(["Adept", "Oracle"]);
    expect(b.related).toEqual([{
      buildKey: ROBO, buildSlug: "robo-opener", name: "Robo Opener", published: false,
      games: 40, winRate: 0.5, ci: expect.any(Object),
    }]);
    expect(b.communityBuilds).toEqual([
      { slug: "build-exact-name", title: "My SG opener" },
      { slug: "build-exact-title", title: "Stargate into Glaives" },
    ]);
    expect(b.examples).toEqual([{
      handle: SHARER_SLUG, displayName: "Sharer One", result: "Victory", map: "Site Delta LE", durationSec: 612,
      playedAt: expect.any(String), href: `/players/${SHARER_SLUG}/replays`,
    }]);
    expect(b.notes).toEqual({ body: "### Plan\nHide the **Twilight**.", updatedAt: "2026-09-20T10:00:00.000Z" });
    expect(b.videos.map((v) => v.youtubeId)).toEqual(["YcTMc_Ee11w"]);
    const keys = deepKeys(b);
    for (const banned of ["baseline", "baselineCandidate", "_schemaVersion", "updatedBy", "userId", "gameId", "opponent"]) {
      expect(keys.has(banned)).toBe(false);
    }
    expect(b).not.toHaveProperty("key");
    expect(b).not.toHaveProperty("kind");
    expect(JSON.stringify(b)).not.toContain("u_admin_secret_id");
  });

  test("a failing community-link or example re-check drops only those links, never the page", async () => {
    const { communityBuilds, users } = h.db;
    const broken = {
      find: () => {
        throw Object.assign(new Error("operation exceeded time limit"), { codeName: "MaxTimeMSExpired" });
      },
    };
    h.db.communityBuilds = broken;
    h.db.users = broken;
    try {
      const res = await get("/v1/guides/pvz/stargate-into-glaives");
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe(GUIDE_CACHE_CONTROL);
      expect(res.body).toMatchObject({ published: true, overall: { games: 121 }, communityBuilds: [], examples: [] });
    } finally {
      h.db.communityBuilds = communityBuilds;
      h.db.users = users;
    }
    const healthy = await get("/v1/guides/pvz/stargate-into-glaives");
    expect(healthy.body.communityBuilds).toHaveLength(2);
    expect(healthy.body.examples).toHaveLength(1);
  });

  test("examples are re-verified at serve time: a user who stops sharing disappears", async () => {
    await h.db.users.updateOne({ userId: "gl-0" }, { $set: { "replaySharing.enabled": false } });
    const off = await get("/v1/guides/pvz/stargate-into-glaives");
    expect(off.body.examples).toEqual([]);
    await h.db.users.updateOne({ userId: "gl-0" }, { $set: { "replaySharing.enabled": true, displayName: "Renamed" } });
    const on = await get("/v1/guides/pvz/stargate-into-glaives");
    expect(on.body.examples).toEqual([expect.objectContaining({ handle: SHARER_SLUG, displayName: "Renamed" })]);
    await h.db.users.deleteOne({ userId: "gl-0" });
    const gone = await get("/v1/guides/pvz/stargate-into-glaives");
    expect(gone.body.examples).toEqual([]);
  });

  test.each([
    ["/v1/guides/pvz/robo-opener", []],
    // "PvZ Carrier Rush: Can Zerg Stop It?" is an 8-worker patch video and is not pinned.
    ["/v1/guides/pvz/carrier-rush", []],
  ])("unpublished build %s: identity only, no numbers (videos still ship)", async (path, videoIds) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe(GUIDE_CACHE_CONTROL);
    expect(Object.keys(res.body).sort()).toEqual(IDENTITY_BUILD_KEYS);
    expect(res.body.published).toBe(false);
    expect(res.body.videos.map((v) => v.youtubeId)).toEqual(videoIds);
    expect(deepNumbers({ ...res.body, videos: [] })).toEqual([]);
  });

  test("published counter: overall + openers with their page flags", async () => {
    const res = await get("/v1/guides/pvz/counter/12-pool");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      published: true, matchup: "PvZ", matchupSlug: "pvz", strategyKey: TWELVE_POOL, strategySlug: "12-pool",
      name: "12 Pool", myRace: "Protoss", oppRace: "Zerg", era: "after", overall: { games: 121, users: 6 },
    });
    expect(res.body.openers).toEqual([expect.objectContaining({
      buildKey: GLAIVES, buildSlug: "stargate-into-glaives", name: "Stargate into Glaives", published: true,
    })]);
    // "PvZ Cracking 8 Pools" is about the 8-worker patch's 8 Pool; it no
    // longer matches the 12 Pool counter.
    expect(res.body.videos.map((v) => v.youtubeId)).not.toContain("A4x6gR7J-AY");
  });

  test("unpublished counter: identity + videos only", async () => {
    const res = await get("/v1/guides/pvz/counter/ling-bane-bust");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      "computedAt", "description", "era", "matchup", "matchupSlug", "myRace", "name", "oppRace", "patch",
      "published", "strategyKey", "strategySlug", "videos",
    ]);
    expect(res.body.published).toBe(false);
  });

  test("published map: matchup cells with their top openers", async () => {
    const res = await get("/v1/guides/maps/site-delta-le");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe(GUIDE_CACHE_CONTROL);
    expect(res.body).toMatchObject({ published: true, map: "Site Delta LE", mapSlug: "site-delta-le", games: 161 });
    expect(res.body.matchups).toEqual([expect.objectContaining({
      matchup: "PvZ", slug: "pvz", games: 161,
      openers: [
        expect.objectContaining({ buildKey: GLAIVES, name: "Stargate into Glaives" }),
        expect.objectContaining({ buildKey: ROBO, name: "Robo Opener" }),
      ],
    })]);
  });

  test("an unpublished map doc is identity-only", async () => {
    await h.db.guideStats.insertOne({
      kind: "map", key: "map:after:alcyone-le", era: "after", map: "Alcyone LE", mapSlug: "alcyone-le",
      published: false, games: 40, matchups: [], computedAt: run.computedAt,
    });
    const res = await get("/v1/guides/maps/alcyone-le");
    expect(res.body).toEqual({
      published: false, map: "Alcyone LE", mapSlug: "alcyone-le", era: "after", patch: "5.0.17",
      computedAt: run.computedAt.toISOString(),
    });
  });

  test("a blank note is not shown", async () => {
    await h.db.guideNotes.updateOne({ matchup: "PvZ", buildKey: GLAIVES }, { $set: { body: "   " } });
    const res = await get("/v1/guides/pvz/stargate-into-glaives");
    expect(res.body.notes).toBeNull();
  });
});
