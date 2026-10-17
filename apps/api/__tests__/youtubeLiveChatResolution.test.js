// @ts-nocheck
"use strict";

const fs = require("fs");
const path = require("path");
const {
  resolveLiveChat,
  normalizeYoutubeInput,
  extractLiveVideoId,
  extractChatContinuation,
  pollLiveChat,
} = require("../src/services/youtubeLiveChat");
const {
  parseEmbeddedJsonObject,
  extractChannelLiveVideoIds,
} = require("../src/services/youtubeViewerPages");

const dualPage = fs.readFileSync(path.join(__dirname, "fixtures/youtubeDualLiveChannel.excerpt.html"), "utf8");
const page = (data, name = "ytInitialData") => `<script>var ${name} = ${JSON.stringify(data)};</script>`;
const channelData = () => parseEmbeddedJsonObject(dualPage, dualPage.indexOf("{", dualPage.indexOf("var ytInitialData")));
const selectedTab = (data) => data.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer;
const chatPage = (continuation, extra = {}) => page({
  ...extra,
  contents: { liveChatRenderer: {
    continuations: [{ invalidationContinuationData: { continuation: "DEFAULT_TOP_CHAT" } }],
    header: { liveChatHeaderRenderer: { viewSelector: { sortFilterSubMenuRenderer: {
      subMenuItems: [
        { title: "Live chat", selected: false, continuation },
        { title: "Top chat", selected: true, continuation: "TOP_CHAT" },
      ],
    } } } },
  } },
});
const watchPage = (videoId, live) => page({
  videoDetails: { videoId, isLiveContent: true },
  microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: live } } },
}, "ytInitialPlayerResponse");
const mockPages = (pages) => jest.fn(async (url) => {
  if (!(String(url) in pages)) throw new Error(`unexpected URL: ${url}`);
  const value = pages[String(url)];
  return value instanceof Response ? value : new Response(value);
});
const chatUrl = (id) => `https://www.youtube.com/live_chat?is_popout=1&v=${id}&hl=en`;

describe("YouTube channel-owned live chat discovery", () => {
  test("merges both own broadcasts and ignores earlier unrelated live recommendations", async () => {
    const data = channelData();
    const recommendations = [{ videoRenderer: {
      videoId: "Wrong123456", isLive: true,
      badges: [{ metadataBadgeRenderer: { style: "BADGE_STYLE_TYPE_LIVE_NOW" } }],
    } }];
    // Put the recommendation first in serialized HTML, matching the failure.
    const html = page({ recommendations, ...data });
    const fetchImpl = mockPages({
      "https://www.youtube.com/@ReSpOnSeSC2/streams": html,
      [chatUrl("BTV9uqT4ur0")]: chatPage("PORTRAIT_ALL"),
      [chatUrl("4NTjE_j8a5o")]: chatPage("LANDSCAPE_ALL"),
    });

    const result = await resolveLiveChat("@ReSpOnSeSC2", { fetchImpl });

    expect(result.sessions).toEqual([
      expect.objectContaining({ videoId: "BTV9uqT4ur0", continuation: "PORTRAIT_ALL" }),
      expect.objectContaining({ videoId: "4NTjE_j8a5o", continuation: "LANDSCAPE_ALL" }),
    ]);
    expect(result).toMatchObject({ ...result.sessions[0], partial: false });
    expect(fetchImpl.mock.calls.map(([url]) => url)).not.toContain(chatUrl("Wrong123456"));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test("ignores foreign live videos inside selected-tab shelves, ads, and unknown wrappers", async () => {
    const data = channelData();
    const contents = selectedTab(data).content.richGridRenderer.contents;
    const foreign = { videoRenderer: {
      videoId: "Wrong123456", badges: [{ metadataBadgeRenderer: { style: "BADGE_STYLE_TYPE_LIVE_NOW" } }],
    } };
    contents.unshift(
      { richSectionRenderer: { content: { richShelfRenderer: { contents: [foreign] } } } },
      { adSlotRenderer: { content: foreign } },
      { recommendations: [foreign] },
    );
    const fetchImpl = mockPages({
      "https://www.youtube.com/@responsesc2/streams": page(data),
      [chatUrl("BTV9uqT4ur0")]: chatPage("PORTRAIT_ALL"),
      [chatUrl("4NTjE_j8a5o")]: chatPage("LANDSCAPE_ALL"),
    });
    const result = await resolveLiveChat("@responsesc2", { fetchImpl });
    expect(result.sessions.map((session) => session.videoId)).toEqual(["BTV9uqT4ur0", "4NTjE_j8a5o"]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test("an offline selected channel stays offline despite live recommendations", async () => {
    const data = channelData();
    data.recommendations = selectedTab(data).content.richGridRenderer.contents;
    selectedTab(data).content.richGridRenderer.contents = [];
    const fetchImpl = mockPages({ "https://www.youtube.com/@responsesc2/streams": page(data) });

    await expect(resolveLiveChat("@responsesc2", { fetchImpl })).rejects.toMatchObject({ code: "not_live" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("keeps the healthy broadcast when another broadcast disables chat", async () => {
    const fetchImpl = mockPages({
      "https://www.youtube.com/@responsesc2/streams": dualPage,
      [chatUrl("BTV9uqT4ur0")]: "<html>chat disabled</html>",
      "https://www.youtube.com/watch?v=BTV9uqT4ur0": watchPage("BTV9uqT4ur0", true),
      [chatUrl("4NTjE_j8a5o")]: chatPage("HEALTHY_CHAT"),
    });

    await expect(resolveLiveChat("@responsesc2", { fetchImpl })).resolves.toMatchObject({
      videoId: "4NTjE_j8a5o", partial: true,
      sessions: [{ videoId: "4NTjE_j8a5o", continuation: "HEALTHY_CHAT" }],
    });
  });

  test.each([
    "<html>consent required</html>",
    "var ytInitialData = { malformed }",
    page({ contents: {} }),
  ])("fails closed on unknown or malformed channel pages", async (html) => {
    const fetchImpl = mockPages({ "https://www.youtube.com/@responsesc2/streams": html });
    await expect(resolveLiveChat("@responsesc2", { fetchImpl })).rejects.toMatchObject({ code: "upstream" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("rejects a different selected channel and foreign selected endpoints", async () => {
    for (const endpoint of ["/@anotherchannel/streams", "https://evil.example/@responsesc2/streams"]) {
      const data = channelData();
      selectedTab(data).endpoint.commandMetadata.webCommandMetadata.url = endpoint;
      const fetchImpl = mockPages({ "https://www.youtube.com/@responsesc2/streams": page(data) });
      await expect(resolveLiveChat("@responsesc2", { fetchImpl })).rejects.toMatchObject({ code: "upstream" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  test("verifies requested channel IDs even when the selected endpoint uses a handle", () => {
    const data = channelData();
    data.metadata = { channelMetadataRenderer: { externalId: "UC_OWN_CHANNEL" } };
    expect(extractChannelLiveVideoIds(page(data), { expectedChannelPath: "/channel/UC_OWN_CHANNEL" })).toHaveLength(2);
    expect(extractChannelLiveVideoIds(page(data), { expectedChannelPath: "/channel/UC_OTHER_CHANNEL" })).toBeNull();
  });

  test("caps discovery at ten broadcasts and fetches no more than two concurrently", async () => {
    const data = channelData();
    const card = selectedTab(data).content.richGridRenderer.contents[0];
    selectedTab(data).content.richGridRenderer.contents = Array.from({ length: 12 }, (_, i) => {
      const copy = structuredClone(card);
      copy.richItemRenderer.content.lockupViewModel.contentId = `Video${String(i).padStart(6, "0")}`;
      return copy;
    });
    let active = 0;
    let maximum = 0;
    const fetchImpl = jest.fn(async (url) => {
      if (String(url).endsWith("/streams")) return new Response(page(data));
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return new Response(chatPage("ALL_CHAT"));
    });

    const result = await resolveLiveChat("@responsesc2", { fetchImpl });
    expect(result.sessions).toHaveLength(10);
    expect(result.sessions.map((session) => session.videoId)).toEqual(
      Array.from({ length: 10 }, (_, i) => `Video${String(i).padStart(6, "0")}`),
    );
    expect(maximum).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(11);
  });
});

describe("YouTube pinned broadcast and structured chat parsing", () => {
  test("only an upstream bad continuation permits cursor replacement", async () => {
    for (const [status, code] of [[400, "invalid_continuation"], [500, "upstream"], [503, "upstream"]]) {
      const fetchImpl = jest.fn(async () => new Response(null, { status }));
      await expect(pollLiveChat({ continuation: "previous-cursor" }, { fetchImpl }))
        .rejects.toMatchObject({ code });
    }
  });

  test.each([
    "BTV9uqT4ur0",
    "https://www.youtube.com/watch?v=BTV9uqT4ur0",
    "https://www.youtube.com/live/BTV9uqT4ur0",
  ])("keeps an explicit video pinned without channel discovery: %s", async (input) => {
    const fetchImpl = mockPages({ [chatUrl("BTV9uqT4ur0")]: chatPage("PINNED_ALL") });
    await expect(resolveLiveChat(input, { fetchImpl })).resolves.toMatchObject({
      videoId: "BTV9uqT4ur0", continuation: "PINNED_ALL", partial: false,
      sessions: [{ videoId: "BTV9uqT4ur0", continuation: "PINNED_ALL" }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("selects explicit Live chat regardless of ordering or unrelated continuations", () => {
    const html = chatPage("ALL_MESSAGES", { unrelated: { continuation: "WRONG_BEFORE" } }) +
      '<script>var unrelated = {"continuation":"WRONG_AFTER"};</script>';
    expect(extractChatContinuation(html)).toBe("ALL_MESSAGES");
    expect(extractChatContinuation('<script>var ytInitialData={"continuation":"UNRELATED"};</script>')).toBeNull();
    expect(extractChatContinuation(page({ contents: { liveChatRenderer: {
      continuations: [{ invalidationContinuationData: { continuation: "TOP_ONLY" } }],
    } } }))).toBeNull();
  });

  test("watch fallback reads only the primary player's exact video and live state", async () => {
    const wrongRecommendation = page({ recommendations: [{ videoId: "Wrong123456", isLive: true }] });
    const offline = wrongRecommendation + watchPage("BTV9uqT4ur0", false);
    expect(extractLiveVideoId(offline)).toBeNull();
    expect(extractLiveVideoId(wrongRecommendation + watchPage("BTV9uqT4ur0", true))).toBe("BTV9uqT4ur0");
    for (const [html, code] of [
      [offline, "not_live"],
      [wrongRecommendation + watchPage("Wrong123456", true), "upstream"],
      ["<html>consent</html>", "upstream"],
      [watchPage("BTV9uqT4ur0", true), "not_found"],
    ]) {
      const fetchImpl = mockPages({
        [chatUrl("BTV9uqT4ur0")]: "<html>no chat renderer</html>",
        "https://www.youtube.com/watch?v=BTV9uqT4ur0": html,
      });
      await expect(resolveLiveChat("BTV9uqT4ur0", { fetchImpl })).rejects.toMatchObject({ code });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  test("does not follow foreign redirects or redirects to another broadcast", async () => {
    for (const location of ["https://evil.example/chat", "https://www.youtube.com/live_chat?v=Wrong123456"]) {
      const fetchImpl = jest.fn(async () => new Response(null, { status: 302, headers: { location } }));
      await expect(resolveLiveChat("BTV9uqT4ur0", { fetchImpl })).rejects.toMatchObject({ code: "upstream" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
    expect(() => normalizeYoutubeInput("https://evil.example/@responsesc2")).toThrow();
    expect(() => normalizeYoutubeInput("https://youtube.com/feed/trending")).toThrow();
  });

  test("keeps bounded page reads during channel discovery", async () => {
    const fetchImpl = jest.fn(async () => new Response("too big", { headers: { "content-length": "1024" } }));
    await expect(resolveLiveChat("@responsesc2", { fetchImpl, maxPageBytes: 64 })).rejects.toMatchObject({ code: "upstream_too_large" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("enforces the page body bound even without content-length", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(128));
        controller.close();
      },
    });
    const fetchImpl = jest.fn(async () => new Response(body));
    await expect(resolveLiveChat("@responsesc2", { fetchImpl, maxPageBytes: 64 }))
      .rejects.toMatchObject({ code: "upstream_too_large" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("aborts multi-stream resolution instead of returning a partial cancelled result", async () => {
    const controller = new AbortController();
    const fetchImpl = jest.fn(async (url, opts) => {
      if (String(url).endsWith("/streams")) return new Response(dualPage);
      await new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
        if (fetchImpl.mock.calls.length === 3) controller.abort();
      });
      throw new Error("unreachable");
    });
    await expect(resolveLiveChat("@responsesc2", { fetchImpl, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[1][1].signal.aborted).toBe(true);
    expect(fetchImpl.mock.calls[2][1].signal.aborted).toBe(true);
  });
});
