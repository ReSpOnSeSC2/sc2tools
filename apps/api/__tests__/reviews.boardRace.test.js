"use strict";

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());
const request = require("supertest");
const { createHarness } = require("./helpers/reviewsHarness");

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
beforeAll(async () => {
  h = await createHarness();
  for (const matchup of ["PvZ", "PvT", "TvZ"]) {
    await h.seedUser(matchup);
    const gameId = await h.seedGame(matchup);
    const response = await request(h.app).post("/v1/reviews").set("authorization", h.bearer(matchup))
      .send({ gameId, question: `How should I scout this ${matchup} attack before moving out?` });
    expect(response.status).toBe(201);
    const update = await h.db.reviewRequests.updateOne({ _id: response.body.id }, { $set: { matchup } });
    expect(update.matchedCount).toBe(1);
  }
}, 60_000);
afterAll(async () => { if (h) await h.close(); });

test("race filters by the asker's matchup prefix while leaving the opponent unrestricted", async () => {
  const response = await request(h.app).get("/v1/reviews?race=P");
  expect(response.status).toBe(200);
  expect(response.body.items.map((/** @type {{matchup: string}} */ item) => item.matchup).sort()).toEqual(["PvT", "PvZ"]);
  const terran = await request(h.app).get("/v1/reviews?race=T");
  expect(terran.body.items.map((/** @type {{matchup: string}} */ item) => item.matchup)).toEqual(["TvZ"]);
});

test("an exact matchup wins over a conflicting race, and invalid races are ignored", async () => {
  const exact = await request(h.app).get("/v1/reviews?race=T&matchup=PvZ");
  expect(exact.status).toBe(200);
  expect(exact.body.items.map((/** @type {{matchup: string}} */ item) => item.matchup)).toEqual(["PvZ"]);
  for (const race of ["Protoss", ".*", "p", "P|T"]) {
    const response = await request(h.app).get("/v1/reviews").query({ race });
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(3);
  }
});
