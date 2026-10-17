import { afterEach, describe, expect, it, vi } from "vitest";

import { createYoutubeChat, retryAfterMs } from "./youtube";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const VIDEO_A = "landscape01";
const VIDEO_B = "portrait002";

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function resolved(videoId: string, continuation = `${videoId}-start`) {
  return { videoId, continuation, clientVersion: "2.1.0" };
}

function livePoll(continuation: string, messages: unknown[] = [], events: unknown[] = [], timeoutMs = 5_000) {
  return { messages, events, continuation, timeoutMs, done: false };
}

function message(id: string, atMs = Date.now()) {
  return { id, user: "Viewer", text: id, badges: [], atMs };
}

function event(id: string, atMs = Date.now()) {
  return { id, kind: "superchat", user: "Supporter", detail: "sent support", atMs };
}

async function settleRequests() {
  for (let i = 0; i < 60; i += 1) await Promise.resolve();
}

describe("YouTube simultaneous broadcasts", () => {
  it("merges independent landscape and portrait cursors with stable stream-scoped identities", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const onMessage = vi.fn();
    const onEvent = vi.fn();
    const onStatus = vi.fn();
    const polls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/resolve?")) return jsonResponse({
        ...resolved(VIDEO_A), sessions: [resolved(VIDEO_A), resolved(VIDEO_B)],
      });
      const { continuation } = JSON.parse(String(init?.body));
      polls.push(continuation);
      return jsonResponse(livePoll(`${continuation}-next`, [message("same-id", startedAt - 30_000)], [
        { ...event("same-event", startedAt - 30_000), updateKey: "combo", updateVersion: 1 },
      ]));
    }));
    const engine = createYoutubeChat({ apiBase: "https://api.test", token: "tok", channel: "@channel",
      callbacks: { onMessage, onEvent, onStatus } });
    await settleRequests();

    expect(polls).toEqual([`${VIDEO_A}-start`, `${VIDEO_B}-start`]);
    expect(onMessage.mock.calls.map(([item]) => item.id)).toEqual([`${VIDEO_A}:same-id`, `${VIDEO_B}:same-id`]);
    expect(onMessage.mock.calls.every(([item]) => item.backlog === true)).toBe(true);
    expect(onEvent.mock.calls.map(([item]) => [item.id, item.updateKey, item.replayed])).toEqual([
      [`${VIDEO_A}:same-event`, `${VIDEO_A}:combo`, true],
      [`${VIDEO_B}:same-event`, `${VIDEO_B}:combo`, true],
    ]);
    expect(onStatus).toHaveBeenLastCalledWith("connected", "2 live chats");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(polls.slice(2)).toEqual([`${VIDEO_A}-start-next`, `${VIDEO_B}-start-next`]);
    // Repeated history does not repeat message callbacks or event side effects.
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenCalledTimes(2);
    engine.close();
  });

  it.each(["network", "malformed", 500, 502, 429, 503])(
    "preserves the exact cursor across transient %s failures",
    async (failure) => {
      vi.useFakeTimers();
      const onMessage = vi.fn();
      const cursors: string[] = [];
      let resolves = 0;
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/resolve?")) {
          resolves += 1;
          return jsonResponse(resolved(VIDEO_A));
        }
        const { continuation } = JSON.parse(String(init?.body));
        cursors.push(continuation);
        if (cursors.length === 1) return jsonResponse(livePoll("cursor-b", [], [], 1_000));
        if (cursors.length === 2) {
          if (failure === "network") throw new Error("connection lost");
          if (failure === "malformed") return jsonResponse({ messages: [] });
          return jsonResponse({ error: { code: "upstream" } }, Number(failure));
        }
        return jsonResponse(livePoll("cursor-c", [message("during-outage")], [], 30_000));
      }));
      const engine = createYoutubeChat({ apiBase: "https://api.test", token: "tok", channel: "channel",
        callbacks: { onMessage, onStatus: vi.fn() } });
      await settleRequests();
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(cursors).toEqual([`${VIDEO_A}-start`, "cursor-b", "cursor-b"]);
      expect(resolves).toBe(1);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ id: `${VIDEO_A}:during-outage` }));
      engine.close();
    },
  );

  it("discovers a newly started broadcast without resetting a known cursor or duplicating its poller", async () => {
    vi.useFakeTimers();
    let resolveCount = 0;
    let sequenceA = 0;
    const cursors: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/resolve?")) {
        resolveCount += 1;
        return jsonResponse({ sessions: resolveCount === 1
          ? [resolved(VIDEO_A)]
          : [resolved(VIDEO_A, "stale-discovery-cursor"), resolved(VIDEO_B)] });
      }
      const { continuation } = JSON.parse(String(init?.body));
      cursors.push(continuation);
      return jsonResponse(livePoll(continuation.startsWith(VIDEO_B) ? continuation : `cursor-a-${++sequenceA}`, [], [], 10_000));
    }));
    const engine = createYoutubeChat({ apiBase: "https://api.test", token: "tok", channel: "@channel",
      callbacks: { onMessage: vi.fn(), onStatus: vi.fn() } });
    await settleRequests();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(resolveCount).toBe(2);
    expect(cursors.filter((cursor) => cursor === `${VIDEO_A}-start`)).toHaveLength(1);
    expect(cursors).not.toContain("stale-discovery-cursor");
    expect(cursors).toContain(`${VIDEO_B}-start`);
    expect(cursors.filter((cursor) => cursor.startsWith("cursor-a-")).length).toBe(6);
    engine.close();
  });

  it("keeps a healthy broadcast polling when another ends", async () => {
    vi.useFakeTimers();
    const onStatus = vi.fn();
    const cursors: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/resolve?")) return jsonResponse({ sessions: [resolved(VIDEO_A), resolved(VIDEO_B)] });
      const { continuation } = JSON.parse(String(init?.body));
      cursors.push(continuation);
      return jsonResponse(continuation.startsWith(VIDEO_A)
        ? { messages: [], continuation: null, timeoutMs: 5_000, done: true }
        : livePoll(continuation));
    }));
    const engine = createYoutubeChat({ apiBase: "https://api.test", token: "tok", channel: "channel",
      callbacks: { onMessage: vi.fn(), onStatus } });
    await settleRequests();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(cursors.filter((cursor) => cursor.startsWith(VIDEO_A))).toHaveLength(1);
    expect(cursors.filter((cursor) => cursor.startsWith(VIDEO_B))).toHaveLength(4);
    expect(onStatus).toHaveBeenLastCalledWith("connected", undefined);
    engine.close();
  });

  it("does not start a second poll when discovery runs during an existing request", async () => {
    vi.useFakeTimers();
    let resolves = 0;
    let polls = 0;
    let finishPoll: (value: Response) => void = () => undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/resolve?")) {
        resolves += 1;
        return jsonResponse({ sessions: [resolved(VIDEO_A, `discovery-${resolves}`)] });
      }
      polls += 1;
      if (polls === 12) return new Promise<Response>((resolve) => { finishPoll = resolve; });
      return jsonResponse(livePoll(`poll-${polls}`));
    }));
    const engine = createYoutubeChat({ apiBase: "https://api.test", token: "tok", channel: "channel",
      callbacks: { onMessage: vi.fn(), onStatus: vi.fn() } });
    await settleRequests();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(resolves).toBe(2);
    expect(polls).toBe(12);
    finishPoll(jsonResponse(livePoll("after-discovery")));
    await settleRequests();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(polls).toBe(13);
    engine.close();
  });

  it("keeps messages posted while an initial resolve is loading live", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    let finishResolve: (value: Response) => void = () => undefined;
    const onMessage = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/resolve?")) return new Promise<Response>((resolve) => { finishResolve = resolve; });
      return jsonResponse(livePoll("next", [message("while-resolving", startedAt + 1_000)]));
    }));
    const engine = createYoutubeChat({ apiBase: "https://api.test", token: "tok", channel: "channel",
      callbacks: { onMessage, onStatus: vi.fn() } });
    await vi.advanceTimersByTimeAsync(10_000);
    finishResolve(jsonResponse(resolved(VIDEO_A)));
    await settleRequests();

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ id: `${VIDEO_A}:while-resolving` }));
    expect(onMessage.mock.calls[0][0].backlog).toBeUndefined();
    engine.close();
  });

  it("renews an invalid cursor while retaining deduplication and messages accumulated during recovery", async () => {
    vi.useFakeTimers();
    let resolves = 0;
    const cursors: string[] = [];
    const onMessage = vi.fn();
    const initialAt = Date.now();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/resolve?")) return jsonResponse(resolved(VIDEO_A, ++resolves === 1 ? "initial" : "renewed"));
      const { continuation } = JSON.parse(String(init?.body));
      cursors.push(continuation);
      if (continuation === "initial") return jsonResponse(livePoll("expired", [message("already-seen", initialAt)], [], 1_000));
      if (continuation === "expired") return jsonResponse({ error: { code: "bad_input" } }, 400);
      return jsonResponse(livePoll("current", [message("already-seen", initialAt), message("during-recovery", initialAt + 1_500)]));
    }));
    const engine = createYoutubeChat({ apiBase: "https://api.test", token: "tok", channel: "channel",
      callbacks: { onMessage, onStatus: vi.fn() } });
    await settleRequests();
    await vi.advanceTimersByTimeAsync(11_000);

    expect(cursors).toEqual(["initial", "expired", "renewed"]);
    expect(onMessage.mock.calls.map(([item]) => item.id)).toEqual([`${VIDEO_A}:already-seen`, `${VIDEO_A}:during-recovery`]);
    expect(onMessage.mock.calls[1][0].backlog).toBeUndefined();
    engine.close();
  });

  it("does not cancel or reset healthy sessions for partially invalid or empty discovery responses", async () => {
    vi.useFakeTimers();
    let resolves = 0;
    const cursors: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/resolve?")) {
        resolves += 1;
        return jsonResponse(resolves === 1 ? { sessions: [resolved(VIDEO_A)] }
          : resolves === 2 ? { sessions: [{ videoId: VIDEO_A }, resolved(VIDEO_B)] } : { sessions: [] });
      }
      const { continuation } = JSON.parse(String(init?.body));
      cursors.push(continuation);
      return jsonResponse(livePoll(continuation, [], [], 30_000));
    }));
    const engine = createYoutubeChat({ apiBase: "https://api.test", token: "tok", channel: "channel",
      callbacks: { onMessage: vi.fn(), onStatus: vi.fn() } });
    await settleRequests();
    await vi.advanceTimersByTimeAsync(130_000);

    expect(resolves).toBe(4);
    expect(cursors.filter((cursor) => cursor.startsWith(VIDEO_A))).toHaveLength(5);
    expect(cursors.filter((cursor) => cursor.startsWith(VIDEO_B))).toHaveLength(3);
    engine.close();
  });

  it("bounds active broadcast loops and first-poll history", async () => {
    vi.useFakeTimers();
    const onMessage = vi.fn();
    const onEvent = vi.fn();
    let polls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/resolve?")) return jsonResponse({ sessions: Array.from({ length: 15 }, (_, index) =>
        resolved(`video${String(index).padStart(6, "0")}`)) });
      polls += 1;
      return jsonResponse(livePoll("next", Array.from({ length: 250 }, (_, index) => message(String(index), Date.now() - 20_000)),
        Array.from({ length: 75 }, (_, index) => event(String(index), Date.now() - 20_000))));
    }));
    const engine = createYoutubeChat({ apiBase: "https://api.test", token: "tok", channel: "channel",
      callbacks: { onMessage, onEvent, onStatus: vi.fn() } });
    await settleRequests();

    expect(polls).toBe(10);
    expect(onMessage).toHaveBeenCalledTimes(10 * 200);
    expect(onEvent).toHaveBeenCalledTimes(10 * 50);
    expect(onMessage.mock.calls[0][0].id).toBe("video000000:50");
    expect(onEvent.mock.calls[0][0].id).toBe("video000000:25");
    engine.close();
  });

  it("ignores a late resolve response after close and aborts its request", async () => {
    vi.useFakeTimers();
    let finish: (value: Response) => void = () => undefined;
    let signal: AbortSignal | null | undefined;
    const onStatus = vi.fn();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>((resolve) => { finish = resolve; });
    });
    vi.stubGlobal("fetch", fetchMock);
    const engine = createYoutubeChat({ apiBase: "https://api.test", token: "tok", channel: "channel",
      callbacks: { onMessage: vi.fn(), onStatus } });
    engine.close();
    expect(signal?.aborted).toBe(true);
    finish(jsonResponse({ sessions: [resolved(VIDEO_A), resolved(VIDEO_B)] }));
    await settleRequests();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledTimes(1);
  });

  it("aborts a hung poll and retries its cursor without spawning another resolver", async () => {
    vi.useFakeTimers();
    let polls = 0;
    let resolves = 0;
    let aborted = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/resolve?")) {
        resolves += 1;
        return jsonResponse(resolved(VIDEO_A));
      }
      polls += 1;
      if (polls === 1) return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("timeout")); });
      });
      expect(JSON.parse(String(init?.body)).continuation).toBe(`${VIDEO_A}-start`);
      return jsonResponse(livePoll("recovered"));
    }));
    const engine = createYoutubeChat({ apiBase: "https://api.test", token: "tok", channel: "channel",
      callbacks: { onMessage: vi.fn(), onStatus: vi.fn() } });
    await settleRequests();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(polls).toBe(2);
    expect(resolves).toBe(1);
    engine.close();
  });
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

  it("restores first-poll history as backlog while keeping new messages live", async () => {
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
      "old-history",
      "clock-skew",
      "new-live",
    ]);
    expect(onMessage.mock.calls[0][0].backlog).toBe(true);
    expect(onMessage.mock.calls[1][0].backlog).toBeUndefined();
    expect(onMessage.mock.calls[2][0].backlog).toBeUndefined();
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
