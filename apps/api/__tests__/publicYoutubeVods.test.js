// @ts-nocheck
"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { PublicYoutubeVodsService } = require("../src/services/publicYoutubeVods");
const { findContainingVod } = require("../src/services/gameVods");
const { listPublicYoutubeBroadcasts } = require("../src/services/platformOauthClients");

const CHANNEL = "UCEI2wK3_OWMUYBvQDgbL4sQ";
const VIDEO = "AP-yICJhjAQ";
const INPUT = "https://www.youtube.com/user/iPStrange";
const NOW = Date.parse("2026-09-07T16:00:00Z");
const VOD = { platform: "youtube", channelId: CHANNEL, videoId: VIDEO,
  startMs: Date.parse("2026-09-07T08:57:57Z"), endMs: Date.parse("2026-09-07T11:48:15Z"), ongoing: false };
const PAGE = `<script>var ytInitialData = {"metadata":{"channelMetadataRenderer":{"externalId":"${CHANNEL}"}},"contents":{"videoId":"${VIDEO}"}};</script>`;

describe("shared verified public YouTube archive index", () => {
  let mongo, db, now, integration, fetchImpl, service;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({uri:mongo.getUri(),dbName:"public_youtube_index_test"});
  });
  afterAll(async () => { await db?.close(); await mongo?.stop(); });
  beforeEach(async () => {
    await db.publicYoutubeArchives.deleteMany({});
    now = NOW;
    integration = {
      getYoutubeConnectionRevision: jest.fn(async (user) => user === "connected" ? "revision" : ""),
      resolvePublicYoutubeBroadcasts: jest.fn(async () => [VOD]),
    };
    fetchImpl = jest.fn(async () => new Response(PAGE, {status:200}));
    service = new PublicYoutubeVodsService({collection:db.publicYoutubeArchives, platformIntegrations:integration, fetchImpl, now:()=>now});
  });
  test("verifies channel ownership once and shares safe metadata with viewers without OAuth", async () => {
    integration.resolvePublicYoutubeBroadcasts.mockResolvedValue([{...VOD, accessToken:"SYNTHETIC_NEVER_PERSIST"}]);
    const first = await service.resolveChannel("connected", INPUT);
    expect(first).toMatchObject({fresh:true,vods:[VOD]});
    expect(integration.resolvePublicYoutubeBroadcasts).toHaveBeenCalledWith("connected",[VIDEO],expect.objectContaining({signal:expect.any(AbortSignal)}));
    const other = new PublicYoutubeVodsService({collection:db.publicYoutubeArchives, platformIntegrations:integration, fetchImpl, now:()=>now});
    expect(await other.resolveChannel("unconnected",INPUT)).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(await db.publicYoutubeArchives.findOne({}))).not.toMatch(/SYNTHETIC|accessToken|userId/);
    expect((await db.publicYoutubeArchives.indexes()).some(index=>index.expireAfterSeconds===0)).toBe(true);
  });
  test("rejects other channels, unrequested videos, future starts and inverted timings", async () => {
    integration.resolvePublicYoutubeBroadcasts.mockResolvedValue([
      {...VOD,channelId:"UCaaaaaaaaaaaaaaaaaaaaaa"},
      {...VOD,videoId:"AAAAAAAAAAA"},
      {...VOD,startMs:NOW+1000,endMs:NOW+2000},
      {...VOD,endMs:VOD.startMs-1},
      VOD,
    ]);
    expect((await service.resolveChannel("connected",INPUT)).vods).toHaveLength(1);
  });
  test("discovers a current /live video alongside archived candidates and verifies its exact public window in one API batch", async () => {
    const liveId = "LiveID12345";
    const startedAt = "2026-09-07T15:00:00Z";
    const livePage = `<script>var ytInitialPlayerResponse = ${JSON.stringify({
      videoDetails: { videoId: liveId, channelId: CHANNEL },
      microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: true } } },
    })};</script>`;
    fetchImpl.mockImplementation(async (url) => new Response(String(url).endsWith("/live") ? livePage : PAGE));
    const metadataFetch = jest.fn(async (url) => {
      expect(new URL(url).searchParams.get("id")).toBe(`${liveId},${VIDEO}`);
      return new Response(JSON.stringify({ items: [
        { id: liveId, snippet: { channelId: CHANNEL, liveBroadcastContent: "live" }, status: { privacyStatus: "public" }, liveStreamingDetails: { actualStartTime: startedAt } },
        { id: VIDEO, snippet: { channelId: CHANNEL, liveBroadcastContent: "none" }, status: { privacyStatus: "public" }, liveStreamingDetails: { actualStartTime: new Date(VOD.startMs).toISOString(), actualEndTime: new Date(VOD.endMs).toISOString() } },
      ] }));
    });
    integration.resolvePublicYoutubeBroadcasts.mockImplementation(async (_userId, videoIds, opts) => listPublicYoutubeBroadcasts("synthetic-fixture-token", metadataFetch, { videoIds, nowMs: now, signal: opts.signal }));
    const result = await service.resolveChannel("connected", INPUT);
    expect(result).toMatchObject({ fresh: true, vods: [
      { videoId: liveId, channelId: CHANNEL, startMs: Date.parse(startedAt), endMs: NOW, ongoing: true },
      VOD,
    ] });
    expect(findContainingVod(result.vods, NOW - 30 * 60_000)).toMatchObject({ videoId: liveId });
    expect(findContainingVod(result.vods, Date.parse(startedAt) - 1)).toBeNull();
    expect(findContainingVod(result.vods, NOW)).toBeNull();
    expect(findContainingVod(result.vods, NOW + 1)).toBeNull();
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([`${INPUT}/streams`, `${INPUT}/live`]);
    expect(fetchImpl.mock.calls.every(([, init]) => init.signal instanceof AbortSignal)).toBe(true);
    expect(metadataFetch).toHaveBeenCalledTimes(1);
    expect(integration.resolvePublicYoutubeBroadcasts).toHaveBeenCalledWith("connected", [liveId, VIDEO], expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  test("does not add a /live candidate belonging to another channel", async () => {
    fetchImpl.mockImplementation(async (url) => new Response(String(url).endsWith("/live")
      ? `<script>var ytInitialPlayerResponse = ${JSON.stringify({ videoDetails: { videoId: "LiveID12345", channelId: "UCaaaaaaaaaaaaaaaaaaaaaa" }, microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: true } } } })};</script>`
      : PAGE));
    expect(await service.resolveChannel("connected", INPUT)).toMatchObject({ fresh: true, vods: [VOD] });
    expect(integration.resolvePublicYoutubeBroadcasts).toHaveBeenCalledWith("connected", [VIDEO], expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
  test("discovers a first broadcast when the verified channel has no archived candidates", async () => {
    const liveId = "LiveID12345";
    const liveVod = { ...VOD, videoId: liveId, startMs: NOW - 60_000, endMs: NOW, ongoing: true };
    fetchImpl.mockImplementation(async (url) => new Response(String(url).endsWith("/live")
      ? `<script>var ytInitialPlayerResponse = ${JSON.stringify({ videoDetails: { videoId: liveId, channelId: CHANNEL }, microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: true } } } })};</script>`
      : JSON.stringify({ metadata: { channelMetadataRenderer: { externalId: CHANNEL } } })));
    integration.resolvePublicYoutubeBroadcasts.mockResolvedValue([liveVod]);
    expect(await service.resolveChannel("connected", INPUT)).toMatchObject({ fresh: true, vods: [liveVod] });
    expect(integration.resolvePublicYoutubeBroadcasts).toHaveBeenCalledWith("connected", [liveId], expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  test("keeps verified results through upstream failure and backs off duplicate attempts", async () => {
    await service.resolveChannel("connected",INPUT);
    now += 6*60_000;
    fetchImpl.mockRejectedValue(new Error("upstream unavailable"));
    expect(await service.resolveChannel("connected",INPUT)).toMatchObject({fresh:false,vods:[VOD]});
    await service.resolveChannel("connected",INPUT);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    now += 25*60*60_000;
    expect(await service.resolveChannel("unconnected",INPUT)).toEqual({fresh:false,vods:[]});
  });
  test("reverification removes recordings no longer returned as public", async () => {
    await service.resolveChannel("connected",INPUT);
    now += 6*60_000;
    integration.resolvePublicYoutubeBroadcasts.mockResolvedValue([]);
    expect(await service.resolveChannel("connected",INPUT)).toEqual({fresh:true,vods:[]});
    expect((await db.publicYoutubeArchives.findOne({})).vods).toEqual([]);
  });
  test("does not start discovery without an available YouTube grant", async () => {
    expect(await service.resolveChannel("unconnected",INPUT)).toEqual({fresh:false,vods:[]});
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(integration.resolvePublicYoutubeBroadcasts).not.toHaveBeenCalled();
  });
  test("deduplicates concurrent scans and does not accept a page with no channel owner", async () => {
    await Promise.all([service.resolveChannel("connected",INPUT),service.resolveChannel("connected",INPUT)]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    now += 6*60_000;
    fetchImpl.mockResolvedValue(new Response(`{"videoId":"${VIDEO}"}`,{status:200}));
    expect(await service.resolveChannel("connected",INPUT)).toMatchObject({fresh:false,vods:[VOD]});
    expect(integration.resolvePublicYoutubeBroadcasts).toHaveBeenCalledTimes(1);
  });
});
