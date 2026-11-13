// @ts-nocheck
"use strict";

const { roomConfig, initialRoom, advanceExpiredTurns, reduceMatchRoom, roomSnapshot } =
  require("../src/services/matchRoomModel");

const maps = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India"];
const config = (format, preset = "standard", practice = false) => roomConfig({ format, preset, maps, practice });
const act = (room, seat, type, data = {}, time = 1_000) => reduceMatchRoom(room, seat, { type, ...data }, time);
const ready = room => act(act(room, "a", "ready", { value: true }), "b", "ready", { value: true });

test.each([1, 3, 5, 7].flatMap(format => ["standard", "pick-first", "ban-only"].map(preset => [format, preset])))(
  "best-of-%i %s produces an alternating legal veto and exactly one series schedule",
  (format, preset) => {
    const lobby = initialRoom(config(format, preset), "seed");
    let room = ready(lobby);
    const expectedFirst = preset === "pick-first" && format > 1 ? "pick" : "ban";
    expect(room.steps[0]).toEqual({ seat: room.first, kind: expectedFirst });
    const bans = [];
    while (room.phase === "veto") {
      const step = room.steps[room.moves.length];
      const map = room.moves.length;
      if (step.kind === "ban") bans.push(map);
      if (room.moves.length) expect(step.seat).not.toBe(room.moves.at(-1).seat);
      room = act(room, step.seat, "veto", { map });
    }
    expect(bans).toHaveLength(maps.length - format);
    expect(new Set(room.order).size).toBe(format);
    expect(room.order.some(map => bans.includes(map))).toBe(false);
    expect(room.deadline).toBeNull();
    expect(lobby.phase).toBe("lobby");
    expect(lobby.moves).toEqual([]);
  },
);

test("opens a one-map room directly after both seats are ready", () => {
  const room = ready(initialRoom(roomConfig({ format: 1, preset: "standard", maps: ["Alpha"], practice: false }), "seed"));
  expect(room).toMatchObject({ phase: "play", order: [0], deadline: null });
});

test("expires at exactly the deadline, catches up across several absent turns and is deterministic", () => {
  const start = ready(initialRoom(config(3), "seed"));
  expect(start.deadline).toBe(31_000);
  expect(advanceExpiredTurns(start, 30_999)).toBe(start);
  const one = advanceExpiredTurns(start, 31_000);
  expect(one.moves).toMatchObject([{ automatic: true }]);
  expect(one.deadline).toBe(61_000);
  expect(advanceExpiredTurns(one, 91_000)).toEqual(advanceExpiredTurns(start, 91_000));
  expect(advanceExpiredTurns(start, 999_000)).toMatchObject({ phase: "play", deadline: null });
});

test("fences turns, duplicate maps and watch or host impersonation", () => {
  const start = ready(initialRoom(config(3), "seed"));
  expect(() => act(start, start.first === "a" ? "b" : "a", "veto", { map: 0 })).toThrow("turn_changed");
  expect(() => act(start, "watch", "veto", { map: 0 })).toThrow("seat_required");
  expect(() => act(start, "host", "veto", { map: 0, as: start.first })).toThrow("seat_required");
  const moved = act(start, start.first, "veto", { map: 0 });
  expect(() => act(moved, moved.steps[1].seat, "veto", { map: 0 })).toThrow("invalid_map");
  const practice = ready(initialRoom(config(3, "standard", true), "seed"));
  expect(act(practice, "host", "veto", { map: 0, as: practice.first }).moves).toHaveLength(1);
});

test("sanitizes labels and only the corresponding seat can rename itself", () => {
  const room = initialRoom(config(3), "seed");
  expect(act(room, "a", "name", { value: " Blue\t https://x.test ", as: "b" }).names)
    .toEqual({ a: "Blue", b: "" });
  expect(() => act(room, "b", "name", { value: "<script>" })).toThrow("invalid_seat_name");
  expect(() => act(room, "b", "name", { value: "a".repeat(25) })).toThrow("invalid_seat_name");
  expect(() => roomConfig({ ...room.config, maps: ["Same", "same", "Other"] })).toThrow("invalid_map");
  expect(() => roomConfig({ ...room.config, maps: ["Alpha"] })).toThrow("invalid_room");
});

test("scores only after veto and stops at the majority, with host and two-seat undo", () => {
  const lobby = initialRoom(config(3), "seed");
  expect(() => act(lobby, "host", "score", { winner: "a" })).toThrow("score_changed");
  const open = advanceExpiredTurns(ready(lobby), 999_000);
  const complete = act(act(open, "host", "score", { winner: "b" }), "a", "score", { winner: "b" });
  expect(complete.phase).toBe("complete");
  expect(() => act(complete, "b", "score", { winner: "b" })).toThrow("score_changed");
  const proposed = act(complete, "b", "undo");
  expect(proposed).toMatchObject({ phase: "complete", undoBy: "b", winners: ["b", "b"] });
  expect(act(proposed, "b", "undo")).toBe(proposed);
  expect(act(proposed, "a", "undo")).toMatchObject({ phase: "play", undoBy: null, winners: ["b"] });
  expect(act(complete, "host", "undo")).toMatchObject({ phase: "play", winners: ["b"] });
  const snapshot = roomSnapshot(complete, 8, new Date(3000), 2000);
  expect(snapshot).toMatchObject({ rev: 8, score: { a: 0, b: 2 }, expiresAt: 3000, serverTime: 2000 });
  expect(snapshot).not.toHaveProperty("seed");
  expect(snapshot).not.toHaveProperty("steps");
});
