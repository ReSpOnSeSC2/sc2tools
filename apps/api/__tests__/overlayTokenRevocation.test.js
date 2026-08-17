// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { buildOverlayTokensRouter } = require("../src/routes/overlayTokens");

function buildHarness(revokeResult = true) {
  const revoke = jest.fn(async () => revokeResult);
  const disconnectSockets = jest.fn();
  const room = { disconnectSockets };
  const io = { in: jest.fn(() => room) };
  const auth = (req, _res, next) => {
    req.auth = { userId: "owner-1", source: "clerk" };
    next();
  };
  const app = express();
  app.use(express.json());
  app.use("/v1", buildOverlayTokensRouter({
    auth,
    io,
    overlayTokens: { revoke },
  }));
  return { app, revoke, io, disconnectSockets };
}

describe("overlay token socket revocation", () => {
  test("disconnects every socket in the owned token room after durable revoke", async () => {
    const { app, revoke, io, disconnectSockets } = buildHarness(true);

    const response = await request(app)
      .delete("/v1/overlay-tokens/tok-owned");

    expect(response.status).toBe(204);
    expect(revoke).toHaveBeenCalledWith("owner-1", "tok-owned");
    expect(io.in).toHaveBeenCalledWith("overlay:tok-owned");
    expect(disconnectSockets).toHaveBeenCalledWith(true);
  });

  test("does not let a wrong-owner revoke disconnect another token room", async () => {
    const { app, io, disconnectSockets } = buildHarness(false);

    const response = await request(app)
      .delete("/v1/overlay-tokens/tok-other-user");

    expect(response.status).toBe(204);
    expect(io.in).not.toHaveBeenCalled();
    expect(disconnectSockets).not.toHaveBeenCalled();
  });

  test("keeps the successful revoke response if adapter disconnect already raced closed", async () => {
    const { app, disconnectSockets } = buildHarness(true);
    disconnectSockets.mockImplementation(() => {
      throw new Error("socket already closed");
    });

    const response = await request(app)
      .delete("/v1/overlay-tokens/tok-raced");

    expect(response.status).toBe(204);
    expect(disconnectSockets).toHaveBeenCalledWith(true);
  });
});
