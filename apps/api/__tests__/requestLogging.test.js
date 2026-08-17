// @ts-nocheck
"use strict";

const {
  sanitiseRequestForLog,
  sanitiseRequestUrl,
} = require("../src/middleware/requestLogging");

describe("request log sanitisation", () => {
  test.each([
    [
      "/v1/multichat/overlay-secret/youtube/poll?token=query-secret&channel=abc",
      "/v1/multichat/[redacted]/youtube/poll?token=%5Bredacted%5D&channel=abc",
    ],
    [
      "/v1/chatbot/a%2Fb%2Bc/mmr",
      "/v1/chatbot/[redacted]/mmr",
    ],
    [
      "/v1/overlay-tokens/token-to-revoke/widgets?apiKey=nope",
      "/v1/overlay-tokens/[redacted]/widgets?apiKey=%5Bredacted%5D",
    ],
    [
      "/v1/device-pairings/PAIR-ME-1234",
      "/v1/device-pairings/[redacted]",
    ],
    [
      "/v1/games/analysis-corpus?limit=2000&cursor=safe-cursor",
      "/v1/games/analysis-corpus?limit=2000&cursor=safe-cursor",
    ],
    [
      "/v1/integrations/twitch/callback?code=oauth-code&state=csrf-state&error=access_denied&error_description=nope&error_uri=https%3A%2F%2Fprovider.test%2Ferror&request_id=safe",
      "/v1/integrations/twitch/callback?code=%5Bredacted%5D&state=%5Bredacted%5D&error=%5Bredacted%5D&error_description=%5Bredacted%5D&error_uri=%5Bredacted%5D&request_id=safe",
    ],
    [
      "/v1/games?state=complete&code=protoss&error=0",
      "/v1/games?state=complete&code=protoss&error=0",
    ],
  ])("redacts credentials without losing route diagnostics: %s", (input, expected) => {
    expect(sanitiseRequestUrl(input)).toBe(expected);
  });

  test("logs only explicitly safe headers", () => {
    const req = {
      id: "request-id",
      method: "POST",
      originalUrl: "/v1/multichat/private-token/youtube/poll",
      headers: {
        host: "api.example.test",
        "user-agent": "test-agent",
        "content-length": "123",
        authorization: "Bearer never-log-me",
        cookie: "session=never-log-me",
        "x-admin-token": "never-log-me",
        "x-request-id": "caller-id",
      },
      socket: { remoteAddress: "127.0.0.1", remotePort: 4242 },
    };

    expect(sanitiseRequestForLog(req)).toEqual({
      id: "request-id",
      method: "POST",
      url: "/v1/multichat/[redacted]/youtube/poll",
      headers: {
        host: "api.example.test",
        "user-agent": "test-agent",
        "content-length": "123",
        "x-request-id": "caller-id",
      },
      remoteAddress: "127.0.0.1",
      remotePort: 4242,
    });
    const serialized = JSON.stringify(sanitiseRequestForLog(req));
    expect(serialized).not.toContain("never-log-me");
    expect(serialized).not.toContain("private-token");
  });
});
