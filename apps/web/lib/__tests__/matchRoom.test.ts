import { describe, expect, it } from "vitest";
import { deriveSeatKey, invitePath, matchResultCard, parseRoom, parseRoomInvite, pollDelay, resultText, type Room } from "../matchRoom";

const ID = "abcdefghijklmnopqrstuvwx12345678";
const KEY = "b".repeat(32);
const room: Room = {
  config: { format: 3, preset: "standard", maps: ["Private map", "Other", "Decider"], practice: false },
  rev: 5, expiresAt: 20_000, serverTime: 10_000, phase: "complete", names: { a: "Private Blue", b: "Private Red" },
  ready: { a: true, b: true }, score: { a: 2, b: 1 }, first: "a", turn: null, deadline: null,
  moves: [], order: [0, 1, 2], winners: ["a", "b", "a"],
};

describe("Match Room links", () => {
  it("keeps capability material exclusively in the fragment", async () => {
    const key = await deriveSeatKey(KEY, "a");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toBe(await deriveSeatKey(KEY, "b"));
    const seat = { id: ID, role: "a", key } as const;
    const url = new URL(invitePath(seat), "https://sc2tools.com");
    expect(url.pathname + url.search).toBe("/match/room");
    expect(parseRoomInvite(url.hash)).toEqual(seat);
    expect(parseRoomInvite("#r=" + ID)).toEqual({ id: ID, role: "watch" });
    expect(parseRoomInvite("#r=" + ID + "&seat=host")).toBeNull();
    expect(parseRoomInvite("#r=bad")).toBeNull();
  });

  it("adapts polling to the veto and tab visibility", () => {
    expect(pollDelay("veto", false)).toBe(2000);
    expect(pollDelay("play", false)).toBe(10000);
    expect(pollDelay("veto", true)).toBe(30000);
    expect(pollDelay("complete", false)).toBe(30000);
  });

  it("checks the DTO and excludes server-only and unexpected values", () => {
    expect(parseRoom({ ...room, seed: "internal" })).toEqual(room);
    expect(parseRoom({ ...room, order: [0, 9, 2] })).toBeNull();
    expect(parseRoom({ ...room, phase: "veto", turn: null })).toBeNull();
    expect(parseRoom({ ...room, rev: "5" })).toBeNull();
  });

  it("leaves names, typed map labels and room links out of both public exports", () => {
    const discord = resultText(room, "discord");
    expect(discord).toContain("**StarCraft II best of 3**");
    expect(resultText(room, "reddit")).toContain("### StarCraft II best of 3");
    expect(discord).toContain("Game 2 · Seat B");
    expect(discord).toContain("Seat A 2–1 Seat B");
    expect(discord + JSON.stringify(matchResultCard(room))).not.toMatch(/Private|\/match\/room|#r=/);
    expect(matchResultCard(room)).toMatchObject({ path: "/match", stats: [{ label: "Seat A", value: "2" }, { label: "Seat B", value: "1" }] });
  });
});
