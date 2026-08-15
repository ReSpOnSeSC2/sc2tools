// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");

const {
  YoutubeChatError,
  YoutubePollCoordinator,
  pollLiveChat,
} = require("../src/services/youtubeLiveChat");
const { buildMultichatRouter } = require("../src/routes/multichat");

const CONTINUATION = "continuation-token-long-enough";

function pollPayload(
  next = "next-continuation-token-long-enough",
  timeoutMs = 4000,
) {
  return {
    continuationContents: {
      liveChatContinuation: {
        continuations: [
          {
            timedContinuationData: {
              continuation: next,
              timeoutMs,
            },
          },
        ],
        actions: [],
      },
    },
  };
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
}

describe("bounded YouTube chat polling", () => {
  test("parses a normal streamed response", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(pollPayload()));
    await expect(
      pollLiveChat(
        { continuation: CONTINUATION },
        { fetchImpl, maxResponseBytes: 4096 },
      ),
    ).resolves.toMatchObject({
      continuation: "next-continuation-token-long-enough",
      timeoutMs: 5000,
      done: false,
    });
  });

  test("preserves a moderate cadence and caps an excessive one", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(pollPayload("next-a-long-enough", 7500)))
      .mockResolvedValueOnce(jsonResponse(pollPayload("next-b-long-enough", 12000)));

    await expect(
      pollLiveChat({ continuation: CONTINUATION }, { fetchImpl }),
    ).resolves.toMatchObject({ timeoutMs: 7500 });
    await expect(
      pollLiveChat({ continuation: CONTINUATION }, { fetchImpl }),
    ).resolves.toMatchObject({ timeoutMs: 10000 });
  });

  test("rejects an oversized declared response before parsing", async () => {
    const fetchImpl = async () =>
      jsonResponse(pollPayload(), { headers: { "content-length": "5000" } });
    await expect(
      pollLiveChat(
        { continuation: CONTINUATION },
        { fetchImpl, maxResponseBytes: 128 },
      ),
    ).rejects.toMatchObject({ code: "upstream_too_large" });
  });

  test("rejects a chunked response that crosses the byte limit", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{\"padding\":\""));
        controller.enqueue(new Uint8Array(256));
        controller.enqueue(new TextEncoder().encode("\"}"));
        controller.close();
      },
    });
    const fetchImpl = async () => new Response(body, { status: 200 });
    await expect(
      pollLiveChat(
        { continuation: CONTINUATION },
        { fetchImpl, maxResponseBytes: 64 },
      ),
    ).rejects.toMatchObject({ code: "upstream_too_large" });
  });

  test("coalesces identical in-flight continuations into one fetch and parse", async () => {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const fetchImpl = jest.fn(async () => {
      await held;
      return jsonResponse(pollPayload());
    });
    const coordinator = new YoutubePollCoordinator({ fetchImpl });

    const first = coordinator.poll({ continuation: CONTINUATION });
    const second = coordinator.poll({ continuation: CONTINUATION });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release();

    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(JSON.parse(a)).toMatchObject({
      continuation: "next-continuation-token-long-enough",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await expect(
      coordinator.poll({ continuation: CONTINUATION }),
    ).resolves.toBe(a);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("allows two streams but fails a third distinct continuation fast", async () => {
    const releases = [];
    const coordinator = new YoutubePollCoordinator({
      maxActive: 2,
      fetchImpl: async () => {
        await new Promise((resolve) => releases.push(resolve));
        return jsonResponse(pollPayload());
      },
    });
    const activeA = coordinator.poll({ continuation: `${CONTINUATION}-a` });
    const activeB = coordinator.poll({ continuation: `${CONTINUATION}-b` });

    await expect(
      coordinator.poll({ continuation: `${CONTINUATION}-c` }),
    ).rejects.toMatchObject({ code: "youtube_poll_busy" });
    for (const release of releases) release();
    await Promise.all([activeA, activeB]);
  });

  test("caps identical subscribers without starting duplicate fetches", async () => {
    let release;
    const coordinator = new YoutubePollCoordinator({
      maxSubscribers: 2,
      fetchImpl: async () => {
        await new Promise((resolve) => {
          release = resolve;
        });
        return jsonResponse(pollPayload());
      },
    });
    const first = coordinator.poll({ continuation: CONTINUATION });
    const second = coordinator.poll({ continuation: CONTINUATION });
    await expect(
      coordinator.poll({ continuation: CONTINUATION }),
    ).rejects.toMatchObject({ code: "youtube_poll_busy" });
    release();
    await Promise.all([first, second]);
  });

  test("aborts upstream work after its final subscriber disconnects", async () => {
    const fetchImpl = jest.fn(
      (_url, opts) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted upstream");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
    );
    const coordinator = new YoutubePollCoordinator({ fetchImpl });
    const controller = new AbortController();
    const pending = coordinator.poll(
      { continuation: CONTINUATION },
      { signal: controller.signal },
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
  });

  test("a reconnect waits until an aborted flight settles without exceeding the lane cap", async () => {
    let call = 0;
    let releaseOld;
    const oldSettles = new Promise((resolve) => {
      releaseOld = resolve;
    });
    const fetchImpl = jest.fn(async (_url, opts) => {
      call += 1;
      if (call === 1) {
        await oldSettles;
        const error = new Error("old request aborted");
        error.name = "AbortError";
        throw error;
      }
      expect(opts.signal.aborted).toBe(false);
      return jsonResponse(pollPayload("reconnected-continuation-token"));
    });
    const coordinator = new YoutubePollCoordinator({ fetchImpl, maxActive: 1 });
    const firstController = new AbortController();
    const first = coordinator.poll(
      { continuation: CONTINUATION },
      { signal: firstController.signal },
    );
    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });

    await expect(
      coordinator.poll({ continuation: CONTINUATION }),
    ).rejects.toMatchObject({ code: "youtube_poll_busy" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(coordinator.capacitySnapshot().activeRequests).toBe(1);
    releaseOld();
    await new Promise((resolve) => setImmediate(resolve));

    await expect(
      coordinator.poll({ continuation: CONTINUATION }),
    ).resolves.toEqual(expect.any(String));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("does not coalesce case-sensitive video ids that differ only by case", async () => {
    const seen = [];
    const coordinator = new YoutubePollCoordinator({
      fetchImpl: jest.fn(async (url) => {
        seen.push(String(url));
        return new Response(
          '<html><script>var ytInitialData={"continuation":"safe_token_123"};</script></html>',
          { status: 200 },
        );
      }),
    });

    const first = coordinator.resolve("AbCdEfGhI_1").catch(() => null);
    const second = coordinator.resolve("aBCdEfGhI_1").catch(() => null);
    await Promise.all([first, second]);

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe("YouTube poll route backpressure", () => {
  test("returns retryable 503 for a distinct poll when the global lane is busy", async () => {
    const app = express();
    app.use(express.json());
    app.use(
      "/v1",
      buildMultichatRouter({
        overlayTokens: {
          resolve: async () => ({ userId: "user-1" }),
        },
        users: { getPreferences: async () => ({}) },
        tiktokRelay: {},
        youtubePollCoordinator: {
          poll: async () => {
            throw new YoutubeChatError(
              "youtube_poll_busy",
              "youtube chat polling is busy; retry shortly",
            );
          },
        },
      }),
    );

    const response = await request(app)
      .post("/v1/multichat/safe-test-token/youtube/poll")
      .send({ continuation: CONTINUATION });

    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBe("2");
    expect(response.body).toEqual({
      error: {
        code: "youtube_poll_busy",
        message: "youtube chat polling is busy; retry shortly",
      },
    });
  });

  test("returns retryable 503 when shared upstream work aborts for a live client", async () => {
    const app = express();
    app.use(express.json());
    app.use(
      "/v1",
      buildMultichatRouter({
        overlayTokens: {
          resolve: async () => ({ userId: "user-1" }),
        },
        users: { getPreferences: async () => ({}) },
        tiktokRelay: {},
        youtubePollCoordinator: {
          poll: async () => {
            const error = new Error("upstream aborted");
            error.name = "AbortError";
            throw error;
          },
        },
      }),
    );

    const response = await request(app)
      .post("/v1/multichat/safe-test-token/youtube/poll")
      .send({ continuation: CONTINUATION });

    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBe("2");
    expect(response.body.error.code).toBe("youtube_poll_busy");
  });
});
