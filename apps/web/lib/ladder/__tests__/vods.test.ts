import { describe, expect, it } from "vitest";
import {
  ANY_FILTERS,
  DEFAULT_FILTERS,
  lengthLabel,
  ladderVodsUrl,
  MAP_OPTIONS,
  ratingLabel,
  readLadderVods,
  sameFilters,
} from "../vods";

const row = (extra: Record<string, unknown> = {}) => ({
  id: "1",
  vodUrl: "https://www.twitch.tv/videos/2942397497?t=1543s",
  channel: "serral",
  subscribersOnly: false,
  streamerRace: "zerg",
  opponentRace: "terran",
  rating: 6700,
  map: "Blackrock LE",
  durationSec: 764,
  playedAt: "2026-11-27T18:18:50.000Z",
  ...extra,
});
const answer = (results: unknown[], extra: Record<string, unknown> = {}) =>
  ({ available: true, results, next: null, fetchedAt: "2026-11-28T08:00:00.000Z", ...extra });

describe("readLadderVods", () => {
  it("reads a page and the gate-off answer", () => {
    expect(readLadderVods({ available: false })).toEqual({ available: false });
    expect(readLadderVods(answer([row()], { next: "abc" }))).toMatchObject({ available: true, next: "abc", results: [{ id: "1", channel: "serral" }] });
  });

  it.each([
    ["null", null],
    ["no flag", { results: [] }],
    ["no list", { available: true, fetchedAt: "x" }],
    ["no time", { available: true, results: [] }],
  ])("rejects an answer with %s", (_label, value) => expect(readLadderVods(value)).toBeNull());

  it.each([
    ["a VOD on another host", { vodUrl: "https://evil.test/videos/1" }],
    ["a plain http VOD", { vodUrl: "http://www.twitch.tv/videos/1" }],
    ["a Twitch page that is not a VOD", { vodUrl: "https://www.twitch.tv/serral" }],
    ["an unknown race", { streamerRace: "protoss2" }],
    ["a negative rating", { rating: -1 }],
    ["no map", { map: "" }],
    ["a bad date", { playedAt: "yesterday" }],
    ["no id", { id: "" }],
  ])("drops a result with %s", (_label, extra) => {
    expect(readLadderVods(answer([row(extra), row({ id: "2" })]))).toMatchObject({ results: [{ id: "2" }] });
  });

  it("keeps a result whose channel is missing or not a Twitch login", () => {
    const read = readLadderVods(answer([row({ channel: null }), row({ id: "2", channel: "a b/../c" })]));
    expect(read).toMatchObject({ results: [{ channel: null }, { channel: null }] });
  });
});

describe("ladderVodsUrl", () => {
  it("sends only the menus that are set, then the cursor", () => {
    const url = new URL(ladderVodsUrl(DEFAULT_FILTERS, "next-1"));
    expect(url.pathname).toBe("/v1/ladder-vods");
    expect(Object.fromEntries(url.searchParams)).toEqual({ matchup: "tvz", rating: "5000", after: "next-1" });
    expect(ladderVodsUrl(ANY_FILTERS, null)).toMatch(/\/v1\/ladder-vods$/);
  });
});

describe("labels", () => {
  it("rounds the length to whole minutes, with hours past an hour", () => {
    expect(lengthLabel(20)).toBe("1 min");
    expect(lengthLabel(764)).toBe("13 min");
    expect(lengthLabel(3900)).toBe("1 h 5 min");
    expect(ratingLabel(6700)).toBe("6,700 MMR");
  });

  it("compares filter sets", () => {
    expect(sameFilters(ANY_FILTERS, { ...ANY_FILTERS })).toBe(true);
    expect(sameFilters(ANY_FILTERS, DEFAULT_FILTERS)).toBe(false);
  });

  it("offers the nine ladder maps and any", () => {
    expect(MAP_OPTIONS).toHaveLength(10);
  });
});
