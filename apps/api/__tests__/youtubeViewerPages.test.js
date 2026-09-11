// @ts-nocheck
"use strict";

const fs = require("fs");
const path = require("path");
const {
  parseEmbeddedJsonObject,
  extractChannelLiveVideoIds,
  extractWatchLiveState,
} = require("../src/services/youtubeViewerPages");

const captured = fs.readFileSync(path.join(__dirname, "fixtures/youtubeDualLiveChannel.excerpt.html"), "utf8");
const initialData = () => parseEmbeddedJsonObject(captured, captured.indexOf("{", captured.indexOf("var ytInitialData")));
const asPage = (data) => `<script>window["ytInitialData"] = ${JSON.stringify(data)};</script>`;

test("discovers both actual @responsesc2 live broadcasts from the current lockup schema", () => {
  expect(extractChannelLiveVideoIds(captured)).toEqual(["BTV9uqT4ur0", "4NTjE_j8a5o"]);
});

test("only the selected Live tab's own live video cards are counted", () => {
  const data = initialData();
  const tabs = data.contents.twoColumnBrowseResultsRenderer.tabs;
  const tab = tabs[0].tabRenderer;
  const items = tab.content.richGridRenderer.contents;
  const card = items[0].richItemRenderer.content.lockupViewModel;
  const otherChannel = structuredClone(items[0]);
  otherChannel.richItemRenderer.content.lockupViewModel.contentId = "Other123456";
  data.recommendations = [otherChannel];
  tabs.push({ tabRenderer: { selected: false, content: { richGridRenderer: { contents: [otherChannel] } } } });
  const upcoming = structuredClone(card);
  upcoming.contentId = "Wait1234567";
  upcoming.metadata.lockupMetadataViewModel.title.content = "LIVE right now with 1,000 watching now";
  upcoming.contentImage.thumbnailViewModel.overlays[0].thumbnailBottomOverlayViewModel.badges[0]
    .thumbnailBadgeViewModel.badgeStyle = "THUMBNAIL_OVERLAY_BADGE_STYLE_DEFAULT";
  items.push({ richItemRenderer: { content: { lockupViewModel: upcoming } } });
  const playlist = structuredClone(card);
  playlist.contentType = "LOCKUP_CONTENT_TYPE_PLAYLIST";
  playlist.contentId = "List1234567";
  items.push({ richItemRenderer: { content: { lockupViewModel: playlist } } });
  // A duplicate video card must not double its viewers.
  items.push(structuredClone(items[0]));
  expect(extractChannelLiveVideoIds(asPage(data)).sort()).toEqual(["4NTjE_j8a5o", "BTV9uqT4ur0"]);
});

test("supports older grid/video renderers with explicit live badges", () => {
  const data = initialData();
  const tab = data.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer;
  tab.content = { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [
    { gridVideoRenderer: { videoId: "First123456", thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: { style: "LIVE" } }] } },
    { videoRenderer: { videoId: "Second12345", badges: [{ metadataBadgeRenderer: { style: "BADGE_STYLE_TYPE_LIVE_NOW" } }] } },
    { videoRenderer: { videoId: "Wait1234567", upcomingEventData: {}, thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: { style: "UPCOMING" } }] } },
    { videoRenderer: { videoId: "Ended123456", viewCountText: { simpleText: "1,200 views" } } },
  ] } }] } };
  expect(extractChannelLiveVideoIds(asPage(data))).toEqual(["First123456", "Second12345"]);
});

test("distinguishes a recognized empty Live tab from consent, Home redirects, and schema errors", () => {
  const data = initialData();
  const tab = data.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer;
  tab.content.richGridRenderer.contents = [];
  expect(extractChannelLiveVideoIds(asPage(data))).toEqual([]);
  tab.endpoint.commandMetadata.webCommandMetadata.url = "/@responsesc2/featured";
  expect(extractChannelLiveVideoIds(asPage(data))).toBeNull();
  expect(extractChannelLiveVideoIds("<html>consent</html>")).toBeNull();
  expect(extractChannelLiveVideoIds("var ytInitialData = { broken }")).toBeNull();
});

test("JSON parsing respects braces and escapes inside titles", () => {
  const value = { title: 'A } title with "quotes" and \\ braces {', nested: { live: true } };
  expect(parseEmbeddedJsonObject(JSON.stringify(value) + '; window.unrelated = {}', 0)).toEqual(value);
  expect(parseEmbeddedJsonObject('{"broken":', 0)).toBeNull();
});

test("waiting, ended and non-live player state is distinct from missing state", () => {
  expect(extractWatchLiveState(fs.readFileSync(path.join(__dirname, "fixtures/youtubeWaitingWatchPage.excerpt.html"), "utf8"))).toBe(false);
  expect(extractWatchLiveState('{"liveBroadcastDetails":{"isLiveNow":true}}')).toBe(true);
  expect(extractWatchLiveState('{"liveBroadcastDetails":{"isLiveNow":false}}')).toBe(false);
  expect(extractWatchLiveState('{"videoDetails":{"videoId":"abcABC12345","isUpcoming":true}}')).toBe(false);
  expect(extractWatchLiveState('{"videoDetails":{"videoId":"abcABC12345","isLiveContent":false}}')).toBe(false);
  expect(extractWatchLiveState('<html>consent required</html>')).toBeNull();
});
