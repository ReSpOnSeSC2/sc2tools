import { afterEach, describe, expect, it, vi } from "vitest";

import { createYoutubeChat, retryAfterMs } from "./youtube";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("YouTube chat backpressure", () => {
  it("honors and safely clamps Retry-After seconds", () => {
    expect(retryAfterMs("2", 10_000)).toBe(2_000);
    expect(retryAfterMs("0.1", 10_000)).toBe(1_000);
    expect(retryAfterMs("999", 10_000)).toBe(30_000);
  });

  it("uses the ordinary retry delay for a missing or invalid header", () => {
    expect(retryAfterMs(null, 10_000)).toBe(10_000);
    expect(retryAfterMs("later", 10_000)).toBe(10_000);
  });

  it("retries the same continuation after API backpressure", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ continuation: "continuation-a", clientVersion: "2.1.0" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response("busy", { status: 503, headers: { "retry-after": "2" } }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            messages: [],
            events: [],
            continuation: null,
            timeoutMs: 4_000,
            done: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const engine = createYoutubeChat({
      apiBase: "https://api.example.test",
      token: "overlay-token",
      channel: "channel",
      callbacks: { onMessage: vi.fn(), onStatus: vi.fn() },
    });
    for (let i = 0; i < 50 && fetchMock.mock.calls.length < 2; i += 1) {
      await Promise.resolve();
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstPollBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const retriedPollBody = JSON.parse(String(fetchMock.mock.calls[2][1]?.body));
    expect(retriedPollBody).toEqual(firstPollBody);
    engine.close();
  });
});
