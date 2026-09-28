// @ts-nocheck
"use strict";

/**
 * GET /v1/community/sitemap — published community build slugs and the
 * opt-in public profile handles (owners of a named, published build) for
 * the web sitemap. Public, cached like the guides, slugs/handles/dates only.
 */

const request = require("supertest");
const { GUIDE_CACHE_CONTROL } = require("../src/config/guides");
const { COMMUNITY_SITEMAP_MAX } = require("../src/services/communitySitemap");
const { createGuidesHarness } = require("./helpers/guidesHarness");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const day = (n) => new Date(Date.UTC(2026, 8, n));

describe("GET /v1/community/sitemap", () => {
  let h;
  const get = () => request(h.app).get("/v1/community/sitemap");

  beforeAll(async () => {
    h = await createGuidesHarness({ enabled: false });
  });

  beforeEach(async () => {
    await h.db.communityBuilds.deleteMany({});
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  test("published builds newest first; named authors become profiles", async () => {
    await h.db.communityBuilds.insertMany([
      { slug: "build-a", ownerUserId: "author-1", authorName: "Alice", removed: false, publishedAt: day(1), updatedAt: day(5) },
      { slug: "build-b", ownerUserId: "author-1", authorName: "Alice", removed: false, publishedAt: day(7) },
      { slug: "build-c", ownerUserId: "author-2", authorName: "", removed: false, publishedAt: day(3), updatedAt: day(4) },
      { slug: "build-d", ownerUserId: "author-3", authorName: "  ", removed: false, publishedAt: day(2), updatedAt: day(2) },
      { slug: "build-e", ownerUserId: "author-4", authorName: "Removed", removed: true, publishedAt: day(9), updatedAt: day(9) },
      { slug: "build-f", ownerUserId: "author-2", authorName: "Bob", removed: false, publishedAt: day(6), updatedAt: day(1) },
      { slug: "bad slug!", ownerUserId: "author-5", authorName: "Eve", removed: false, publishedAt: day(8) },
      { slug: "build-g", ownerUserId: "bad handle/with slash", authorName: "Mallory", removed: false, publishedAt: day(1) },
      { slug: "build-undated", ownerUserId: "author-6", authorName: "Nodate", removed: false },
    ]);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe(GUIDE_CACHE_CONTROL);
    expect(res.body.builds).toEqual([
      { slug: "build-b", lastModified: day(7).toISOString() },
      { slug: "build-f", lastModified: day(6).toISOString() },
      { slug: "build-a", lastModified: day(5).toISOString() },
      { slug: "build-c", lastModified: day(4).toISOString() },
      { slug: "build-d", lastModified: day(2).toISOString() },
      { slug: "build-g", lastModified: day(1).toISOString() },
    ]);
    expect(res.body.profiles).toEqual([
      { handle: "author-5", lastModified: day(8).toISOString() },
      { handle: "author-1", lastModified: day(7).toISOString() },
      { handle: "author-2", lastModified: day(6).toISOString() },
    ]);
    expect(Object.keys(res.body).sort()).toEqual(["builds", "profiles"]);
  });

  test("needs no token and ignores a bad one", async () => {
    const res = await get().set("authorization", "Bearer garbage");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ builds: [], profiles: [] });
  });

  test(`each list is capped at ${COMMUNITY_SITEMAP_MAX}, newest kept`, async () => {
    const base = day(1).getTime();
    const docs = Array.from({ length: COMMUNITY_SITEMAP_MAX + 5 }, (_, i) => ({
      slug: `build-${i}`, ownerUserId: `author-${i}`, authorName: "Named", removed: false,
      publishedAt: new Date(base + i * 1000),
    }));
    await h.db.communityBuilds.insertMany(docs);
    const res = await get();
    expect(res.body.builds).toHaveLength(COMMUNITY_SITEMAP_MAX);
    expect(res.body.profiles).toHaveLength(COMMUNITY_SITEMAP_MAX);
    expect(res.body.builds[0].slug).toBe(`build-${COMMUNITY_SITEMAP_MAX + 4}`);
    expect(res.body.builds.some((b) => b.slug === "build-0")).toBe(false);
  });
});
