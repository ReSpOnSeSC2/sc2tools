// @ts-nocheck
"use strict";
const express = require("express");
const request = require("supertest");
const { savedClipRecorder, savedClipName, savedClipEndedAt, SAVED_CLIP_NAME_MAX } = require("../src/services/streamSavedClip");
const { buildAgentStreamingRouter } = require("../src/routes/agentStreaming");
const { CLIP_MOMENT_KINDS } = require("../src/services/multichatEngagement");

const NAME = "2026-11-28 21-05 PvZ Victory vs Barcode on Alcyone LE";

describe("savedClipName", () => {
  test.each([
    ["a file name", NAME, NAME],
    ["padding", `  ${NAME}  `, NAME],
  ])("accepts %s", (_label, input, expected) => expect(savedClipName(input)).toBe(expected));

  test.each([
    ["nothing", undefined], ["a number", 7], ["an empty name", "   "], ["a line break", "a\nb"],
    ["a control character", "a\u0007b"], ["a name over the limit", "x".repeat(SAVED_CLIP_NAME_MAX + 1)],
  ])("refuses %s", (_label, input) => expect(savedClipName(input)).toBeNull());
});

describe("savedClipEndedAt", () => {
  const now = 1_800_000_000_000;
  test.each([
    ["a minute ago", now - 60_000, now - 60_000],
    ["a fractional time", now - 1000.4, now - 1000],
  ])("keeps %s", (_label, input, expected) => expect(savedClipEndedAt(input, now)).toBe(expected));

  test.each([
    ["nothing", undefined], ["a string", String(now)], ["not a number", NaN], ["a day ago", now - 24 * 3600_000],
    ["an hour from now", now + 3600_000],
  ])("ignores %s", (_label, input) => expect(savedClipEndedAt(input, now)).toBeNull());
});

describe("savedClipRecorder", () => {
  test("stamps the clip with when its game ended, not when it was filed", async () => {
    const recordMoment = jest.fn(async () => ({}));
    const record = savedClipRecorder({ engagement: { recordMoment }, overlayTokens: { list: async () => [{ token: "a" }] }, now: () => 5_000_000 });
    await record("u", NAME, 4_400_000);
    await record("u", NAME, "junk");
    expect(recordMoment.mock.calls).toEqual([
      ["a", { kind: "clip-saved", reason: NAME, atMs: 4_400_000 }],
      ["a", { kind: "clip-saved", reason: NAME }],
    ]);
  });

  const recorder = (tokens, recordMoment) => savedClipRecorder({
    engagement: { recordMoment }, overlayTokens: { list: async () => tokens },
  });

  test("lists the clip on every live Dock of the streamer, and not on a revoked one", async () => {
    const recordMoment = jest.fn(async () => ({}));
    const listed = await recorder([{ token: "a" }, { token: "b", revokedAt: new Date() }, { token: "c" }], recordMoment)("u", NAME);
    expect(listed).toBe(2);
    expect(recordMoment.mock.calls).toEqual([
      ["a", { kind: "clip-saved", reason: NAME }],
      ["c", { kind: "clip-saved", reason: NAME }],
    ]);
  });

  test("a Dock that cannot take it right now is skipped, any other failure is not hidden", async () => {
    const busy = Object.assign(new Error("rotating"), { code: "overlay_rotation_pending" });
    const recordMoment = jest.fn(async (token) => { if (token === "a") throw busy; return {}; });
    expect(await recorder([{ token: "a" }, { token: "b" }], recordMoment)("u", NAME)).toBe(1);
    await expect(recorder([{ token: "a" }], async () => { throw new Error("db down"); })("u", NAME)).rejects.toThrow("db down");
  });

  test("the moment kind is one the engagement service stores as it is", () => {
    expect(CLIP_MOMENT_KINDS).toContain("clip-saved");
  });
});

describe("POST /v1/agent/streaming/clip", () => {
  const app = ({ auth = { userId: "u", source: "device" }, engagement, overlayTokens } = {}) => {
    const server = express();
    server.use(express.json());
    server.use("/v1", buildAgentStreamingRouter({ auth: (req, _res, next) => { req.auth = auth; next(); },
      integrations: {}, streamingTitles: {}, engagement, overlayTokens }));
    server.use((error, _req, res, _next) => res.status(error.status || 500).json({ code: error.code }));
    return server;
  };
  const wired = () => {
    const recordMoment = jest.fn(async () => ({}));
    return { recordMoment, engagement: { recordMoment }, overlayTokens: { list: async () => [{ token: "t" }] } };
  };

  test("lists the paired account's clip and says how many Docks have it", async () => {
    const { recordMoment, ...deps } = wired();
    const response = await request(app(deps)).post("/v1/agent/streaming/clip").send({ name: NAME }).expect(200);
    expect(response.body).toEqual({ listed: 1 });
    expect(recordMoment).toHaveBeenCalledWith("t", { kind: "clip-saved", reason: NAME });
  });

  test("passes the game's end time to the Dock", async () => {
    const { recordMoment, ...deps } = wired();
    const endedAtMs = Date.now() - 30_000;
    await request(app(deps)).post("/v1/agent/streaming/clip").send({ name: NAME, endedAtMs }).expect(200);
    expect(recordMoment).toHaveBeenCalledWith("t", { kind: "clip-saved", reason: NAME, atMs: endedAtMs });
  });

  test.each([
    ["a user id beside the name", { name: NAME, userId: "other" }],
    ["no name", {}],
    ["a name with a line break", { name: "a\nb" }],
  ])("refuses %s", async (_label, body) => {
    const { recordMoment, ...deps } = wired();
    await request(app(deps)).post("/v1/agent/streaming/clip").send(body).expect(400);
    expect(recordMoment).not.toHaveBeenCalled();
  });

  test("needs an account, and a server without the engagement service answers unavailable", async () => {
    const { recordMoment, ...deps } = wired();
    await request(app({ ...deps, auth: { source: "device" } })).post("/v1/agent/streaming/clip").send({ name: NAME }).expect(401);
    await request(app()).post("/v1/agent/streaming/clip").send({ name: NAME }).expect(503);
    expect(recordMoment).not.toHaveBeenCalled();
  });
});
