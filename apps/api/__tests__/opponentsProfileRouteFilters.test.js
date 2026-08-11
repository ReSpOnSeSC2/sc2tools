// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");

const { buildOpponentsRouter } = require("../src/routes/opponents");

describe("GET /opponents/:pulseId analyzer scope", () => {
  test("forwards every parsed filter to the profile service", async () => {
    const get = jest.fn(async () => ({ games: [], totals: { total: 0 } }));
    const auth = (req, _res, next) => {
      req.auth = { userId: "route-filter-user" };
      next();
    };
    const app = express();
    app.use(buildOpponentsRouter({ opponents: { get }, auth }));

    const res = await request(app).get(
      "/opponents/opp-1"
      + "?since=2026-07-01T00%3A00%3A00.000Z"
      + "&map_pool=ladder&game_size=1v1"
      + "&opp_race=T&exclude_too_short=true&mergeLinked=1",
    );

    expect(res.status).toBe(200);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(
      "route-filter-user",
      "opp-1",
      {
        filters: expect.objectContaining({
          since: new Date("2026-07-01T00:00:00.000Z"),
          mapPool: "ladder",
          gameSize: "1v1",
          oppRace: "T",
          excludeTooShort: true,
        }),
        mergeLinked: true,
      },
    );
  });
});
