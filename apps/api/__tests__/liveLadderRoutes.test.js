// @ts-nocheck
"use strict";

/**
 * routes/liveLadderRoutes.js: the ladder VOD finder is handed the pros board's
 * SC2Pulse client, so the two share one pace. Without that argument each would
 * make its own client and SC2Pulse could get two calls inside one pace.
 */

jest.mock("../src/routes/ladderVods", () => ({
  buildLadderVodsRouter: jest.fn(() => require("express").Router()),
  ladderVodsFromDeps: jest.fn(() => ({})),
}));

const express = require("express");
const { mountLiveLadderRoutes, proBoardFromDeps } = require("../src/routes/liveLadderRoutes");
const { ladderVodsFromDeps } = require("../src/routes/ladderVods");

describe("mountLiveLadderRoutes", () => {
  test("gives the finder the board's own paced client and its map pool", () => {
    const liveStreams = { list: async () => ({ streams: [] }) };
    const proBoard = proBoardFromDeps({ logger: {} }, liveStreams);
    const deps = { config: {}, logger: {} };
    const pool = { get: async () => null };
    mountLiveLadderRoutes(express(), "/v1", { deps, services: { liveStreams, seasons: { ladderMapPool: pool }, proBoard } });
    expect(ladderVodsFromDeps).toHaveBeenCalledTimes(1);
    const [seenDeps, seenPool, seenPulse] = ladderVodsFromDeps.mock.calls[0];
    expect(seenDeps).toBe(deps);
    expect(seenPool).toBe(pool);
    expect(seenPulse).toBe(proBoard.pulse);
  });
});
