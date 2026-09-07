// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { GamesService } = require("../src/services/games");
const { PlayerIdentitiesService } = require("../src/services/playerIdentities");
const { PlayerChannelsService } = require("../src/services/playerChannels");
const { PulseCharacterLinkService } = require("../src/services/pulseCharacterLinks");
const { GameVodsService, gameStartMs } = require("../src/services/gameVods");
const { PublicYoutubeVodsService } = require("../src/services/publicYoutubeVods");
const { listPublicYoutubeBroadcasts } = require("../src/services/platformOauthClients");

const SOURCE = "2-S2-2-240434";
const TARGET = "2-S2-2-632713";
const SOURCE_CID = "8703807";
const TARGET_CID = "236671";
const CHANNEL_ID = "UCEI2wK3_OWMUYBvQDgbL4sQ";
const VIDEO_ID = "AP-yICJhjAQ";
const BROADCAST_START = "2026-09-07T08:57:57Z";
const BROADCAST_END = "2026-09-07T11:48:15Z";
const REPLAYS = [
  { gameId: "2026-09-07T11:46:05|IIIIIIIIII|Rorschach LE|616", date: "2026-09-07T11:46:05Z", durationSec: 616, expectedOffset: 9472 },
  { gameId: "2026-09-07T11:33:37|IIIIIIIIII|At Eternity's Edge LE|528", date: "2026-09-07T11:33:37Z", durationSec: 528, expectedOffset: 8812 },
  { gameId: "2026-09-07T11:19:10|IIIIIIIIII|Rainfall LE|316", date: "2026-09-07T11:19:10Z", durationSec: 316, expectedOffset: 8157 },
];

// Public metadata captured from Strange's real broadcast on 2026-09-07.
// The compact fixture keeps CI independent of a mutable external website.
const STREAMS_HTML = JSON.stringify({ externalId: CHANNEL_ID, videoId: VIDEO_ID });
const WATCH_HTML = `<script>var ytInitialPlayerResponse = ${JSON.stringify({
  videoDetails: { videoId: VIDEO_ID, channelId: CHANNEL_ID, lengthSeconds: "10197" },
  microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: false, startTimestamp: BROADCAST_START, endTimestamp: BROADCAST_END } } },
})};</script>`;

describe("confirmed barcode identity to real Strange broadcast", () => {
  let mongo;
  let db;
  let playerChannels;
  let identities;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "strange_confirmed_vod" });
    await db.playerIdentities.insertOne({
      kind: "link", active: true, sourceKeys: [`toon:${SOURCE}`, `pulse:${SOURCE_CID}`],
      targetKeys: [`toon:${TARGET}`, `pulse:${TARGET_CID}`], groupKey: `identity:toon:${TARGET}`, revision: 1,
      target: { key: `toon:${TARGET}`, toonHandle: TARGET, pulseCharacterId: TARGET_CID, displayName: "Strange", region: "EU" },
    });
    await db.pulseCharacterLinks.insertOne({ pulseCharacterId: TARGET_CID, toonHandle: TARGET, proId: "47", accountId: "fixture-account-47", fetchedAt: new Date() });
    await db.games.insertMany(REPLAYS.map((row) => ({
      userId: "replay-owner", gameId: row.gameId, date: new Date(row.date), durationSec: row.durationSec,
      myToonHandle: "1-S2-1-267727", opponent: { pulseId: SOURCE, toonHandle: SOURCE, pulseCharacterId: SOURCE_CID, displayName: "IIIIIIIIII" },
    })));
    identities = new PlayerIdentitiesService(db);
    const pulseLinks = new PulseCharacterLinkService(db.pulseCharacterLinks, { fetchImpl: async () => ({ ok: true, text: async () => "[]" }) });
    playerChannels = new PlayerChannelsService(db, { pulseLinks });
    playerChannels.playerIdentities = identities;
    await playerChannels.ensureSeeds();
  });
  afterAll(async () => { await db?.close(); await mongo?.stop(); });

  function archivesWithHtml(streamsHtml = STREAMS_HTML, watchHtml = WATCH_HTML) {
    const fetchImpl = jest.fn(async (url) => {
      const value = String(url);
      if (value.includes("gql.twitch.tv")) return { ok: true, json: async () => ({ data: { user: { videos: { edges: [] } } } }) };
      const html = value === "https://www.youtube.com/user/iPStrange/streams" ? streamsHtml
        : value === `https://www.youtube.com/watch?v=${VIDEO_ID}` ? watchHtml : "";
      return { ok: true, text: async () => html };
    });
    return new GameVodsService({ users: { getPreferences: async () => ({}) }, playerChannels, fetchImpl, now: () => Date.parse("2026-09-07T12:30:00Z") });
  }

  async function assertReplayLinks(vods, viewerId = "replay-owner") {
    const games = await new GamesService(db).findMany("replay-owner", REPLAYS.map((row) => row.gameId));
    expect(games).toHaveLength(3);
    expect(games[0].opponent).toMatchObject({ pulseCharacterId: SOURCE_CID, toonHandle: SOURCE });
    const result = await vods.resolveForGames(viewerId, games, { includeOpponent: true });
    for (const replay of REPLAYS) {
      const links = result.linksByGameId[replay.gameId];
      expect(links).toContainEqual(expect.objectContaining({
        perspective: "opponent", playerName: "Strange", platform: "youtube", videoId: VIDEO_ID,
        offsetSec: replay.expectedOffset, url: `https://www.youtube.com/watch?v=${VIDEO_ID}&t=${replay.expectedOffset}s`,
      }));
      const game = games.find((item) => item.gameId === replay.gameId);
      expect(gameStartMs(game) - Date.parse(BROADCAST_START)).toBe(replay.expectedOffset * 1000);
    }
  }

  test("real services retain the source tuple while routing to Strange's seeded channel and exact replay starts", async () => {
    expect((await identities.resolveMany([{ pulseCharacterId: SOURCE_CID, toonHandle: SOURCE }]))[0]).toMatchObject({ target: { pulseCharacterId: TARGET_CID, toonHandle: TARGET } });
    const resolved = await playerChannels.resolve([{ pulseCharacterId: SOURCE_CID, toonHandle: SOURCE }]);
    expect(resolved.players[0]).toMatchObject({ pulseCharacterId: SOURCE_CID, toonHandle: SOURCE, displayName: "Strange", channels: { youtube: "https://www.youtube.com/user/iPStrange" } });
    await assertReplayLinks(archivesWithHtml());
  });

  test("official public metadata recovers all three replays despite watch 429s and survives a new unconnected viewer", async () => {
    const now = () => Date.parse("2026-09-07T12:30:00Z");
    const fetchImpl = jest.fn(async (url) => {
      const value = String(url);
      if (value.includes("gql.twitch.tv")) return new Response(JSON.stringify({ data: { user: { videos: { edges: [] } } } }));
      if (value === "https://www.youtube.com/user/iPStrange/streams") return new Response(STREAMS_HTML);
      if (value.startsWith("https://www.youtube.com/watch?")) return new Response("Too Many Requests", { status: 429 });
      return new Response("", { status: 404 });
    });
    const metadataFetch = jest.fn(async (url) => {
      const request = new URL(url);
      expect(request.origin + request.pathname).toBe("https://www.googleapis.com/youtube/v3/videos");
      expect(request.searchParams.get("id")).toBe(VIDEO_ID);
      return new Response(JSON.stringify({ items: [{
        id: VIDEO_ID,
        snippet: { channelId: CHANNEL_ID, liveBroadcastContent: "none" },
        status: { privacyStatus: "public" },
        liveStreamingDetails: { actualStartTime: BROADCAST_START, actualEndTime: BROADCAST_END },
      }] }));
    });
    // The grant lifecycle is stubbed; provider filtering and shared storage
    // are real. This fixture token is synthetic and is never persisted.
    const integrations = {
      getYoutubeConnectionRevision: jest.fn(async (userId) => userId === "replay-owner" ? "fixture-revision" : ""),
      resolvePublicYoutubeBroadcasts: jest.fn(async (userId, videoIds, opts) => {
        expect(userId).toBe("replay-owner");
        return listPublicYoutubeBroadcasts("synthetic-fixture-token", metadataFetch, { videoIds, nowMs: now(), signal: opts.signal });
      }),
    };
    const service = new GameVodsService({ users: { getPreferences: async () => ({}) }, playerChannels, fetchImpl, now });
    const games = await new GamesService(db).findMany("replay-owner", REPLAYS.map((row) => row.gameId));
    const blocked = await service.resolveForGames("replay-owner", games, { includeOpponent: true });
    expect(Object.values(blocked.linksByGameId).every((links) => links.length === 0)).toBe(true);
    expect(service._youtubeBackoffUntil).toBeGreaterThan(now());
    const watchCalls = () => fetchImpl.mock.calls.filter(([url]) => String(url).startsWith("https://www.youtube.com/watch?")).length;
    expect(watchCalls()).toBe(1);

    service.publicYoutube = new PublicYoutubeVodsService({ collection: db.publicYoutubeArchives, platformIntegrations: integrations, fetchImpl, now });
    await assertReplayLinks(service);
    expect(metadataFetch).toHaveBeenCalledTimes(1);
    expect(watchCalls()).toBe(1);
    const snapshot = await db.publicYoutubeArchives.findOne({});
    expect(snapshot.vods).toEqual([expect.objectContaining({ videoId: VIDEO_ID, channelId: CHANNEL_ID, startMs: Date.parse(BROADCAST_START), endMs: Date.parse(BROADCAST_END) })]);
    expect(JSON.stringify(snapshot)).not.toMatch(/synthetic-fixture-token|fixture-revision|replay-owner|accessToken|refreshToken/);

    const strangePageCalls = () => fetchImpl.mock.calls.filter(([url]) => String(url).includes("youtube.com/user/iPStrange")).length;
    const pageCalls = strangePageCalls();
    const freshIndex = new PublicYoutubeVodsService({ collection: db.publicYoutubeArchives, platformIntegrations: integrations, fetchImpl, now });
    const freshService = new GameVodsService({ users: { getPreferences: async () => ({}) }, playerChannels, publicYoutube: freshIndex, fetchImpl, now });
    await assertReplayLinks(freshService, "viewer-without-youtube");
    expect(metadataFetch).toHaveBeenCalledTimes(1);
    expect(watchCalls()).toBe(1);
    expect(strangePageCalls()).toBe(pageCalls);
    expect(integrations.resolvePublicYoutubeBroadcasts).toHaveBeenCalledTimes(1);
  });
});
