// @ts-nocheck
"use strict";

const request = require("supertest");

jest.mock("@clerk/backend", () => require("./helpers/clerkMock")());

const { createHarness } = require("./helpers/reviewsHarness");

describe("review eligibility metadata on analyzer replay lists", () => {
  let h;
  const pulseId = "1-S2-1-700001";

  beforeAll(async () => {
    h = await createHarness();
    await h.seedUser("asker");
    const userId = h.userId("asker");
    await h.db.opponents.insertOne({
      userId,
      pulseId,
      displayNameSample: "Rival",
      race: "Zerg",
      mmr: 4100,
      gameCount: 4,
      wins: 4,
      losses: 0,
    });
    const game = (gameId, format) => ({
      userId,
      gameId,
      date: new Date(),
      result: "Victory",
      myRace: "Protoss",
      map: "Alcyone LE",
      durationSec: 640,
      opponent: { pulseId, displayName: "Rival", race: "Zerg", mmr: 4100 },
      ...format,
    });
    await h.db.games.insertMany([
      game("duel", { matchFormat: "1v1", playerCount: 2 }),
      game("team", { matchFormat: "team", playerCount: 4 }),
      game("ffa", { matchFormat: "ffa", playerCount: 8 }),
      game("legacy-team", { playerCount: 4 }),
      { ...game("other-user", { matchFormat: "1v1", playerCount: 2 }), userId: "u_other" },
    ]);
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  test.each([
    ["strategy and macro report", "/v1/games-list", "games"],
    ["opponent MMR drilldown", "/v1/opp-mmr-buckets/games?lo=4000&hi=4200", "games"],
    ["opponent history", `/v1/opponents/${pulseId}/games`, "items"],
    ["opponent profile", `/v1/opponents/${pulseId}`, "games"],
  ])("%s keeps matchup and format facts for the review action", async (_surface, url, key) => {
    const res = await request(h.app).get(url).set("authorization", h.bearer("asker"));
    expect(res.status).toBe(200);
    const rows = res.body[key];
    expect(rows).toHaveLength(4);
    expect(rows.find((row) => row.id === "duel")).toMatchObject({
      my_race: "Protoss", opp_race: "Zerg", matchFormat: "1v1", playerCount: 2,
    });
    expect(rows.find((row) => row.id === "team")).toMatchObject({
      matchFormat: "team", playerCount: 4,
    });
    expect(rows.find((row) => row.id === "ffa")).toMatchObject({
      matchFormat: "ffa", playerCount: 8,
    });
    // Legacy rows still need their player count: without it, the web would
    // treat this known four-player game as an unknown-format 1v1 candidate.
    expect(rows.find((row) => row.id === "legacy-team")).toMatchObject({ playerCount: 4 });
    expect(rows.some((row) => row.id === "other-user")).toBe(false);
  });
});
