// @ts-nocheck
"use strict";

/**
 * GET /v1/guides/me/:matchup/:build — the caller's own current-era record
 * with a guide build and the medians of their own guide_samples. Requires
 * auth (per route; the router stays public), is never cached, and never
 * reads another user's rows.
 */

const request = require("supertest");
const { createGuidesHarness, GLAIVES } = require("./helpers/guidesHarness");
const { slimGame, sampleRow, BEFORE_BUILD } = require("./helpers/guideStatsSeed");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const PATH = "/v1/guides/me/pvz/stargate-into-glaives";

describe("GET /v1/guides/me/:matchup/:build", () => {
  let h; let alice; let bob;
  const me = (name, path = PATH) => request(h.app).get(path).set("authorization", h.bearer(name));

  beforeAll(async () => {
    h = await createGuidesHarness();
    alice = await h.seedUser("alice");
    bob = await h.seedUser("bob");
    const hashOf = (userId) => h.services.guideSamples.userHash(userId);
    await h.db.games.insertMany([
      slimGame({ userId: alice, result: "Victory" }),
      slimGame({ userId: alice, result: "Victory" }),
      slimGame({ userId: alice, result: "Victory" }),
      slimGame({ userId: alice, result: "Defeat" }),
      slimGame({ userId: alice, result: "Tie" }),
      slimGame({ userId: alice, result: "Defeat", gameBuild: BEFORE_BUILD }),
      slimGame({ userId: alice, result: "Defeat", isLadderGame: false }),
      slimGame({ userId: alice, result: "Defeat", myBuild: "PvZ - Robo Opener" }),
      slimGame({ userId: alice, result: "Defeat", _customBuildSlug: "my-private-build" }),
      ...Array.from({ length: 7 }, () => slimGame({ userId: bob, result: "Defeat" })),
    ]);
    await h.db.guideSamples.insertMany([
      sampleRow({ userHash: hashOf(alice), milestones: { Pylon: 17, Gateway: 40 } }),
      sampleRow({ userHash: hashOf(alice), milestones: { Pylon: 19, Gateway: 44 } }),
      sampleRow({ userHash: hashOf(alice), milestones: { Pylon: 21 } }),
      sampleRow({ userHash: hashOf(alice), era: "before", milestones: { Pylon: 99 } }),
      sampleRow({ userHash: hashOf(alice), buildKey: "PvZ - Robo Opener", milestones: { Pylon: 99 } }),
      sampleRow({ userHash: hashOf(bob), milestones: { Pylon: 300, Gateway: 300 } }),
    ]);
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  test("the caller's own current-era record and sample medians, private and uncached", async () => {
    const res = await me("alice");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body).toEqual({
      matchup: "PvZ", buildKey: GLAIVES, era: "after", games: 5, wins: 3, losses: 1, winRate: 0.75,
      timings: {
        samples: 3,
        milestones: [
          expect.objectContaining({ key: "Pylon", event: "start", median: 19, games: 3 }),
          expect.objectContaining({ key: "Gateway", event: "start", median: 42, games: 2 }),
        ],
      },
    });
  });

  test("another user only ever sees their own numbers", async () => {
    const res = await me("bob");
    expect(res.body).toMatchObject({ games: 7, wins: 0, losses: 7, winRate: 0 });
    expect(res.body.timings).toEqual({
      samples: 1,
      milestones: [
        expect.objectContaining({ key: "Pylon", median: 300, games: 1 }),
        expect.objectContaining({ key: "Gateway", median: 300, games: 1 }),
      ],
    });
  });

  test("a user with no games gets zeros and a null win rate", async () => {
    await h.seedUser("carol");
    const res = await me("carol");
    expect(res.body).toEqual({
      matchup: "PvZ", buildKey: GLAIVES, era: "after", games: 0, wins: 0, losses: 0, winRate: null,
      timings: { samples: 0, milestones: [] },
    });
  });

  test("requires a signed-in caller", async () => {
    const anon = await request(h.app).get(PATH);
    expect(anon.status).toBe(401);
    const bad = await request(h.app).get(PATH).set("authorization", "Bearer garbage");
    expect(bad.status).toBe(401);
  });

  test.each([
    ["/v1/guides/me/pvz/not-a-build"],
    ["/v1/guides/me/PvZ/stargate-into-glaives"],
    ["/v1/guides/me/tvz/stargate-into-glaives"],
  ])("unknown %s → private 404", async (path) => {
    const res = await me("alice", path);
    expect(res.status).toBe(404);
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });
});
