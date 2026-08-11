// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { buildMeRouter, _internals } = require("../src/routes/me");

const counts = {
  totalGames: 9,
  archivedGames: 7,
  missingGames: 2,
  archiveComplete: false,
};

describe("me replay archive prompt state", () => {
  test("disabled replay storage never asks users to re-sync", () => {
    expect(
      _internals.withReplayResyncState(counts, {}, false),
    ).toMatchObject({
      enabled: false,
      backfillVersion: 0,
      requiresResync: false,
    });
  });

  test("a stale pre-v1 marker cannot suppress the current backfill", () => {
    expect(
      _internals.withReplayResyncState(
        counts,
        { version: 0, resyncRequestedAt: "2026-01-01T00:00:00Z" },
        true,
      ),
    ).toMatchObject({
      enabled: true,
      backfillVersion: 0,
      resyncRequestedAt: null,
      requiresResync: true,
    });
  });

  test("v1 acknowledgement stops repeat prompts despite missing local files", () => {
    expect(
      _internals.withReplayResyncState(
        counts,
        { version: 1, resyncRequestedAt: "2026-08-11T00:00:00Z" },
        true,
      ),
    ).toMatchObject({
      missingGames: 2,
      archiveComplete: false,
      backfillVersion: 1,
      requiresResync: false,
    });
  });

  test("a brand-new account never receives a re-sync prompt", () => {
    expect(
      _internals.withReplayResyncState(
        {
          totalGames: 0,
          archivedGames: 0,
          missingGames: 0,
          archiveComplete: true,
        },
        {},
        true,
      ).requiresResync,
    ).toBe(false);
  });
});

describe("disabled replay archive routes", () => {
  test("status stays quiet and device acknowledgement is rejected", async () => {
    const updatePreferences = jest.fn();
    const app = express();
    app.use(express.json());
    app.use(
      "/v1",
      buildMeRouter({
        auth: (req, _res, next) => {
          req.auth = { userId: "u1", source: "device" };
          next();
        },
        replayArchiveEnabled: false,
        users: {
          getPreferences: jest.fn(async () => ({})),
          updatePreferences,
        },
        games: {
          replayArchiveStatus: jest.fn(async () => counts),
        },
      }),
    );

    const status = await request(app).get("/v1/me/replay-archive-status");
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      enabled: false,
      requiresResync: false,
    });

    const ack = await request(app)
      .post("/v1/me/replay-archive-resync")
      .send({ agentVersion: "0.15.0" });
    expect(ack.status).toBe(503);
    expect(ack.body).toEqual({
      error: { code: "replay_storage_unavailable" },
    });
    expect(updatePreferences).not.toHaveBeenCalled();
  });
});
