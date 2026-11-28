// @ts-nocheck
"use strict";

const {
  SMALL_MAX_VIEWERS, RAID_WINDOW_MS, HISTORY_LIMIT, MAX_CANDIDATES, raidSettings, sanitizeHistory, livePendingRaid, rankCandidates, raidFailureError,
} = require("../src/services/twitchRaidPolicy");

const NOW = Date.UTC(2026, 10, 28, 12);
const stream = (n, viewers, extra = {}) => ({
  id: `twitch:${n}`, platform: "twitch", channel: `Chan${n}`, title: "", language: "en", viewers,
  startedAt: "2026-11-28T10:00:00Z", url: `https://www.twitch.tv/chan${n}`, broadcasterId: String(1000 + n), ...extra,
});
const entry = (dir, channel, at, state = dir === "in" ? "received" : "queued") => ({ id: `${dir}-${channel}-${at}`, dir, channel, viewers: 5, state, at });
const self = { twitchId: "", kickName: "" };
const names = rows => rows.map(row => row.channel);

describe("rankCandidates", () => {
  test("small channels first, then raided or raided-by channels, then the rest", () => {
    const streams = [stream(1, 300), stream(2, SMALL_MAX_VIEWERS + 5), stream(3, 200), stream(4, 2), stream(5, SMALL_MAX_VIEWERS)];
    const history = [entry("out", "Chan3", NOW - 1000), entry("in", "Chan1", NOW - 5000)];
    expect(names(rankCandidates(streams, { history, self }))).toEqual(["Chan4", "Chan5", "Chan3", "Chan1", "Chan2"]);
  });
  test("within a tier the smaller channel comes first, and the relationship tier is newest first", () => {
    const streams = [stream(1, 90), stream(2, 60), stream(3, 70), stream(4, 40)];
    const history = [entry("in", "Chan1", NOW - 9000), entry("out", "Chan2", NOW - 1000)];
    expect(names(rankCandidates(streams, { history, self }))).toEqual(["Chan2", "Chan1", "Chan4", "Chan3"]);
  });
  test("a channel matches its history whatever the name's case", () => {
    const rows = rankCandidates([stream(1, 100)], { history: [entry("in", "cHAN1", NOW)], self });
    expect(rows[0].relation).toBe("raided_by");
  });
  test("a raid that was cancelled, failed or never confirmed does not count as raided", () => {
    const history = ["canceled", "failed", "unconfirmed", "pending"].map((state, i) => entry("out", "Chan1", NOW - i, state));
    expect(rankCandidates([stream(1, 100)], { history, self })[0].relation).toBeNull();
  });
  test("a raid whose cancel found nothing left (it already went) still counts as raided", () => {
    expect(rankCandidates([stream(1, 100)], { history: [entry("out", "Chan1", NOW, "closed")], self })[0].relation).toBe("raided");
  });
  test("the streamer's own Twitch and Kick channels never appear", () => {
    const streams = [stream(1, 3), stream(2, 4), { ...stream(3, 5), platform: "kick", id: "kick:9", channel: "MyKick", broadcasterId: undefined }];
    const rows = rankCandidates(streams, { history: [], self: { twitchId: "1001", kickName: "mykick" } });
    expect(names(rows)).toEqual(["Chan2"]);
  });
  test("Kick channels are listed for the link only, and no row carries the provider id", () => {
    const kick = { ...stream(7, 4), platform: "kick", id: "kick:7", broadcasterId: undefined };
    const [first, second] = rankCandidates([kick, stream(8, 9)], { history: [], self });
    expect(first).toMatchObject({ id: "kick:7", raidable: false });
    expect(second).toMatchObject({ id: "twitch:8", raidable: true });
    expect(JSON.stringify([first, second])).not.toContain("broadcasterId");
  });
  test("the list is capped", () => {
    const streams = Array.from({ length: MAX_CANDIDATES + 10 }, (_, i) => stream(i + 1, i + 1));
    expect(rankCandidates(streams, { history: [], self })).toHaveLength(MAX_CANDIDATES);
  });
});

describe("history and the pending raid", () => {
  test("a receipt that never got Twitch's answer is shown as unconfirmed, never queued", () => {
    const fresh = entry("out", "A", NOW - 1000, "pending"), stale = entry("out", "B", NOW - 120_000, "pending");
    expect(sanitizeHistory([fresh, stale], NOW).map(row => row.state)).toEqual(["pending", "unconfirmed"]);
  });
  test("malformed rows are dropped and unknown states become unconfirmed", () => {
    const rows = sanitizeHistory([{ nope: 1 }, { ...entry("out", "A", NOW), state: "done" }, "x", entry("in", "B", NOW)], NOW);
    expect(rows.map(row => [row.channel, row.state])).toEqual([["A", "unconfirmed"], ["B", "received"]]);
    expect(sanitizeHistory("nope", NOW)).toEqual([]);
    expect(sanitizeHistory(Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) => entry("in", `C${i}`, NOW - i)), NOW)).toHaveLength(HISTORY_LIMIT);
  });
  test("only the newest raid out, still inside Twitch's countdown, can be pending", () => {
    expect(livePendingRaid([entry("out", "A", NOW - 1000)], NOW)).toMatchObject({ channel: "A" });
    expect(livePendingRaid([entry("out", "A", NOW - RAID_WINDOW_MS - 1)], NOW)).toBeNull();
    expect(livePendingRaid([entry("out", "A", NOW - 5, "unconfirmed")], NOW)).toMatchObject({ state: "unconfirmed" });
    expect(livePendingRaid([entry("out", "A", NOW - 5, "canceled")], NOW)).toBeNull();
    expect(livePendingRaid([entry("in", "A", NOW)], NOW)).toBeNull();
  });
});

describe("switch and refusals", () => {
  test("the streamer's switch starts off and only accepts on or off", () => {
    expect(raidSettings(undefined)).toEqual({ enabled: false });
    expect(raidSettings({ enabled: true }, true)).toEqual({ enabled: true });
    for (const bad of [{}, { enabled: "yes" }, { enabled: true, extra: 1 }, null]) expect(() => raidSettings(bad, true)).toThrow(expect.objectContaining({ code: "invalid_raid_settings", status: 400 }));
  });
  test.each([
    [401, "reconnect_required"], [403, "reconnect_required"], [429, "provider_rate_limited"], [409, "raid_already_queued"],
    [404, "raid_target_unknown"], [400, "raid_refused"], [500, "provider_unavailable"],
  ])("Twitch %i is reported as %s", (status, code) => {
    expect(raidFailureError({ status })).toMatchObject({ code });
  });
});
