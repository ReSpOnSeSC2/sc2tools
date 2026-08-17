// @ts-nocheck
"use strict";

const { captureClerkWebhookRawBody } = require("../src/middleware/jsonBody");

describe("JSON raw-body retention", () => {
  test("retains exact bytes for the signed Clerk webhook", () => {
    const req = { originalUrl: "/v1/webhooks/clerk?delivery=1" };
    const body = Buffer.from('{ "type": "user.created" }');
    captureClerkWebhookRawBody(req, {}, body);
    expect(req.rawBody).toBe(body);
  });

  test("does not retain multi-megabyte replay ingest buffers", () => {
    const req = { originalUrl: "/v1/games" };
    captureClerkWebhookRawBody(req, {}, Buffer.alloc(4 * 1024 * 1024));
    expect(req).not.toHaveProperty("rawBody");
  });

  test.each([
    "/v1/webhooks/twitch/eventsub",
    "/v1/webhooks/kick/events",
  ])("retains exact bytes for signed platform webhook %s", (url) => {
    const req = { originalUrl: url };
    const body = Buffer.from('{"signed":true}');
    captureClerkWebhookRawBody(req, {}, body);
    expect(req.rawBody).toBe(body);
  });
});
