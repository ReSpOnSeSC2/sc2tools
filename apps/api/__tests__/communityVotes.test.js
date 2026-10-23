// @ts-nocheck
"use strict";

const request = require("supertest");
const { startHarness } = require("./helpers/browserIngestHarness");
jest.mock("@clerk/backend", () => ({ verifyToken: jest.fn(async () => ({ sub: "clerk_vote_reader" })) }));

describe("atomic community votes", () => {
  let h;
  beforeAll(async () => { h = await startHarness("community_votes"); });
  afterAll(async () => { if (h) await h.stop(); });
  beforeEach(async () => {
    await h.db.communityBuilds.deleteMany({});
    await h.db.communityBuilds.insertOne({ slug: "macro", title: "Macro", removed: false, upvotes: [], downvotes: [], votes: 0, publishedAt: new Date() });
  });
  const post = (delta) => request(h.app).post("/v1/community/builds/macro/vote").set("authorization", "Bearer member").send({ delta });

  test("three identical upvotes count once and changed reflects stored state", async () => {
    const answers = [];
    for (let i = 0; i < 3; i++) answers.push(await h.services.community.vote("one", "macro", 1));
    expect(answers).toEqual([{ votes: 1, myVote: 1, changed: true }, { votes: 1, myVote: 1, changed: false }, { votes: 1, myVote: 1, changed: false }]);
  });
  test("the route returns authoritative scores, switches by two, and clears with zero", async () => {
    expect((await post(1)).body).toEqual({ votes: 1, myVote: 1 });
    expect((await post(-1)).body).toEqual({ votes: -1, myVote: -1 });
    const mine = await request(h.app).get("/v1/community/builds/macro/my-vote").set("authorization", "Bearer member");
    expect(mine.status).toBe(200); expect(mine.headers["cache-control"]).toBe("private, no-store");
    expect(mine.body).toEqual({ votes: -1, myVote: -1 });
    expect((await post(0)).body).toEqual({ votes: 0, myVote: 0 });
  });
  test.each([2, null, "1"])("rejects invalid delta %p without writing", async (delta) => {
    const res = await post(delta); expect(res.status).toBe(400); expect(res.body.error.message).toBe("delta must be -1, 0 or 1");
    expect((await h.db.communityBuilds.findOne({ slug: "macro" })).votes).toBe(0);
  });
  test("removed and missing builds are 404 for writes and private reads", async () => {
    await h.db.communityBuilds.updateOne({ slug: "macro" }, { $set: { removed: true } });
    expect((await post(1)).status).toBe(404);
    for (const slug of ["macro", "missing"]) {
      const answer = await request(h.app).get(`/v1/community/builds/${slug}/my-vote`).set("authorization", "Bearer member");
      expect(answer.status).toBe(404);
    }
  });
  test("concurrent writers cannot drift the cached score", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => h.services.community.vote(`user-${i}`, "macro", 1)));
    await Promise.all(Array.from({ length: 10 }, (_, i) => h.services.community.vote(`user-${i}`, "macro", -1)));
    const row = await h.db.communityBuilds.findOne({ slug: "macro" });
    expect(row.upvotes).toHaveLength(10); expect(row.downvotes).toHaveLength(10); expect(row.votes).toBe(0);
  });
  test("controversial favors divided votes and never returns its private calculation fields", async () => {
    await h.db.communityBuilds.deleteMany({});
    await h.db.communityBuilds.insertMany([[5, 5], [3, 2], [1, 1], [40, 0]].map(([up, down], i) => ({
      slug: `split-${i}`, title: "Split", removed: false, publishedAt: new Date(), votes: up - down,
      upvotes: Array.from({ length: up }, (_, n) => `u${n}`), downvotes: Array.from({ length: down }, (_, n) => `d${n}`),
    })));
    const out = await h.services.community.listPublic({ sort: "controversial" });
    expect(out.items.map((row) => row.slug)).toEqual(["split-0", "split-1", "split-2", "split-3"]);
    for (const row of out.items) for (const key of ["up", "down", "total", "minV", "maxV", "controversy", "upvotes", "downvotes"]) expect(row).not.toHaveProperty(key);
  });
});
