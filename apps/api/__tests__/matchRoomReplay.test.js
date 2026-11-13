// @ts-nocheck
"use strict";

const { initialRoom, roomConfig, advanceExpiredTurns, reduceMatchRoom, roomSnapshot } =
  require("../src/services/matchRoomModel");
const { replayMapKey, replayReceipt } = require("../src/services/matchRoomReplayInput");

const TOONS = { a: "1".repeat(64), b: "2".repeat(64) };
const START = 100_000;
const END = START + 180_000;
const NOW = END + 500;
const MAPS = ["Sanctuary III [LE]", "Café & Dawn Ladder Edition", "Omega"];

const act = (room, role, action, now = NOW) => reduceMatchRoom(room, role, action, now);
const ready = (room, seat) => act(room, seat, { type: "ready", value: true }, START);

function openRoom(maps = MAPS, format = 3, practice = false) {
  const lobby = initialRoom(roomConfig({ format, preset: "ban-only", maps, practice }), "test");
  return ready(ready(lobby, "a"), "b");
}

function report(room, overrides = {}) {
  const map = room.order[room.winners.length];
  const data = { mapKey: replayMapKey(room.config.maps[map]), winnerSeat: "a", durationSec: 155,
    endedAt: END, toonDigests: TOONS, ...overrides };
  const receipt = replayReceipt(data.mapKey, data.endedAt, data.durationSec, data.toonDigests);
  return { type: "report_replay", ...data, receipt };
}

function snapshot(room) {
  return roomSnapshot(room, 7, new Date(NOW + 1000), NOW);
}

test("the same replay confirms independently after a series ends and idempotently across seat retries", () => {
  const room = openRoom(["Sanctuary III [LE]"], 1);
  const result = report(room, { mapKey: "sanctuaryiii" });
  const reported = act(room, "b", result);
  expect(reported).toMatchObject({ phase: "complete", winners: ["a"], replaySeats: TOONS });
  expect(snapshot(reported).reports).toEqual([{ submittedBy: "b", confirmed: false }]);
  expect(act(reported, "b", result)).toBe(reported);
  const confirmed = act(reported, "a", result);
  expect(snapshot(confirmed).reports).toEqual([{ submittedBy: "b", confirmed: true }]);
  expect(snapshot(confirmed).score).toEqual({ a: 1, b: 0 });
  expect(act(confirmed, "a", result)).toBe(confirmed);
  expect(JSON.stringify(snapshot(confirmed))).not.toContain(result.receipt);
  expect(JSON.stringify(snapshot(confirmed))).not.toContain(TOONS.a);
  expect(snapshot(confirmed)).not.toHaveProperty("vetoCompletedAt");
});

test("a different winner, swapped pair or reused receipt with changed metadata cannot confirm", () => {
  const room = openRoom();
  const result = report(room);
  const reported = act(room, "a", result);
  expect(() => act(reported, "b", { ...result, winnerSeat: "b" })).toThrow("replay_result_conflict");
  expect(() => act(reported, "b", { ...result, toonDigests: { a: TOONS.b, b: TOONS.a } })).toThrow("replay_seats_changed");
  expect(() => act(reported, "b", { ...result, endedAt: END + 1 })).toThrow("invalid_match_replay");
  expect(() => act(reported, "b", { ...result, durationSec: 156 })).toThrow("invalid_match_replay");
  expect(() => act(reported, "b", { ...result, mapKey: "somethingelse" })).toThrow("invalid_match_replay");
  expect(snapshot(reported).reports).toEqual([{ submittedBy: "a", confirmed: false }]);
});

test("the other seat can confirm an earlier replay after a later game has been scored", () => {
  const room = openRoom();
  const firstReplay = report(room);
  const first = act(room, "a", firstReplay);
  const second = act(first, "a", report(first, { winnerSeat: "b", endedAt: END + 1 }));
  const confirmed = act(second, "b", firstReplay);
  expect(snapshot(confirmed)).toMatchObject({ winners: ["a", "b"],
    reports: [{ submittedBy: "a", confirmed: true }, { submittedBy: "a", confirmed: false }] });
});

test("only the next map is playable with a later end time and matching seat digests", () => {
  const room = openRoom();
  expect(() => act(room, "a", report(room, { mapKey: "sanctuaryii" }))).toThrow("replay_map_mismatch");
  expect(() => act(room, "a", report(room, { endedAt: START }))).toThrow("replay_time_mismatch");
  expect(() => act(room, "a", report(room, { endedAt: NOW + 60_001 }))).toThrow("replay_time_mismatch");
  const first = act(room, "a", report(room));
  expect(() => act(first, "b", report(first, { mapKey: report(room).mapKey, endedAt: END + 1 }))).toThrow("replay_map_mismatch");
  expect(() => act(first, "b", report(first))).toThrow("replay_time_mismatch");
  expect(() => act(first, "b", report(first, { toonDigests: { ...TOONS, b: "3".repeat(64) } }))).toThrow("replay_seats_changed");
  const second = act(first, "b", report(first, { winnerSeat: "b", endedAt: END + 1 }));
  expect(snapshot(second).score).toEqual({ a: 1, b: 1 });
});

test("mixed manual scoring checks the prior result and clears old undo requests", () => {
  const room = openRoom();
  const manual = act(room, "host", { type: "score", winner: "a" });
  const undoAsked = act(manual, "a", { type: "undo" });
  expect(() => act(undoAsked, "a", report(undoAsked))).toThrow("replay_time_mismatch");
  const next = act(undoAsked, "a", report(undoAsked, { endedAt: NOW + 1 }));
  expect(snapshot(next)).toMatchObject({ undoBy: null, reports: [null, { submittedBy: "a", confirmed: false }] });
});

test("old, ambiguous-map and practice rooms remain usable for manual scoring", () => {
  const old = openRoom();
  delete old.vetoCompletedAt;
  const rooms = [old, openRoom(["Sanctuary III LE", "Sanctuary III", "Omega"]), openRoom(MAPS, 3, true)];
  for (const room of rooms) {
    expect(snapshot(room).replayScoring).toBe(false);
    expect(() => act(room, "a", report(room))).toThrow("replay_scoring_unavailable");
    expect(act(room, "a", { type: "score", winner: "b" }).winners).toEqual(["b"]);
  }
});

test("veto auto-pick uses the logical last deadline instead of the first later poll", () => {
  const lobby = initialRoom(roomConfig({ format: 1, preset: "ban-only", maps: ["One", "Two"], practice: false }), "test");
  const veto = ready(ready(lobby, "a"), "b");
  const completed = advanceExpiredTurns(veto, NOW);
  expect(completed.vetoCompletedAt).toBe(START + 30_000);
  expect(act(completed, "a", report(completed)).phase).toBe("complete");
});

test("two-seat or host undo prevents the same replay from putting a win back", () => {
  const room = openRoom();
  const result = report(room);
  const reported = act(room, "b", result);
  for (const undone of [
    act(reported, "host", { type: "undo" }),
    act(act(reported, "a", { type: "undo" }), "b", { type: "undo" }),
  ]) {
    expect(undone.winners).toEqual([]);
    expect(undone.replaySeats).toBeUndefined();
    expect(() => act(undone, "a", result)).toThrow("replay_time_mismatch");
    expect(act(undone, "a", report(undone, { endedAt: END + 1 })).winners).toEqual(["a"]);
  }
});

test("report actions allow only neutral fields and genuine seat credentials", () => {
  const room = openRoom();
  const result = report(room);
  expect(() => act(room, "a", { ...result, fileName: "my replay" })).toThrow("invalid_match_replay");
  expect(() => act(room, "a", { ...result, toonDigests: { ...TOONS, rawToon: "value" } })).toThrow("invalid_match_replay");
  expect(() => act(room, "a", { ...result, durationSec: -1 })).toThrow("invalid_match_replay");
  expect(() => act(room, "host", result)).toThrow("seat_required");
  expect(() => act(room, "watch", result)).toThrow("seat_required");
});
