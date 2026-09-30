// @ts-nocheck
"use strict";

/**
 * services/guideVideos.js against mongod: snapshot seeding (insert-only),
 * RSS sync through an injected fetch (real feed fixture), guide selection
 * with per-guide overrides, admin add/hide, fail-soft reads, and the
 * makeServices / loadConfig wiring. No network: every fetch is a stub.
 */

const fs = require("fs");
const path = require("path");
const pino = require("pino");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { GuideVideosService } = require("../src/services/guideVideos");
const { PATCH_5_0_16_RELEASE, PATCH_5_0_17_RELEASE } = require("../src/util/patchEra");
const { FEED_URL, OEMBED_URL, FEED_TIMEOUT_MS } = require("../src/services/guideVideoHttp");
const { loadConfig } = require("../src/config/loader");
const SNAPSHOT = require("../src/config/guideVideosSnapshot.json");

const FEED = fs.readFileSync(path.join(__dirname, "fixtures", "guides", "youtube-channel-feed.xml"), "utf8");
const CHANNEL_ID = "UCZS3YP1mvpqyuU5vPvHVG7g";
const CHANNEL_URL = "https://www.youtube.com/@ReSpOnSeSC2";
const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const MINUTE_MS = 60 * 1000;

/** @param {string} body @param {object} [init] */
function textResponse(body, init = {}) {
  return new Response(body, { status: 200, ...init });
}

/** A pino-like logger that records every call. */
function recordingLogger() {
  const calls = [];
  const logger = {
    calls,
    child: () => logger,
    info: (obj, msg) => calls.push({ level: "info", obj, msg }),
    warn: (obj, msg) => calls.push({ level: "warn", obj, msg }),
    error: (obj, msg) => calls.push({ level: "error", obj, msg }),
    debug: () => {},
  };
  return logger;
}

describe("GuideVideosService", () => {
  let mongo; let db;
  let now = NOW;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "sc2tools_test_guide_videos" });
  });

  beforeEach(async () => {
    now = NOW;
    await db.guideVideos.deleteMany({});
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  /** @param {object} [opts] */
  function service(opts = {}) {
    return new GuideVideosService(db, {
      channelId: CHANNEL_ID,
      channelUrl: CHANNEL_URL,
      logger: opts.logger || pino({ level: "silent" }),
      fetchImpl: opts.fetchImpl || (async () => { throw new Error("network_disabled_in_tests"); }),
      now: () => now,
      ...opts,
    });
  }

  /** @param {string} [body] */
  function feedFetch(body = FEED) {
    const calls = [];
    const fetchImpl = jest.fn(async (url, init) => {
      calls.push({ url, init });
      return textResponse(body);
    });
    return { fetchImpl, calls };
  }

  describe("indexes and snapshot seeding", () => {
    test("guide_videos has a unique youtubeId and a publishedAt index", async () => {
      const indexes = await db.guideVideos.indexes();
      expect(indexes).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: { youtubeId: 1 }, unique: true }),
        expect.objectContaining({ key: { publishedAt: -1 } }),
      ]));
    });

    test("seeds all 32 snapshot videos once, stamped and visible", async () => {
      const svc = service();
      expect(await svc.ensureSnapshot()).toEqual({ inserted: 32 });
      expect(await svc.ensureSnapshot()).toEqual({ inserted: 0 });
      expect(await db.guideVideos.countDocuments({})).toBe(32);
      const row = await db.guideVideos.findOne({ youtubeId: "YcTMc_Ee11w" });
      expect(row).toMatchObject({
        source: "snapshot", hidden: false, isShort: false, channelId: CHANNEL_ID, _schemaVersion: 1,
        title: "PvZ Stargate into Glaive Adept Timing",
      });
      expect(row.publishedAt).toEqual(new Date("2026-08-29T00:00:00.000Z"));
    });

    test("never seeds another channel, nor without a channel", async () => {
      const other = service({ channelId: "UCxxxxxxxxxxxxxxxxxxxxxx" });
      expect(await other.ensureSnapshot()).toEqual({ inserted: 0 });
      expect(await service({ channelId: null }).ensureSnapshot()).toEqual({ inserted: 0 });
      expect(await db.guideVideos.countDocuments({})).toBe(0);
    });

    test("never overwrites a row the RSS sync already refreshed", async () => {
      const { fetchImpl } = feedFetch();
      const svc = service({ fetchImpl });
      await svc.syncFromChannel();
      const before = await db.guideVideos.findOne({ youtubeId: "RYjRs_no8t4" });
      expect(before.source).toBe("rss");
      expect(await svc.ensureSnapshot()).toEqual({ inserted: 26 });
      const after = await db.guideVideos.findOne({ youtubeId: "RYjRs_no8t4" });
      expect(after).toEqual(before);
    });
  });

  describe("syncFromChannel", () => {
    test("fetches the channel feed once, bounded, and upserts every entry", async () => {
      const { fetchImpl, calls } = feedFetch();
      const svc = service({ fetchImpl });
      expect(await svc.syncFromChannel()).toEqual({ fetched: 6, inserted: 6, updated: 0 });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`${FEED_URL}?channel_id=${CHANNEL_ID}`);
      expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
      expect(FEED_TIMEOUT_MS).toBe(10000);
      const short = await db.guideVideos.findOne({ youtubeId: "1WX_FQ0nDqs" });
      expect(short).toMatchObject({ source: "rss", isShort: true, hidden: false, _schemaVersion: 1 });
      expect(short.publishedAt).toEqual(new Date("2026-09-25T12:00:12.000Z"));
      // Same feed again: nothing new, nothing changed except updatedAt.
      now += MINUTE_MS;
      expect(await svc.syncFromChannel()).toEqual({ fetched: 6, inserted: 0, updated: 6 });
    });

    test("keeps admin hides and older videos (never deletes)", async () => {
      const svc = service({ fetchImpl: feedFetch().fetchImpl });
      await svc.ensureSnapshot();
      await svc.setHidden("RYjRs_no8t4", true);
      await svc.syncFromChannel();
      expect(await db.guideVideos.countDocuments({})).toBe(32);
      expect((await db.guideVideos.findOne({ youtubeId: "RYjRs_no8t4" })).hidden).toBe(true);
    });

    test("ignores entries from another channel", async () => {
      const foreign = FEED.replace(/<yt:channelId>UCZS3YP1mvpqyuU5vPvHVG7g<\/yt:channelId>/g, "<yt:channelId>UCaaaaaaaaaaaaaaaaaaaaaa</yt:channelId>");
      await expect(service({ fetchImpl: feedFetch(foreign).fetchImpl }).syncFromChannel())
        .rejects.toMatchObject({ code: "feed_empty", status: 502 });
      expect(await db.guideVideos.countDocuments({})).toBe(0);
    });

    test.each([
      ["http error", async () => textResponse("nope", { status: 500 }), "feed_http_500"],
      ["timeout", async () => { throw new DOMException("timed out", "TimeoutError"); }, "feed_timeout"],
      ["network error", async () => { throw new TypeError("fetch failed"); }, "feed_unreachable"],
      ["oversize body", async () => textResponse("x", { headers: { "content-length": String(2 * 1024 * 1024) } }), "feed_too_large"],
      ["oversize streamed body (no content-length)", async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(600 * 1024));
          controller.enqueue(new Uint8Array(600 * 1024));
          controller.close();
        },
      })), "feed_too_large"],
      ["timeout while reading the body", async () => new Response(new ReadableStream({
        pull(controller) { controller.error(new DOMException("timed out", "TimeoutError")); },
      })), "feed_timeout"],
      ["unparsable body", async () => textResponse("<html>consent</html>"), "feed_empty"],
    ])("%s → coded error, nothing written", async (_label, fetchImpl, code) => {
      await expect(service({ fetchImpl }).syncFromChannel()).rejects.toMatchObject({ code });
      expect(await db.guideVideos.countDocuments({})).toBe(0);
    });

    test("an unconfigured channel refuses to sync", async () => {
      await expect(service({ channelId: "not-a-channel" }).syncFromChannel())
        .rejects.toMatchObject({ code: "channel_not_configured", status: 503 });
    });
  });

  describe("8-worker patch videos", () => {
    let svc;
    beforeEach(async () => {
      svc = service({ fetchImpl: feedFetch().fetchImpl });
      await svc.ensureSnapshot();
      await svc.syncFromChannel();
    });

    /** @param {string} youtubeId @param {Date|null} publishedAt */
    async function insertGlaivesVideo(youtubeId, publishedAt) {
      await db.guideVideos.insertOne({
        youtubeId, title: "PvZ Stargate into Glaives, 12 workers", description: "", publishedAt,
        channelId: CHANNEL_ID, source: "admin", isShort: false, hidden: false, updatedAt: new Date(NOW),
      });
      svc.invalidate();
    }

    test("guides and matchup rows leave them off unless an admin pins them", async () => {
      expect(await svc.videosForBuild("PvZ", "PvZ - Stargate into Glaives")).toEqual([]);
      expect((await svc.videosForBuild("PvZ", "PvZ - Stargate into Glaives", { pinned: ["YcTMc_Ee11w"] }))
        .map((v) => v.youtubeId)).toEqual(["YcTMc_Ee11w"]);
      // Curated links are automatic matches too.
      expect(await svc.videosForBuild("PvZ", "PvZ - Rail's Disruptor Drop")).toEqual([]);
      expect(await svc.videosForCounter("PvT", "Terran - 3 Rax")).toEqual([]);
      expect(await svc.videosForMatchup("PvZ")).toEqual([]);
      // The matchup page's 8-worker view keeps them.
      expect((await svc.videosForMatchup("PvZ", 4, "before")).map((v) => v.youtubeId))
        .toEqual(["AnmLN-xFtAc", "guRK0SIbM8Y", "RYjRs_no8t4", "aSGYCTVBjqY"]);
      // The channel-wide row is not about one build order.
      expect((await svc.latest()).map((v) => v.youtubeId))
        .toEqual(["_U1MPQB_Q90", "AnmLN-xFtAc", "guRK0SIbM8Y", "RYjRs_no8t4"]);
    });

    test("the window runs from the 5.0.16 release until the 5.0.17 revert; undated videos show", async () => {
      await insertGlaivesVideo("AAAAAAAAAAA", new Date(PATCH_5_0_17_RELEASE.getTime()));
      await insertGlaivesVideo("BBBBBBBBBBB", new Date(PATCH_5_0_17_RELEASE.getTime() - 1));
      await insertGlaivesVideo("CCCCCCCCCCC", new Date(PATCH_5_0_16_RELEASE.getTime()));
      await insertGlaivesVideo("DDDDDDDDDDD", new Date(PATCH_5_0_16_RELEASE.getTime() - 1));
      await insertGlaivesVideo("EEEEEEEEEEE", null);
      expect((await svc.videosForBuild("PvZ", "PvZ - Stargate into Glaives")).map((v) => v.youtubeId))
        .toEqual(["AAAAAAAAAAA", "DDDDDDDDDDD", "EEEEEEEEEEE"]);
      expect((await svc.videosForMatchup("PvZ", 12)).map((v) => v.youtubeId))
        .toEqual(["AAAAAAAAAAA", "DDDDDDDDDDD", "EEEEEEEEEEE"]);
    });

    test("a globally hidden 8-worker video stays hidden even when pinned", async () => {
      await svc.setHidden("YcTMc_Ee11w", true);
      expect(await svc.videosForBuild("PvZ", "PvZ - Stargate into Glaives", { pinned: ["YcTMc_Ee11w"] })).toEqual([]);
    });

    test("the admin list flags every 8-worker patch video", async () => {
      await insertGlaivesVideo("AAAAAAAAAAA", new Date(PATCH_5_0_17_RELEASE.getTime()));
      const items = await svc.listForAdmin();
      expect(items.filter((v) => v.eightWorkerPatch)).toHaveLength(32);
      expect(items.find((v) => v.youtubeId === "AAAAAAAAAAA")).toMatchObject({ eightWorkerPatch: false });
      expect(items.find((v) => v.youtubeId === "YcTMc_Ee11w")).toMatchObject({
        builds: ["PvZ - Stargate into Glaives"], eightWorkerPatch: true,
      });
    });
  });

  describe("guide selection", () => {
    let svc;
    beforeEach(async () => {
      // Ordering, caps and overrides, independent of publish dates: every
      // channel video so far is from the 8-worker patch (next block).
      svc = service({ fetchImpl: feedFetch().fetchImpl, eightWorkerWindow: null });
      await svc.ensureSnapshot();
      await svc.syncFromChannel();
    });

    test("a build guide gets the video whose title names it, in the public shape", async () => {
      const videos = await svc.videosForBuild("PvZ", "PvZ - Stargate into Glaives");
      expect(videos).toHaveLength(1);
      expect(videos[0]).toEqual({
        youtubeId: "YcTMc_Ee11w",
        title: "PvZ Stargate into Glaive Adept Timing",
        publishedAt: "2026-08-29T00:00:00.000Z",
        url: "https://www.youtube.com/watch?v=YcTMc_Ee11w",
        thumbnailUrl: "https://i.ytimg.com/vi/YcTMc_Ee11w/hqdefault.jpg",
        embedUrl: "https://www.youtube-nocookie.com/embed/YcTMc_Ee11w",
        excerpt: "This PvZ build hides an 18-Glaive-Adept timing behind what looks like a normal Stargate opener—and punishes Zerg players who drone too hard.",
        checklist: expect.arrayContaining(["Stargate at 150 gas", "Move before Glaives completes"]),
      });
      expect(videos[0].checklist).toHaveLength(10);
    });

    test("curated links attach videos whose titles don't name the build", async () => {
      expect((await svc.videosForBuild("PvZ", "PvZ - Rail's Disruptor Drop")).map((v) => v.youtubeId))
        .toEqual(["dA9V95oeeto"]);
      expect((await svc.videosForBuild("PvP", "PvP - AlphaStar (4 Adept/Oracle)")).map((v) => v.youtubeId))
        .toEqual(["Jkyjd8R7Qfs"]);
    });

    test("counter guides, unknown names and wrong matchups", async () => {
      // "PvZ Cracking 8 Pools" names the 8-worker patch's 8 Pool, not the catalog's 12 Pool.
      expect(await svc.videosForCounter("PvZ", "Zerg - 12 Pool")).toEqual([]);
      expect(await svc.videosForCounter("PvZ", "Zerg - 8 Pool")).toEqual([]);
      expect((await svc.videosForCounter("PvT", "Terran - 3 Rax")).map((v) => v.youtubeId)).toEqual(["_EZbooc6wLM"]);
      expect(await svc.videosForBuild("PvZ", "PvZ - Not A Build")).toEqual([]);
      expect(await svc.videosForBuild("PvT", "PvZ - Carrier Rush")).toEqual([]);
      expect(await svc.videosForCounter("PvZ", "PvZ - Carrier Rush")).toEqual([]);
      expect(await svc.videosForBuild("PvZ", "PvZ - Tempest Rush")).toEqual([]);
    });

    test("pinned first, hidden removed, then matches newest first, at most 3", async () => {
      const ids = async (overrides) =>
        (await svc.videosForBuild("PvZ", "PvZ - Carrier Rush", overrides)).map((v) => v.youtubeId);
      expect(await ids()).toEqual(["RYjRs_no8t4"]);
      expect(await ids({ pinned: ["aSGYCTVBjqY"] })).toEqual(["aSGYCTVBjqY", "RYjRs_no8t4"]);
      expect(await ids({ pinned: ["aSGYCTVBjqY", "AnmLN-xFtAc", "-E8lseUGWqQ", "guRK0SIbM8Y"] }))
        .toEqual(["aSGYCTVBjqY", "AnmLN-xFtAc", "-E8lseUGWqQ"]);
      expect(await ids({ hidden: ["RYjRs_no8t4"] })).toEqual([]);
      expect(await ids({ pinned: ["aSGYCTVBjqY"], hidden: ["aSGYCTVBjqY"] })).toEqual(["RYjRs_no8t4"]);
      expect(await ids({ pinned: ["not a video id", "ZZZZZZZZZZZ", "aSGYCTVBjqY", "aSGYCTVBjqY"] }))
        .toEqual(["aSGYCTVBjqY", "RYjRs_no8t4"]);
      expect(await ids({ pinned: "aSGYCTVBjqY", hidden: null })).toEqual(["RYjRs_no8t4"]);
    });

    test("a globally hidden video never shows, even pinned", async () => {
      await svc.setHidden("aSGYCTVBjqY", true);
      const videos = await svc.videosForBuild("PvZ", "PvZ - Carrier Rush", { pinned: ["aSGYCTVBjqY"] });
      expect(videos.map((v) => v.youtubeId)).toEqual(["RYjRs_no8t4"]);
    });

    test("matchup rows: build-order videos only (no Shorts, no streams), newest first", async () => {
      expect((await svc.videosForMatchup("PvZ")).map((v) => v.youtubeId))
        .toEqual(["AnmLN-xFtAc", "guRK0SIbM8Y", "RYjRs_no8t4", "aSGYCTVBjqY"]);
      expect((await svc.videosForMatchup("PvZ", 2)).map((v) => v.youtubeId)).toEqual(["AnmLN-xFtAc", "guRK0SIbM8Y"]);
      expect((await svc.videosForMatchup("PvP", 99)).map((v) => v.youtubeId)).toEqual(["VcPGKEoPBYk", "Jkyjd8R7Qfs"]);
      expect(await svc.videosForMatchup("ZvZ")).toEqual([]);
      expect(await svc.videosForMatchup("pvz")).toEqual([]);
    });

    test("latest: newest build-order videos across matchups", async () => {
      expect((await svc.latest()).map((v) => v.youtubeId))
        .toEqual(["_U1MPQB_Q90", "AnmLN-xFtAc", "guRK0SIbM8Y", "RYjRs_no8t4"]);
      await svc.setHidden("_U1MPQB_Q90", true);
      expect((await svc.latest(1)).map((v) => v.youtubeId)).toEqual(["AnmLN-xFtAc"]);
      expect((await svc.latest(0))).toHaveLength(1);
      expect((await svc.latest(Number.NaN))).toHaveLength(4);
    });

    test("returned videos are copies (callers cannot poison the cache)", async () => {
      const [first] = await svc.videosForBuild("PvZ", "PvZ - Stargate into Glaives");
      first.title = "mutated";
      first.checklist.push("mutated");
      const [again] = await svc.videosForBuild("PvZ", "PvZ - Stargate into Glaives");
      expect(again.title).toBe("PvZ Stargate into Glaive Adept Timing");
      expect(again.checklist).toHaveLength(10);
    });

    test("reads are cached for 5 minutes; writes through the service invalidate", async () => {
      expect((await svc.videosForBuild("PvZ", "PvZ - Carrier Rush")).map((v) => v.youtubeId)).toEqual(["RYjRs_no8t4"]);
      await db.guideVideos.updateOne({ youtubeId: "RYjRs_no8t4" }, { $set: { hidden: true } });
      now += 5 * MINUTE_MS - 1;
      expect((await svc.videosForBuild("PvZ", "PvZ - Carrier Rush")).map((v) => v.youtubeId)).toEqual(["RYjRs_no8t4"]);
      now += 1;
      now += 5 * MINUTE_MS;
      expect(await svc.videosForBuild("PvZ", "PvZ - Carrier Rush")).toEqual([]);
      await svc.setHidden("RYjRs_no8t4", false);
      expect((await svc.videosForBuild("PvZ", "PvZ - Carrier Rush")).map((v) => v.youtubeId)).toEqual(["RYjRs_no8t4"]);
    });

    test("listForAdmin shows every video with its match and flags", async () => {
      await svc.setHidden("RYjRs_no8t4", true);
      const items = await svc.listForAdmin();
      expect(items).toHaveLength(32);
      expect(items.find((v) => v.youtubeId === "RYjRs_no8t4")).toMatchObject({
        matchup: "PvZ", builds: ["PvZ - Carrier Rush"], counters: [], source: "rss", hidden: true, isShort: false,
      });
      expect(items.find((v) => v.youtubeId === "1WX_FQ0nDqs")).toMatchObject({ matchup: null, isShort: true });
      expect(items.find((v) => v.youtubeId === "dA9V95oeeto")).toMatchObject({
        builds: ["PvZ - Rail's Disruptor Drop"], source: "snapshot",
      });
    });
  });

  describe("fail-soft reads", () => {
    test("a Mongo error yields [] and a code-only warn", async () => {
      const logger = recordingLogger();
      const broken = {
        guideVideos: {
          find: () => { throw Object.assign(new Error("boom mongodb://user:pass@host"), { codeName: "NetworkTimeout" }); },
        },
      };
      const svc = new GuideVideosService(broken, { channelId: CHANNEL_ID, logger });
      expect(await svc.latest()).toEqual([]);
      expect(await svc.videosForBuild("PvZ", "PvZ - Carrier Rush")).toEqual([]);
      expect(logger.calls).toEqual([
        { level: "warn", obj: { code: "NetworkTimeout" }, msg: "guide_videos_read_failed" },
        { level: "warn", obj: { code: "NetworkTimeout" }, msg: "guide_videos_read_failed" },
      ]);
    });

    test("a db without the collection serves nothing", async () => {
      const svc = new GuideVideosService({}, {});
      expect(await svc.latest()).toEqual([]);
      expect(await svc.ensureSnapshot()).toEqual({ inserted: 0 });
      expect(svc.isConfigured()).toBe(false);
      expect(svc.channel()).toBeNull();
    });
  });

  describe("admin add and hide", () => {
    /** @param {object} body @param {number} [status] */
    function oembedFetch(body, status = 200) {
      const calls = [];
      const fetchImpl = jest.fn(async (url) => {
        calls.push(url);
        return textResponse(typeof body === "string" ? body : JSON.stringify(body), { status });
      });
      return { fetchImpl, calls };
    }

    test("adds a channel video by id via oEmbed, undated until the feed dates it", async () => {
      const { fetchImpl, calls } = oembedFetch({
        title: "PvZ Cracking 12 Pools", author_name: "ReSpOnSeSC2", author_url: "https://www.youtube.com/@ReSpOnSeSC2",
      });
      const item = await service({ fetchImpl }).addVideo("A4x6gR7J-AY");
      expect(calls).toEqual([
        `${OEMBED_URL}?url=${encodeURIComponent("https://www.youtube.com/watch?v=A4x6gR7J-AY")}&format=json`,
      ]);
      expect(item).toMatchObject({
        youtubeId: "A4x6gR7J-AY", title: "PvZ Cracking 12 Pools", publishedAt: null, excerpt: "", checklist: null,
        matchup: "PvZ", counters: ["Zerg - 12 Pool"], source: "admin", hidden: false,
      });
      const svc = service();
      expect((await svc.videosForCounter("PvZ", "Zerg - 12 Pool")).map((v) => v.youtubeId)).toEqual(["A4x6gR7J-AY"]);
    });

    test("re-adding a hidden video un-hides it and keeps richer stored fields", async () => {
      const seeded = service();
      await seeded.ensureSnapshot();
      await seeded.setHidden("A4x6gR7J-AY", true);
      const { fetchImpl } = oembedFetch({ title: "Different title", author_url: "https://youtube.com/@responsesc2/" });
      const item = await service({ fetchImpl }).addVideo("A4x6gR7J-AY");
      expect(item).toMatchObject({ hidden: false, source: "snapshot", title: "PvZ Cracking 8 Pools" });
      expect(item.checklist).toHaveLength(10);
    });

    test.each([
      ["another channel's video", { title: "x", author_url: "https://www.youtube.com/@SomeoneElse" }, 200, "video_not_on_channel"],
      ["an unknown video", "Not Found", 404, "video_lookup_http_404"],
      ["a body without a title", { author_url: CHANNEL_URL }, 200, "video_lookup_failed"],
      ["a non-JSON body", "<html>", 200, "video_lookup_failed"],
    ])("rejects %s with 422", async (_label, body, status, code) => {
      const { fetchImpl } = oembedFetch(body, status);
      await expect(service({ fetchImpl }).addVideo("A4x6gR7J-AY")).rejects.toMatchObject({ code, status: 422 });
      expect(await db.guideVideos.countDocuments({})).toBe(0);
    });

    test("accepts the /channel/<id> author form", async () => {
      const { fetchImpl } = oembedFetch({ title: "t PvP", author_url: `https://www.youtube.com/channel/${CHANNEL_ID}` });
      await expect(service({ fetchImpl, channelUrl: null }).addVideo("VcPGKEoPBYk")).resolves.toMatchObject({ source: "admin" });
    });

    test("invalid ids are 400s; unknown ids hide nothing", async () => {
      const svc = service();
      await expect(svc.addVideo("bad id")).rejects.toMatchObject({ code: "invalid_video_id", status: 400 });
      await expect(svc.setHidden("../../etc", true)).rejects.toMatchObject({ code: "invalid_video_id", status: 400 });
      expect(await svc.setHidden("ZZZZZZZZZZZ", true)).toBeNull();
      await expect(service({ channelId: null }).addVideo("A4x6gR7J-AY"))
        .rejects.toMatchObject({ code: "channel_not_configured", status: 503 });
    });
  });

  describe("makeServices wiring", () => {
    const baseConfig = {
      port: 0, nodeEnv: "test", logLevel: "silent", mongoUri: "", mongoDb: "sc2tools_test_guide_videos",
      clerkSecretKey: "sk_test", serverPepper: Buffer.alloc(32, 7), corsAllowedOrigins: [],
      rateLimitPerMinute: 5000, agentReleaseAdminToken: "admin", pythonExe: null,
      pythonAnalyzerDir: "/tmp/__nonexistent__", adminUserIds: [],
    };
    const noNetwork = async () => { throw new Error("network_disabled_in_tests"); };

    test("builds the service from config and the sync job without starting it", () => {
      const { buildApp } = require("../src/app");
      const { PulseMmrService } = require("../src/services/pulseMmr");
      const { services } = buildApp({
        db, logger: pino({ level: "silent" }),
        config: { ...baseConfig, guidesYoutubeChannelId: CHANNEL_ID, guidesYoutubeChannelUrl: CHANNEL_URL },
        pulseMmr: new PulseMmrService({ fetchImpl: noNetwork }),
      });
      expect(services.guideVideos).toBeInstanceOf(GuideVideosService);
      expect(services.guideVideos.isConfigured()).toBe(true);
      expect(services.guideVideos.channel()).toEqual({ url: CHANNEL_URL, name: "ReSpOnSeSC2" });
      expect(services.guideVideosJob.isRunning()).toBe(false);
    });

    test("a hand-built config without the channel fields leaves videos unconfigured", () => {
      const { buildApp } = require("../src/app");
      const { PulseMmrService } = require("../src/services/pulseMmr");
      const { services } = buildApp({
        db, logger: pino({ level: "silent" }), config: baseConfig,
        pulseMmr: new PulseMmrService({ fetchImpl: noNetwork }),
      });
      expect(services.guideVideos.isConfigured()).toBe(false);
      expect(services.guideVideos.channel()).toBeNull();
    });
  });

  describe("channel link", () => {
    test("canonical https YouTube URL with its handle as the name", () => {
      expect(service().channel()).toEqual({ url: CHANNEL_URL, name: "ReSpOnSeSC2" });
      expect(service({ channelUrl: "https://youtube.com/@ReSpOnSeSC2/" }).channel())
        .toEqual({ url: CHANNEL_URL, name: "ReSpOnSeSC2" });
      expect(service({ channelUrl: `https://www.youtube.com/channel/${CHANNEL_ID}` }).channel())
        .toEqual({ url: `https://www.youtube.com/channel/${CHANNEL_ID}`, name: SNAPSHOT.channelName });
    });

    test("names come from real data only and a bad URL never throws", () => {
      expect(service({ channelUrl: `${CHANNEL_URL}/videos` }).channel())
        .toEqual({ url: `${CHANNEL_URL}/videos`, name: "ReSpOnSeSC2" });
      // Malformed percent-encoding: kept raw instead of a URIError on the hub.
      expect(service({ channelUrl: "https://www.youtube.com/@Bad%E0%A4%A" }).channel())
        .toEqual({ url: "https://www.youtube.com/@Bad%E0%A4%A", name: "Bad%E0%A4%A" });
      // Another channel's /channel/<id> URL: the snapshot's name would be a
      // misattribution, so there is no link rather than a wrong name.
      const other = "UCaaaaaaaaaaaaaaaaaaaaaa";
      expect(service({ channelId: other, channelUrl: `https://www.youtube.com/channel/${other}` }).channel())
        .toBeNull();
    });

    test("anything else is no link", () => {
      expect(service({ channelUrl: "http://www.youtube.com/@ReSpOnSeSC2" }).channel()).toBeNull();
      expect(service({ channelUrl: "https://evil.example/@ReSpOnSeSC2" }).channel()).toBeNull();
      expect(service({ channelUrl: "https://www.youtube.com/" }).channel()).toBeNull();
      expect(service({ channelUrl: "not a url" }).channel()).toBeNull();
      expect(service({ channelUrl: null }).channel()).toBeNull();
    });
  });
});

describe("guide videos config", () => {
  const BASE_ENV = {
    MONGODB_URI: "mongodb://localhost:27017",
    CLERK_SECRET_KEY: "sk_test",
    SERVER_PEPPER_HEX: "a".repeat(64),
  };

  test("reads the channel id and URL, null when unset", () => {
    const on = loadConfig({
      ...BASE_ENV,
      GUIDES_YOUTUBE_CHANNEL_ID: CHANNEL_ID,
      GUIDES_YOUTUBE_CHANNEL_URL: CHANNEL_URL,
    });
    expect(on.guidesYoutubeChannelId).toBe(CHANNEL_ID);
    expect(on.guidesYoutubeChannelUrl).toBe(CHANNEL_URL);
    const off = loadConfig(BASE_ENV);
    expect(off.guidesYoutubeChannelId).toBeNull();
    expect(off.guidesYoutubeChannelUrl).toBeNull();
  });
});
