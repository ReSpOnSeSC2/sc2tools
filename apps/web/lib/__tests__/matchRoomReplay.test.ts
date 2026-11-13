import { describe, expect, it } from "vitest";
import type { PlayersResult } from "../instant/types";
import { parseRoom } from "../matchRoom";
import { prepareMatchReplay, replayAction } from "../matchRoomReplay";

type Header = Extract<PlayersResult, { ok: true }>;
const header: Header = {
  ok: true, date: "2026-11-12T13:14:15Z", map: "Café & Dawn Ladder Edition", durationSec: 235,
  matchFormat: "1v1", playerCount: 2, isAiGame: false, toonFromPath: null,
  players: [
    { name: "Fixture Blue", toon: "1-S2-1-7", race: "Protoss", result: "Win", pid: 1 },
    { name: "Fixture Red", toon: "1-S2-1-8", race: "Zerg", result: "Loss", pid: 2 },
  ],
};

describe("match-room replay reports", () => {
  it("produces the same allow-listed receipt from reversed player order and alternate map suffixes", async () => {
    const a = await prepareMatchReplay(header, "room-a");
    const b = await prepareMatchReplay({ ...header, map: "Cafe and Dawn LE", players: header.players.toReversed() }, "room-a");
    expect(JSON.stringify(a)).not.toMatch(/Fixture|S2|name/);
    const payload = await replayAction(a, "a", "Win");
    expect(payload).toEqual(await replayAction(b, "b", "Loss"));
    expect(payload).toEqual({
      type: "report_replay", mapKey: "cafeanddawn", winnerSeat: "a", durationSec: 235,
      endedAt: Date.parse(header.date ?? ""), receipt: expect.stringMatching(/^[a-f0-9]{64}$/),
      toonDigests: { a: expect.stringMatching(/^[a-f0-9]{64}$/), b: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(JSON.stringify(payload)).not.toMatch(/Fixture|S2|room-a|name/);
  });

  it("scopes both player digests and the receipt to each room", async () => {
    const first = await replayAction(await prepareMatchReplay(header, "room-a"), "a", "Win");
    const second = await replayAction(await prepareMatchReplay(header, "room-b"), "a", "Win");
    expect(second.toonDigests.a).not.toBe(first.toonDigests.a);
    expect(second.toonDigests.b).not.toBe(first.toonDigests.b);
    expect(second.receipt).not.toBe(first.receipt);
  });

  it.each<Partial<Header>>([
    { isAiGame: true }, { matchFormat: "team" }, { playerCount: 3 }, { players: [header.players[0]] },
    { players: [header.players[0], { ...header.players[1], result: "Tie" }] },
    { players: [header.players[0], { ...header.players[1], pid: 1 }] },
    { players: [header.players[0], { ...header.players[1], toon: null }] },
    { players: [header.players[0], { ...header.players[1], toon: "1-s2-1-7" }] },
    { date: null }, { date: "2026-11-12T13:14:15" }, { map: null }, { durationSec: 0 },
  ])("rejects unsupported replay data %# before creating an action", async (invalid) => {
    await expect(prepareMatchReplay({ ...header, ...invalid }, "room-a")).rejects.toThrow();
  });

  it("allow-lists report status and keeps private replay metadata out of the parsed room", () => {
    const data = {
      config: { format: 1, preset: "standard", maps: ["Alpha"], practice: false },
      rev: 3, expiresAt: 10_000, serverTime: 100, phase: "complete",
      names: { a: "", b: "" }, ready: { a: true, b: true }, score: { a: 1, b: 0 },
      first: "a", turn: null, deadline: null, moves: [], order: [0], winners: ["a"],
      replayScoring: true, undoBy: "b", replaySeats: { a: "private", b: "private" },
      reports: [{ submittedBy: "b", confirmed: true, receipt: "private", endedAt: 100 }],
    };
    const room = parseRoom(data);
    expect(room?.replay).toEqual({ replayScoring: true, undoBy: "b", reports: [{ submittedBy: "b", confirmed: true }] });
    expect(JSON.stringify(room)).not.toMatch(/private|receipt|endedAt/);
  });
});
