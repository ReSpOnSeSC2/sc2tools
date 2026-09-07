// @ts-nocheck
"use strict";

const oauth = require("../src/services/platformOauthClients");
const { PlatformIntegrationsService } = require("../src/services/platformIntegrations");

const NOW = Date.parse("2026-09-07T16:00:00Z");
const START = "2026-09-07T12:00:00Z";
const END = "2026-09-07T15:00:00Z";
const CHANNEL = "UC9OluGthYmZo0vsF9IjicFg";
const OTHER_CHANNEL = "UCYxRlFDqcWM4y7FfpiAN3KQ";
const VIDEO = "abcdEFGhijk";
const videoId = (n) => `v${String(n).padStart(10, "0")}`;
const publicItem = (overrides = {}) => ({
  id: VIDEO,
  snippet: { channelId: CHANNEL, liveBroadcastContent: "none", publishedAt: "2026-01-01T00:00:00Z" },
  status: { privacyStatus: "public" },
  liveStreamingDetails: { actualStartTime: START, actualEndTime: END },
  contentDetails: { duration: "PT3H" },
  ...overrides,
});
const metadata = (overrides = {}) => ({
  platform: "youtube", videoId: VIDEO, channelId: CHANNEL,
  startMs: Date.parse(START), endMs: Date.parse(END), ongoing: false,
  orientation: "unknown", ...overrides,
});
function jsonResponse(payload, status = 200) {
  const body = JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status,
    headers: { get: () => String(Buffer.byteLength(body)) }, text: async () => body };
}

afterEach(() => jest.restoreAllMocks());

describe("public YouTube broadcast metadata", () => {
  test("uses one official videos.list request and returns only public timing fields", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ items: [publicItem({ privateOwnerField: "secret" })] }));
    const result = await oauth.listPublicYoutubeBroadcasts("access-secret", fetchImpl, { videoIds: [VIDEO], nowMs: NOW });
    expect(result).toEqual([metadata()]);
    const [rawUrl, init] = fetchImpl.mock.calls[0];
    const url = new URL(rawUrl);
    expect(url.origin + url.pathname).toBe("https://www.googleapis.com/youtube/v3/videos");
    expect(url.searchParams.get("id")).toBe(VIDEO);
    expect(url.searchParams.get("part")).toBe("snippet,status,liveStreamingDetails,contentDetails");
    expect(url.searchParams.has("mine")).toBe(false);
    expect(url.searchParams.has("maxResults")).toBe(false);
    expect(url.searchParams.get("fields")).toContain("status/privacyStatus");
    expect(init.headers.Authorization).toBe("Bearer access-secret");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("rejects private, unlisted, upcoming, uploads, invalid intervals and invalid channels", async () => {
    const invalid = [
      { status: { privacyStatus: "private" } },
      { status: { privacyStatus: "unlisted" } },
      { status: {} },
      { snippet: { channelId: "not-a-channel", liveBroadcastContent: "none" } },
      { snippet: { channelId: CHANNEL, liveBroadcastContent: "upcoming" } },
      { liveStreamingDetails: { scheduledStartTime: START, actualEndTime: END } },
      { liveStreamingDetails: undefined },
      { liveStreamingDetails: { actualStartTime: START } },
      { liveStreamingDetails: { actualStartTime: START, actualEndTime: "invalid" }, snippet: { channelId: CHANNEL, liveBroadcastContent: "live" } },
      { liveStreamingDetails: { actualStartTime: END, actualEndTime: START } },
      { liveStreamingDetails: { actualStartTime: "2026-09-08T00:00:00Z" }, snippet: { channelId: CHANNEL, liveBroadcastContent: "live" } },
      { liveStreamingDetails: { actualStartTime: START, actualEndTime: "2026-09-08T00:00:00Z" } },
    ].map((overrides, index) => publicItem({ ...overrides, id: videoId(index) }));
    const fetchImpl = jest.fn(async () => jsonResponse({ items: invalid }));
    await expect(oauth.listPublicYoutubeBroadcasts("token", fetchImpl, {
      videoIds: invalid.map((item) => item.id), nowMs: NOW,
    })).resolves.toEqual([]);
  });

  test("an explicitly live broadcast ends at observed now without a future grace window", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ items: [publicItem({
      snippet: { channelId: CHANNEL, liveBroadcastContent: "live", thumbnails: { default: { width: 100, height: 200 } } },
      liveStreamingDetails: { actualStartTime: START },
    })] }));
    await expect(oauth.listPublicYoutubeBroadcasts("token", fetchImpl, { videoIds: [VIDEO], nowMs: NOW }))
      .resolves.toEqual([metadata({ endMs: NOW, ongoing: true, orientation: "unknown" })]);
  });

  test("caps at 50 unique valid IDs and ignores duplicate or unrequested results", async () => {
    const ids = Array.from({ length: 55 }, (_, index) => videoId(index));
    const fetchImpl = jest.fn(async () => jsonResponse({ items: [
      publicItem({ id: ids[0] }), publicItem({ id: ids[0] }), publicItem({ id: ids[54] }),
    ] }));
    const result = await oauth.listPublicYoutubeBroadcasts("token", fetchImpl, {
      videoIds: [null, "https://youtube.com/watch?v=other", ids[0], ...ids], nowMs: NOW,
    });
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get("id").split(",")).toEqual(ids.slice(0, 50));
    expect(result).toEqual([metadata({ videoId: ids[0] })]);
    await expect(oauth.listPublicYoutubeBroadcasts("token", fetchImpl, { videoIds: ["bad"] })).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("retains provider status for bounded failure handling", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ error: "quota exceeded" }, 429));
    await expect(oauth.listPublicYoutubeBroadcasts("token", fetchImpl, { videoIds: [VIDEO] }))
      .rejects.toMatchObject({ status: 429, code: "youtube_public_broadcasts" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

function connectedRow(overrides = {}) {
  return {
    connectionRevision: "revision-1", accessToken: "access-secret", refreshToken: "refresh-secret",
    expiresAt: new Date(NOW + 3_600_000), platformUserId: OTHER_CHANNEL,
    scopes: [...oauth.YOUTUBE_SCOPES], ...overrides,
  };
}

function serviceFixture(overrides = {}, initial = connectedRow()) {
  let current = initial;
  const listPublicYoutubeBroadcasts = jest.fn(async () => [metadata()]);
  const refreshYoutubeToken = jest.fn(async () => ({
    accessToken: "refreshed-secret", refreshToken: "refresh-secret",
    expiresAt: new Date(NOW + 3_600_000), scopes: [...oauth.YOUTUBE_SCOPES],
  }));
  const service = new PlatformIntegrationsService({}, {
    config: { enabled: true, encryptionKey: Buffer.alloc(32, 7), youtube: {
      clientId: "test-client", clientSecret: "client-secret", redirectUri: "https://example.com/callback",
    } },
    now: () => NOW, overlayTokens: { list: async () => [] },
    oauth: { ...oauth, listPublicYoutubeBroadcasts, refreshYoutubeToken, ...overrides },
  });
  // CAS-aware vault boundary; encryption itself has dedicated integration tests.
  service.vault = {
    getConnection: jest.fn(async (userId) => userId === "user-1" && current ? { ...current } : null),
    isConnectionCurrent: jest.fn(async (_user, _platform, revision) => current?.connectionRevision === revision),
    updateTokens: jest.fn(async (_user, _platform, value, revision) => {
      if (!current || current.connectionRevision !== revision) return false;
      current = { ...current, ...value };
      return true;
    }),
  };
  return { service, listPublicYoutubeBroadcasts, refreshYoutubeToken,
    replace: (row) => { current = row; }, current: () => current };
}

describe("public metadata OAuth grant lifecycle", () => {
  test("missing and anonymous grants never invoke provider metadata lookup", async () => {
    const fixture = serviceFixture();
    await expect(fixture.service.resolvePublicYoutubeBroadcasts("", [VIDEO])).resolves.toBeNull();
    await expect(fixture.service.resolvePublicYoutubeBroadcasts("other-user", [VIDEO])).resolves.toBeNull();
    await expect(fixture.service.resolvePublicYoutubeBroadcasts("user-1", [])).resolves.toEqual([]);
    expect(fixture.listPublicYoutubeBroadcasts).not.toHaveBeenCalled();
  });

  test("permits another public channel while stripping provider credentials and unrequested rows", async () => {
    const fixture = serviceFixture();
    fixture.listPublicYoutubeBroadcasts.mockResolvedValue([
      metadata({ accessToken: "access-secret", refreshToken: "refresh-secret", nested: { secret: true } }),
      metadata({ videoId: videoId(2) }), metadata({ channelId: "bad" }),
    ]);
    const result = await fixture.service.resolvePublicYoutubeBroadcasts("user-1", [VIDEO]);
    expect(result).toEqual([metadata()]);
    expect(fixture.listPublicYoutubeBroadcasts).toHaveBeenCalledWith("access-secret", expect.any(Function), { videoIds: [VIDEO], nowMs: NOW });
    expect(fixture.service.vault.getConnection).toHaveBeenCalledWith("user-1", "youtube");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("refreshes an expired grant before the public request and CAS-stores its token", async () => {
    const fixture = serviceFixture({}, connectedRow({ expiresAt: new Date(NOW - 1) }));
    await expect(fixture.service.resolvePublicYoutubeBroadcasts("user-1", [VIDEO])).resolves.toEqual([metadata()]);
    expect(fixture.refreshYoutubeToken).toHaveBeenCalledTimes(1);
    expect(fixture.listPublicYoutubeBroadcasts.mock.calls[0][0]).toBe("refreshed-secret");
    expect(fixture.service.vault.updateTokens.mock.calls[0][3]).toBe("revision-1");
    expect(fixture.current().accessToken).toBe("refreshed-secret");
  });

  test("rejects missing read scope and explicitly narrowed refresh scope", async () => {
    const missing = serviceFixture({}, connectedRow({ scopes: [] }));
    await expect(missing.service.resolvePublicYoutubeBroadcasts("user-1", [VIDEO]))
      .rejects.toMatchObject({ code: "youtube_scopes_missing", status: 403 });
    expect(missing.listPublicYoutubeBroadcasts).not.toHaveBeenCalled();
    const narrowed = serviceFixture({}, connectedRow({ expiresAt: new Date(NOW - 1) }));
    narrowed.refreshYoutubeToken.mockResolvedValue({ accessToken: "narrow-token", scopes: ["openid"] });
    await expect(narrowed.service.resolvePublicYoutubeBroadcasts("user-1", [VIDEO]))
      .rejects.toMatchObject({ code: "youtube_scopes_missing", status: 403 });
    expect(narrowed.listPublicYoutubeBroadcasts).not.toHaveBeenCalled();
    expect(narrowed.service.vault.updateTokens).not.toHaveBeenCalled();
  });

  test("retries an unexpected 401 once using a refresh, then surfaces another failure", async () => {
    const fixture = serviceFixture();
    fixture.listPublicYoutubeBroadcasts.mockRejectedValue(new oauth.PlatformOauthError("youtube_public_broadcasts", "expired", 401));
    await expect(fixture.service.resolvePublicYoutubeBroadcasts("user-1", [VIDEO])).rejects.toMatchObject({ status: 401 });
    expect(fixture.listPublicYoutubeBroadcasts.mock.calls.map((call) => call[0])).toEqual(["access-secret", "refreshed-secret"]);
    expect(fixture.refreshYoutubeToken).toHaveBeenCalledTimes(1);
  });

  test("a refresh replaced on another instance hands off without using its stale token", async () => {
    const fixture = serviceFixture({}, connectedRow({ expiresAt: new Date(NOW - 1) }));
    fixture.refreshYoutubeToken.mockImplementation(async () => {
      fixture.replace(connectedRow({ connectionRevision: "revision-2", accessToken: "new-grant" }));
      return { accessToken: "stale-refreshed-token", scopes: [...oauth.YOUTUBE_SCOPES] };
    });
    await expect(fixture.service.resolvePublicYoutubeBroadcasts("user-1", [VIDEO])).resolves.toEqual([metadata()]);
    expect(fixture.listPublicYoutubeBroadcasts.mock.calls.map((call) => call[0])).toEqual(["new-grant"]);
    expect(fixture.current().accessToken).toBe("new-grant");
  });

  test("disconnecting during lookup discards the result", async () => {
    const fixture = serviceFixture();
    fixture.listPublicYoutubeBroadcasts.mockImplementation(async () => {
      fixture.replace(null);
      return [metadata()];
    });
    await expect(fixture.service.resolvePublicYoutubeBroadcasts("user-1", [VIDEO])).resolves.toBeNull();
    expect(fixture.listPublicYoutubeBroadcasts).toHaveBeenCalledTimes(1);
  });

  test("reconnecting during lookup discards the old response and retries the new revision", async () => {
    const fixture = serviceFixture();
    fixture.listPublicYoutubeBroadcasts.mockImplementationOnce(async () => {
      fixture.replace(connectedRow({ connectionRevision: "revision-2", accessToken: "new-grant" }));
      return [metadata({ endMs: Date.parse(START) + 10 })];
    });
    await expect(fixture.service.resolvePublicYoutubeBroadcasts("user-1", [VIDEO])).resolves.toEqual([metadata()]);
    expect(fixture.listPublicYoutubeBroadcasts.mock.calls.map((call) => call[0])).toEqual(["access-secret", "new-grant"]);
  });

  test("public and owned lookups share one local connection lock", async () => {
    let release;
    const listYoutubeGameVods = jest.fn(async () => ({ channelId: OTHER_CHANNEL, vods: [] }));
    const fixture = serviceFixture({ listYoutubeGameVods });
    fixture.listPublicYoutubeBroadcasts.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const pending = fixture.service.resolvePublicYoutubeBroadcasts("user-1", [VIDEO]);
    await new Promise((resolve) => setImmediate(resolve));
    const owned = fixture.service.resolveYoutubeGameVods("user-1");
    await new Promise((resolve) => setImmediate(resolve));
    expect(listYoutubeGameVods).not.toHaveBeenCalled();
    release([metadata()]);
    await expect(pending).resolves.toEqual([metadata()]);
    await expect(owned).resolves.toMatchObject({ channelId: OTHER_CHANNEL });
    expect(listYoutubeGameVods).toHaveBeenCalledTimes(1);
    expect(fixture.service.connectionLocks.size).toBe(0);
  });

  test("the complete public request inherits the existing twenty-second abort deadline", async () => {
    const deadline = new AbortController();
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = jest.spyOn(AbortSignal, "timeout").mockImplementation((ms) => ms === 20_000 ? deadline.signal : realTimeout(ms));
    const fixture = serviceFixture({ listPublicYoutubeBroadcasts: oauth.listPublicYoutubeBroadcasts });
    fixture.service.fetchImpl = jest.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const pending = fixture.service.resolvePublicYoutubeBroadcasts("user-1", [VIDEO]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(timeout).toHaveBeenCalledWith(20_000);
    deadline.abort();
    await expect(pending).rejects.toMatchObject({ code: "youtube_public_broadcasts" });
    expect(fixture.service.fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    expect(fixture.service.connectionLocks.size).toBe(0);
  });

  test("caller cancellation aborts an active request", async () => {
    const abort = new AbortController();
    const fixture = serviceFixture({ listPublicYoutubeBroadcasts: oauth.listPublicYoutubeBroadcasts });
    fixture.service.fetchImpl = jest.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const pending = fixture.service.resolvePublicYoutubeBroadcasts("user-1", [VIDEO], { signal: abort.signal });
    await new Promise((resolve) => setImmediate(resolve));
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "youtube_public_broadcasts" });
    expect(fixture.service.fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    expect(fixture.service.connectionLocks.size).toBe(0);
  });

  test("a caller cancelled while waiting for the grant lock never reads credentials or calls YouTube", async () => {
    let release;
    const fixture = serviceFixture();
    const blocker = fixture.service._withConnectionLock("user-1", "youtube",
      () => new Promise((resolve) => { release = resolve; }));
    await new Promise((resolve) => setImmediate(resolve));
    const abort = new AbortController();
    const queued = fixture.service.resolvePublicYoutubeBroadcasts("user-1", [VIDEO], { signal: abort.signal });
    abort.abort();
    release();
    await blocker;
    await expect(queued).resolves.toBeNull();
    await expect(fixture.service.resolvePublicYoutubeBroadcasts("user-1", [VIDEO], { signal: abort.signal })).resolves.toBeNull();
    expect(fixture.service.vault.getConnection).not.toHaveBeenCalled();
    expect(fixture.listPublicYoutubeBroadcasts).not.toHaveBeenCalled();
    expect(fixture.service.connectionLocks.size).toBe(0);
  });

  test("a cancelled failed read does not start a token refresh", async () => {
    const abort = new AbortController();
    const fixture = serviceFixture();
    fixture.listPublicYoutubeBroadcasts.mockImplementation(async () => {
      abort.abort();
      throw new oauth.PlatformOauthError("youtube_public_broadcasts", "expired", 401);
    });
    await expect(fixture.service.resolvePublicYoutubeBroadcasts("user-1", [VIDEO], { signal: abort.signal }))
      .rejects.toMatchObject({ status: 401 });
    expect(fixture.refreshYoutubeToken).not.toHaveBeenCalled();
    expect(fixture.listPublicYoutubeBroadcasts).toHaveBeenCalledTimes(1);
  });
});
