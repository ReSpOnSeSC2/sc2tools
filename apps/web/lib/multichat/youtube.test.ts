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

  it("keeps live first-poll messages while suppressing old history", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-08-15T18:00:00Z");
    vi.setSystemTime(startedAt);
    const onMessage = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ continuation: "continuation-a", clientVersion: "2.1.0" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            messages: [
              {
                id: "old-history",
                user: "OldViewer",
                text: "from before the dock opened",
                badges: [],
                atMs: startedAt - 30_000,
              },
              {
                id: "clock-skew",
                user: "SkewedViewer",
                text: "just before the browser clock",
                badges: [],
                atMs: startedAt - 4_000,
              },
              {
                id: "new-live",
                user: "LiveViewer",
                text: "posted while the first poll was loading",
                badges: [],
                atMs: startedAt + 250,
              },
            ],
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
      callbacks: { onMessage, onStatus: vi.fn() },
    });
    for (let i = 0; i < 50 && fetchMock.mock.calls.length < 2; i += 1) {
      await Promise.resolve();
    }
    for (let i = 0; i < 20 && onMessage.mock.calls.length < 2; i += 1) {
      await Promise.resolve();
    }

    expect(onMessage.mock.calls.map(([message]) => message.id)).toEqual([
      "clock-skew",
      "new-live",
    ]);
    engine.close();
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

  it("keeps the poll continuation when the per-token limiter returns 429", async () => {
    vi.useFakeTimers();
    const onMessage = vi.fn();
    const onStatus = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ continuation: "continuation-a", clientVersion: "2.1.0" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            messages: [],
            events: [],
            continuation: "continuation-b",
            timeoutMs: 1_500,
            done: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "2" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            messages: [
              {
                id: "live-1",
                user: "Viewer",
                text: "message during backpressure",
                badges: [],
                atMs: 123,
              },
            ],
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
      callbacks: { onMessage, onStatus },
    });
    for (let i = 0; i < 50 && fetchMock.mock.calls.length < 2; i += 1) {
      await Promise.resolve();
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const limitedPollUrl = String(fetchMock.mock.calls[2][0]);
    const limitedPollBody = JSON.parse(String(fetchMock.mock.calls[2][1]?.body));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[3][0])).toBe(limitedPollUrl);
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toEqual(
      limitedPollBody,
    );
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "youtube",
        id: "live-1",
        text: "message during backpressure",
      }),
    );
    expect(onStatus).toHaveBeenCalledWith(
      "connecting",
      "rate limited; retrying",
    );
    const limitedAt = onStatus.mock.calls.findIndex(
      ([state, detail]) =>
        state === "connecting" && detail === "rate limited; retrying",
    );
    expect(
      onStatus.mock.calls.findIndex(
        ([state], index) => index > limitedAt && state === "connected",
      ),
    ).toBeGreaterThan(limitedAt);
    engine.close();
  });

  it("honors Retry-After when resolve itself is rate limited", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "2" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ continuation: "continuation-a", clientVersion: "2.1.0" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
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
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("/youtube/resolve?");
    engine.close();
  });
});
