import { describe, expect, it } from "vitest";
import { PENDING_LABELS, PENDING_TEXT, raidResultMessage, readRaidResult, readRaidSettings, readRaidView } from "../twitchRaids";

const stream = (extra: Record<string, unknown> = {}) => ({
  id: "twitch:1", platform: "twitch", channel: "Chan1", title: "Ladder", language: "en", viewers: 4, startedAt: "2026-11-28T10:00:00Z",
  url: "https://www.twitch.tv/chan1", relation: null, small: true, raidable: true, ...extra,
});
const view = (extra: Record<string, unknown> = {}) => ({
  reason: null, platforms: { twitch: "ok", kick: "off" }, candidates: [stream()], pending: null, history: [], ...extra,
});

describe("readRaidView", () => {
  it("reads the ranked channels with their raid fields", () => {
    const read = readRaidView(view({ candidates: [stream({ relation: "raided_by" }), stream({ id: "kick:2", platform: "kick", url: "https://kick.com/k", raidable: false })] }));
    expect(read?.candidates.map(row => [row.id, row.relation, row.raidable])).toEqual([["twitch:1", "raided_by", true], ["kick:2", null, false]]);
  });
  it("drops a channel whose link is not the platform's own page, and rows of the wrong shape", () => {
    const read = readRaidView(view({ candidates: [stream({ url: "https://evil.example/x" }), "nope", stream({ id: "twitch:3" })] }));
    expect(read?.candidates.map(row => row.id)).toEqual(["twitch:3"]);
  });
  it("keeps only a known blocker and a known platform state", () => {
    expect(readRaidView(view({ reason: "switch_off" }))?.reason).toBe("switch_off");
    expect(readRaidView(view({ reason: "anything else" }))?.reason).toBeNull();
    expect(readRaidView(view({ platforms: { twitch: "weird", kick: "stale" } }))?.platforms).toEqual({ twitch: "off", kick: "stale" });
  });
  it("reads the pending raid and the history, dropping broken rows", () => {
    const read = readRaidView(view({
      pending: { id: "a", channel: "Chan1", at: 5, state: "unconfirmed" },
      history: [{ id: "a", dir: "out", channel: "Chan1", viewers: 4, state: "queued", at: 5 }, { id: "b", dir: "in", channel: "Raider", viewers: 12, state: "received", at: 6 },
        { id: "c", dir: "out", channel: "X", state: "teleported", at: 7 }, { id: "d" }],
    }));
    expect(read?.pending).toEqual({ id: "a", channel: "Chan1", at: 5, state: "unconfirmed" });
    expect(readRaidView(view({ pending: { id: "a", channel: "Chan1", at: 5, state: "canceled" } }))?.pending).toBeNull();
    expect(read?.history.map(row => [row.id, row.dir, row.state])).toEqual([["a", "out", "queued"], ["b", "in", "received"]]);
  });
  it("refuses an answer that is not an object with platforms", () => {
    expect(readRaidView(null)).toBeNull();
    expect(readRaidView({ candidates: [] })).toBeNull();
  });
});

describe("settings and result", () => {
  it("reads the settings and treats anything but true as off", () => {
    expect(readRaidSettings({ serverEnabled: true, enabled: "yes", connected: true, permission: true, reason: null }))
      .toEqual({ serverEnabled: true, enabled: false, connected: true, permission: true, reason: null });
    expect(readRaidSettings("x")).toBeNull();
  });
  it("a queued raid has no line of its own (its banner says queued), and a cancel is confirmed by Twitch", () => {
    const queued = readRaidResult({ result: { state: "queued", channel: "Chan1" } });
    expect(raidResultMessage(queued!)).toBe("");
    expect(PENDING_TEXT.queued).toMatch(/90 seconds.*unless you cancel/);
    expect(`${PENDING_LABELS.queued} ${PENDING_TEXT.queued}`).not.toMatch(/\bsent\b|\bdone\b/);
    expect(raidResultMessage({ state: "canceled", channel: "" })).toBe("Raid cancelled. Twitch confirmed it.");
    expect(readRaidResult({ result: { state: "done", channel: "x" } })).toBeNull();
    expect(readRaidResult({})).toBeNull();
  });
});
