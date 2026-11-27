import { describe, expect, it } from "vitest";
import {
  applyFilters,
  DEFAULT_FILTERS,
  degradedPlatforms,
  languageName,
  languagesIn,
  listingIsOff,
  liveForLabel,
  readLiveStreams,
  viewerLabel,
  type LiveStream,
} from "../streams";

const stream = (n: number, extra: Partial<LiveStream> = {}): LiveStream => ({
  id: `twitch:${n}`, platform: "twitch", channel: `Chan${n}`, title: `Game ${n}`, language: "en",
  viewers: n * 10, startedAt: "2026-11-27T10:00:00Z", url: `https://www.twitch.tv/chan${n}`, ...extra,
});

const snapshot = (streams: unknown[], platforms: unknown = { twitch: "ok", kick: "ok" }) =>
  ({ streams, platforms, fetchedAt: "2026-11-27T12:00:00.000Z" });

describe("readLiveStreams", () => {
  it("accepts the server answer", () => {
    const read = readLiveStreams(snapshot([stream(1)]));
    expect(read?.streams).toEqual([stream(1)]);
    expect(read?.platforms).toEqual({ twitch: "ok", kick: "ok" });
  });

  it("rejects an answer of the wrong shape", () => {
    expect(readLiveStreams(null)).toBeNull();
    expect(readLiveStreams({ streams: [] })).toBeNull();
    expect(readLiveStreams(snapshot([], { twitch: "ok", kick: "weird" }))).toBeNull();
    expect(readLiveStreams({ ...snapshot([]), fetchedAt: 5 })).toBeNull();
  });

  it("links only to the own channel page of each platform, over https", () => {
    const read = readLiveStreams(snapshot([
      stream(1),
      stream(2, { url: "https://evil.example/chan2" }),
      stream(3, { url: "http://www.twitch.tv/chan3" }),
      stream(4, { url: "javascript:alert(1)" }),
      stream(5, { platform: "kick", url: "https://www.twitch.tv/chan5" }),
      stream(6, { platform: "kick", url: "https://kick.com/chan6" }),
    ]));
    expect(read?.streams.map(row => row.id)).toEqual(["twitch:1", "twitch:6"]);
  });

  it("drops rows without a channel and repairs missing optional fields", () => {
    const read = readLiveStreams(snapshot([
      stream(1, { channel: "" }),
      { ...stream(2), title: undefined, language: "", viewers: -4 },
    ]));
    expect(read?.streams).toEqual([stream(2, { title: "", language: "other", viewers: 0 })]);
  });
});

describe("applyFilters", () => {
  const streams = [
    stream(1, { language: "en", viewers: 40 }),
    stream(2, { platform: "kick", language: "pt", viewers: 900, url: "https://kick.com/chan2" }),
    stream(3, { language: "pt", viewers: 5 }),
  ];

  it("orders by viewers, or smallest channels first", () => {
    expect(applyFilters(streams, DEFAULT_FILTERS).map(s => s.viewers)).toEqual([900, 40, 5]);
    expect(applyFilters(streams, { ...DEFAULT_FILTERS, sort: "small" }).map(s => s.viewers)).toEqual([5, 40, 900]);
  });

  it("filters by platform and language together", () => {
    expect(applyFilters(streams, { ...DEFAULT_FILTERS, platform: "kick" }).map(s => s.id)).toEqual(["twitch:2"]);
    expect(applyFilters(streams, { ...DEFAULT_FILTERS, language: "pt" })).toHaveLength(2);
    expect(applyFilters(streams, { platform: "twitch", language: "pt", sort: "viewers" }).map(s => s.id)).toEqual(["twitch:3"]);
  });

  it("does not reorder the list it was given", () => {
    const before = streams.map(s => s.id);
    applyFilters(streams, { ...DEFAULT_FILTERS, sort: "small" });
    expect(streams.map(s => s.id)).toEqual(before);
  });
});

describe("list helpers", () => {
  it("lists languages with the most channels first", () => {
    expect(languagesIn([stream(1, { language: "pt" }), stream(2), stream(3), stream(4, { language: "de" })])).toEqual(["en", "de", "pt"]);
  });

  it("reports platforms that could not be refreshed and a listing that is off", () => {
    expect(degradedPlatforms({ twitch: "ok", kick: "stale" })).toEqual(["kick"]);
    expect(degradedPlatforms({ twitch: "error", kick: "stale" })).toEqual(["twitch", "kick"]);
    expect(degradedPlatforms({ twitch: "off", kick: "ok" })).toEqual([]);
    expect(listingIsOff({ twitch: "off", kick: "off" })).toBe(true);
    expect(listingIsOff({ twitch: "off", kick: "ok" })).toBe(false);
  });

  it("names languages, viewers and uptime in plain words", () => {
    expect(languageName("pt")).toBe("Portuguese");
    expect(languageName("other")).toBe("Other");
    expect(viewerLabel(1)).toBe("1 viewer");
    expect(viewerLabel(1234)).toBe("1,234 viewers");
    const now = Date.parse("2026-11-27T12:00:00Z");
    expect(liveForLabel("2026-11-27T11:30:00Z", now)).toBe("30 min");
    expect(liveForLabel("2026-11-27T09:55:00Z", now)).toBe("2 h 5 min");
    expect(liveForLabel("2026-11-27T13:00:00Z", now)).toBe("");
    expect(liveForLabel("", now)).toBe("");
  });
});
