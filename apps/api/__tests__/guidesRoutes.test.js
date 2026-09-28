// @ts-nocheck
"use strict";

/**
 * Public /v1/guides routes through the full app over a real guide_stats
 * run: hub, matchup (band / era clamp), sitemap, cache headers, 404s, the
 * GUIDES_ENABLED gate and the "public means no 401" mount order.
 * Build / counter / map pages: guidesRoutesPages.test.js; /me:
 * guidesRoutesMe.test.js; alias redirects + limiter: guidesRoutesUnit.test.js.
 */

const request = require("supertest");
const { GUIDE_CACHE_CONTROL } = require("../src/config/guides");
const { GUIDE_NOT_FOUND_CACHE_CONTROL } = require("../src/routes/guides");
const { createGuidesHarness, seedGuideCorpus, GLAIVES, ROBO, EIGHT_POOL } = require("./helpers/guidesHarness");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

describe("public /v1/guides", () => {
  let h; let run;
  const get = (path) => request(h.app).get(path);

  beforeAll(async () => {
    h = await createGuidesHarness();
    run = await seedGuideCorpus(h);
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  test("hub: nine matchups, the published PvZ build on top, maps, videos and the channel", async () => {
    const res = await get("/v1/guides");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe(GUIDE_CACHE_CONTROL);
    const body = res.body;
    expect(body).toMatchObject({ era: "after", patch: "5.0.16", computedAt: run.computedAt.toISOString() });
    expect(body.matchups.map((m) => m.slug)).toEqual(["pvp", "pvt", "pvz", "tvp", "tvt", "tvz", "zvp", "zvt", "zvz"]);
    const pvz = body.matchups.find((m) => m.matchup === "PvZ");
    expect(pvz).toMatchObject({ published: true, games: 161, users: 11, publishedBuilds: 1 });
    expect(pvz.top).toEqual([expect.objectContaining({
      buildKey: GLAIVES, buildSlug: "stargate-into-glaives", name: "Stargate into Glaives", games: 121, users: 6,
      trend: null, isNew: true,
    })]);
    expect(Object.keys(pvz.top[0]).sort()).toEqual(
      ["buildKey", "buildSlug", "ci", "games", "isNew", "name", "trend", "users", "winRate"],
    );
    expect(body.matchups.find((m) => m.matchup === "TvZ")).toEqual({
      matchup: "TvZ", slug: "tvz", published: false, games: null, users: null, top: [], publishedBuilds: 0,
    });
    expect(body.maps).toEqual([{ map: "Site Delta LE", slug: "site-delta-le", games: 161 }]);
    expect(body.videos.length).toBeGreaterThan(0);
    expect(body.videos.length).toBeLessThanOrEqual(4);
    expect(body.channel).toEqual({ url: "https://www.youtube.com/@ReSpOnSeSC2", name: "ReSpOnSeSC2" });
  });

  test("matchup: openers by Wilson lower bound, counters, videos, band options", async () => {
    const res = await get("/v1/guides/pvz");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe(GUIDE_CACHE_CONTROL);
    expect(res.body).toMatchObject({
      matchup: "PvZ", slug: "pvz", era: "after", patch: "5.0.16", published: true, games: 161, users: 11, band: null,
    });
    expect(res.body.openers.map((o) => [o.buildKey, o.published])).toEqual([[GLAIVES, true], [ROBO, false]]);
    expect(res.body.openers[0]).toMatchObject({ name: "Stargate into Glaives", games: 121, prevalence: expect.any(Number) });
    expect(res.body.counters[0]).toEqual({
      strategyKey: EIGHT_POOL, strategySlug: "8-pool", name: "8 Pool", published: true, games: 121,
    });
    expect(res.body.counters.find((c) => c.strategySlug === "ling-bane-bust")).toEqual({
      strategyKey: "ZvP - Ling Bane Bust", strategySlug: "ling-bane-bust", name: "Ling Bane Bust", published: false, games: null,
    });
    expect(res.body.bandOptions).toEqual({
      league: [{ value: 4, label: "Diamond" }],
      mmr: [{ value: 4000, label: "4000–4500" }],
    });
    expect(res.body.videos.every((v) => typeof v.youtubeId === "string")).toBe(true);
    expect(res.body.videos.length).toBeLessThanOrEqual(4);
    expect(JSON.stringify(res.body)).not.toContain("baseline");
  });

  test("band filter: the band cell per build, no prevalence or trend; labels never say MMR", async () => {
    const league = await get("/v1/guides/pvz?band=league:4");
    expect(league.body.band).toEqual({ type: "league", value: 4, label: "Diamond" });
    expect(league.body.openers.map((o) => o.buildKey)).toEqual([GLAIVES, ROBO]);
    expect(league.body.openers.every((o) => o.prevalence === null && o.trend === null)).toBe(true);

    const mmr = await get("/v1/guides/pvz?band=mmr:4000");
    expect(mmr.body.band).toEqual({ type: "mmr", value: 4000, label: "4000–4500" });
    expect(mmr.body.openers).toHaveLength(2);

    const empty = await get("/v1/guides/pvz?band=league:0");
    expect(empty.body.band).toEqual({ type: "league", value: 0, label: "Bronze" });
    expect(empty.body.openers).toEqual([]);
  });

  test.each([
    ["league:9"], ["league:-1"], ["mmr:4100"], ["mmr:99999"], ["elo:4"], ["league:4x"], [""], ["league:04"],
  ])("unknown band %p is ignored (all bands)", async (band) => {
    const res = await get(`/v1/guides/pvz?band=${encodeURIComponent(band)}`);
    expect(res.status).toBe(200);
    expect(res.body.band).toBeNull();
    expect(res.body.openers.map((o) => o.buildKey)).toEqual([GLAIVES, ROBO]);
  });

  test("era clamp: before is served, anything else is the current era", async () => {
    const before = await get("/v1/guides/pvz?era=before");
    expect(before.body).toMatchObject({
      era: "before", published: false, openers: [], games: null, computedAt: run.computedAt.toISOString(),
    });
    const junk = await get("/v1/guides/pvz?era=yesterday&era=before");
    expect(junk.body.era).toBe("after");
    const repeated = await get("/v1/guides/pvz?band=league:4&band=mmr:4000");
    expect(repeated.body.band).toMatchObject({ type: "league", value: 4 });
  });

  test("sitemap: published pages only, lastModified = the run", async () => {
    const res = await get("/v1/guides/sitemap");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe(GUIDE_CACHE_CONTROL);
    const at = run.computedAt.toISOString();
    expect(res.body.computedAt).toBe(at);
    expect(res.body.entries.map((e) => e.path)).toEqual([
      "/guides",
      "/guides/pvz",
      "/guides/pvz/stargate-into-glaives",
      "/guides/pvz/counter",
      "/guides/pvz/counter/8-pool",
      "/guides/maps",
      "/guides/maps/site-delta-le",
    ]);
    expect(res.body.entries.every((e) => e.lastModified === at)).toBe(true);
  });

  test.each([
    ["/v1/guides/PvZ"],
    ["/v1/guides/pvx"],
    ["/v1/guides/pvz/not-a-build"],
    ["/v1/guides/pvz/Stargate-Into-Glaives"],
    ["/v1/guides/pvz/counter/not-a-strategy"],
    ["/v1/guides/tvz/stargate-into-glaives"],
    ["/v1/guides/maps/no-such-map"],
    ["/v1/guides/maps/Site-Delta-LE"],
    ["/v1/guides/me"],
  ])("unknown %s → 404 not_found with the short public cache", async (path) => {
    const res = await get(path);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "not_found" } });
    expect(res.headers["cache-control"]).toBe(GUIDE_NOT_FOUND_CACHE_CONTROL);
  });

  test("unmatched /guides paths and methods are 404s, never a later router's 401", async () => {
    for (const res of [
      await get("/v1/guides/pvz/stargate-into-glaives/extra"),
      await get("/v1/guides/pvz/counter/8-pool/extra"),
      await request(h.app).post("/v1/guides").send({}),
      await request(h.app).delete("/v1/guides/pvz"),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: "not_found" } });
    }
  });

  test("public routes never demand a token, and a bad token is not a 401", async () => {
    for (const path of ["/v1/guides", "/v1/guides/pvz", "/v1/guides/pvz/stargate-into-glaives", "/v1/guides/sitemap"]) {
      const anon = await get(path);
      expect(anon.status).toBe(200);
      const bad = await get(path).set("authorization", "Bearer garbage");
      expect(bad.status).toBe(200);
    }
  });
});

describe("GUIDES_ENABLED off", () => {
  let h;

  beforeAll(async () => {
    h = await createGuidesHarness({ enabled: false });
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  test.each([
    ["/v1/guides"], ["/v1/guides/pvz"], ["/v1/guides/pvz/stargate-into-glaives"], ["/v1/guides/sitemap"],
    ["/v1/guides/maps/site-delta-le"], ["/v1/guides/me/pvz/stargate-into-glaives"],
  ])("%s → 404 (never 401), not cached", async (path) => {
    const res = await request(h.app).get(path);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "not_found" } });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("the gate is path-scoped: other public routes still answer", async () => {
    const meta = await request(h.app).get("/v1/meta/ladder?axis=league&band=4&matchup=PvZ");
    expect(meta.status).toBe(404);
    expect(meta.body.error.code).toBe("not_enough_data");
    const sitemap = await request(h.app).get("/v1/community/sitemap");
    expect(sitemap.status).toBe(200);
  });
});
