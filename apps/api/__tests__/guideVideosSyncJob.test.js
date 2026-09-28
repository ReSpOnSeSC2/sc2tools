// @ts-nocheck
"use strict";

/**
 * jobs/guideVideosSyncJob.js with a fake video service: seeds the
 * snapshot once and syncs on start, re-syncs on its interval, single
 * flight, never throws (warn with a reason code only), env kill switch,
 * interval floor, and never starts without a channel.
 */

const {
  buildGuideVideosSyncJob,
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
} = require("../src/jobs/guideVideosSyncJob");

/** A pino-like logger that records every call. */
function recordingLogger() {
  const calls = [];
  const logger = {
    calls,
    child: () => logger,
    info: (obj, msg) => calls.push({ level: "info", obj, msg }),
    warn: (obj, msg) => calls.push({ level: "warn", obj, msg }),
    error: (obj, msg) => calls.push({ level: "error", obj, msg }),
  };
  return logger;
}

/** @param {object} [o] */
function fakeVideos(o = {}) {
  return {
    isConfigured: jest.fn(() => o.configured !== false),
    ensureSnapshot: jest.fn(o.ensureSnapshot || (async () => ({ inserted: 32 }))),
    syncFromChannel: jest.fn(o.syncFromChannel || (async () => ({ fetched: 15, inserted: 0, updated: 15 }))),
  };
}

/** Let queued promise callbacks run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("guide videos sync job", () => {
  test("requires its dependencies", () => {
    expect(() => buildGuideVideosSyncJob({ logger: recordingLogger() })).toThrow(/guideVideos required/);
    expect(() => buildGuideVideosSyncJob({ guideVideos: fakeVideos() })).toThrow(/logger required/);
  });

  test("runOnce seeds the snapshot once, then only syncs", async () => {
    const videos = fakeVideos();
    const logger = recordingLogger();
    const job = buildGuideVideosSyncJob({ guideVideos: videos, logger, env: {} });
    expect(await job.runOnce()).toEqual({
      snapshot: { inserted: 32 }, sync: { fetched: 15, inserted: 0, updated: 15 }, error: null,
    });
    expect(await job.runOnce()).toEqual({
      snapshot: null, sync: { fetched: 15, inserted: 0, updated: 15 }, error: null,
    });
    expect(videos.ensureSnapshot).toHaveBeenCalledTimes(1);
    expect(videos.syncFromChannel).toHaveBeenCalledTimes(2);
    expect(logger.calls.filter((c) => c.msg === "guide_videos_synced")).toHaveLength(2);
  });

  test("single flight: concurrent runs share one sync", async () => {
    let release;
    const videos = fakeVideos({
      syncFromChannel: () => new Promise((resolve) => { release = () => resolve({ fetched: 1, inserted: 1, updated: 0 }); }),
    });
    const job = buildGuideVideosSyncJob({ guideVideos: videos, logger: recordingLogger(), env: {} });
    const a = job.runOnce();
    const b = job.runOnce();
    await flush();
    release();
    expect(await a).toBe(await b);
    expect(videos.syncFromChannel).toHaveBeenCalledTimes(1);
  });

  test("failures are logged at warn with a reason code only and never thrown", async () => {
    const leaky = Object.assign(new Error("GET https://www.youtube.com/feeds/videos.xml?channel_id=UC… failed"), {
      code: "feed_http_503",
    });
    const videos = fakeVideos({
      ensureSnapshot: async () => { throw Object.assign(new Error("mongo down"), { codeName: "NetworkTimeout" }); },
      syncFromChannel: async () => { throw leaky; },
    });
    const logger = recordingLogger();
    const job = buildGuideVideosSyncJob({ guideVideos: videos, logger, env: {} });
    await expect(job.runOnce()).resolves.toEqual({ snapshot: null, sync: null, error: "NetworkTimeout" });
    expect(logger.calls).toEqual([
      { level: "warn", obj: { code: "NetworkTimeout" }, msg: "guide_videos_snapshot_error" },
      { level: "warn", obj: { code: "feed_http_503" }, msg: "guide_videos_sync_error" },
    ]);
    // The snapshot is retried on the next run until it succeeds once.
    videos.ensureSnapshot.mockResolvedValueOnce({ inserted: 32 });
    await job.runOnce();
    expect(videos.ensureSnapshot).toHaveBeenCalledTimes(2);
    const odd = fakeVideos({ syncFromChannel: async () => { throw "not an error"; } });
    const oddLogger = recordingLogger();
    await buildGuideVideosSyncJob({ guideVideos: odd, logger: oddLogger, env: {} }).runOnce();
    expect(oddLogger.calls.at(-1)).toEqual({ level: "warn", obj: { code: "error" }, msg: "guide_videos_sync_error" });
  });

  describe("scheduling", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test("start runs at once, then every interval (default 6 h); stop halts it", async () => {
      const videos = fakeVideos();
      const logger = recordingLogger();
      const job = buildGuideVideosSyncJob({ guideVideos: videos, logger, env: {} });
      job.start();
      job.start();
      expect(job.isRunning()).toBe(true);
      await jest.advanceTimersByTimeAsync(0);
      expect(videos.syncFromChannel).toHaveBeenCalledTimes(1);
      expect(logger.calls).toContainEqual({ level: "info", obj: { intervalMs: DEFAULT_INTERVAL_MS }, msg: "guide_videos_job_started" });
      await jest.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS);
      expect(videos.syncFromChannel).toHaveBeenCalledTimes(2);
      await job.stop();
      expect(job.isRunning()).toBe(false);
      await jest.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS * 2);
      expect(videos.syncFromChannel).toHaveBeenCalledTimes(2);
    });

    test("the interval env override is floored at 15 minutes", async () => {
      const videos = fakeVideos();
      const logger = recordingLogger();
      const job = buildGuideVideosSyncJob({
        guideVideos: videos, logger, env: { SC2TOOLS_GUIDE_VIDEOS_INTERVAL_SEC: "60" },
      });
      job.start();
      await jest.advanceTimersByTimeAsync(MIN_INTERVAL_MS - 1);
      expect(videos.syncFromChannel).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(videos.syncFromChannel).toHaveBeenCalledTimes(2);
      await job.stop();
    });

    test("the kill switch and a missing channel keep it stopped", async () => {
      const off = fakeVideos();
      const offLogger = recordingLogger();
      const killed = buildGuideVideosSyncJob({
        guideVideos: off, logger: offLogger, env: { SC2TOOLS_GUIDE_VIDEOS_DISABLED: "1" },
      });
      killed.start();
      const bare = fakeVideos({ configured: false });
      const bareLogger = recordingLogger();
      const unconfigured = buildGuideVideosSyncJob({ guideVideos: bare, logger: bareLogger, env: {} });
      unconfigured.start();
      await jest.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS);
      expect(killed.isRunning()).toBe(false);
      expect(unconfigured.isRunning()).toBe(false);
      expect(off.syncFromChannel).not.toHaveBeenCalled();
      expect(bare.syncFromChannel).not.toHaveBeenCalled();
      expect(offLogger.calls).toEqual([{ level: "info", obj: { reason: "disabled" }, msg: "guide_videos_job_not_started" }]);
      expect(bareLogger.calls).toEqual([{ level: "info", obj: { reason: "no_channel" }, msg: "guide_videos_job_not_started" }]);
      await killed.stop();
      await unconfigured.stop();
    });
  });
});
