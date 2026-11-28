import { describe, expect, it } from "vitest";
import type { TapeChunk } from "../tapeSync";
import { IDLE_TICKS, clock, describe as describeEntry, goalTimes, idleSpans, inputTicks, tapeEvents } from "../tapeTimeline";

const chunk = (seq: number, from: number, to: number, extra: Partial<TapeChunk> = {}): TapeChunk =>
  ({ v: 1, seq, build: "19bbccd577ad", seed: 7, admin: false, from, to, inp: [], ev: [], ...extra });

describe("tapeTimeline", () => {
  it("formats ticks as play time", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(14_700)).toBe("4:05");
    expect(clock(60 * 3_725)).toBe("1:02:05");
  });

  it("reads the game's timeline entries and skips the unknown ones", () => {
    expect(describeEntry([10, "map", "humdrum", "Humdrum"])).toEqual({ tick: 10, kind: "map", label: "Entered Humdrum" });
    expect(describeEntry([20, "fight", "Lawn Hydra", 1])?.label).toBe("Boss fight: Lawn Hydra");
    expect(describeEntry([30, "end", "lose", 0])).toEqual({ tick: 30, kind: "lost", label: "Lost the fight" });
    expect(describeEntry([31, "end", "win", 1])?.label).toBe("Won the boss fight");
    expect(describeEntry([40, "lvl", "jay", 3])?.label).toBe("Jay reached level 3");
    expect(describeEntry([50, "save", "auto"])?.label).toBe("Autosaved");
    expect(describeEntry([60, "scene", "gameover"])).toEqual({ tick: 60, kind: "gameover", label: "Game over" });
    expect(describeEntry([61, "scene", "battle"])).toBeNull();
    expect(describeEntry([70, "hint", 2])?.label).toBe("Read a hint: More help");
    expect(describeEntry([80, "quest", "done", "Long Overdue", 1])?.label).toBe("Quest done: Long Overdue");
    expect(describeEntry([90, "goal", ""])).toBeNull();
    expect(describeEntry([95, "mystery"])).toBeNull();
    expect(describeEntry("junk")).toBeNull();
  });

  it("puts every chunk's entries in order", () => {
    const events = tapeEvents([
      chunk(1, 600, 1_200, { ev: [[700, "goal", "Find the humming."], [650, "new"]] }),
      chunk(0, 0, 600, { ev: [[5, "scene", "title"]] }),
    ]);
    expect(events.map((event) => event.tick)).toEqual([5, 650, 700]);
    expect(events[2].label).toBe("New goal: Find the humming.");
  });

  it("finds the input ticks, the idle stretches and the longest goal", () => {
    // chunk 0: flips at 10 (2 slots) and 30 (1 slot); chunk 1 starts at 600: flips at 600 + 5000
    const chunks = [chunk(0, 0, 600, { inp: [10, 2, 0, 4, 20, 1, 4] }), chunk(1, 600, 9_000, { inp: [5_000, 1, 1] })];
    expect(inputTicks(chunks)).toEqual([10, 30, 5_600]);
    expect(idleSpans(chunks, 9_000)).toEqual([{ from: 30, to: 5_600 }]);
    expect(idleSpans(chunks, 9_000).every((span) => span.to - span.from >= IDLE_TICKS)).toBe(true);
    const events = tapeEvents([chunk(0, 0, 9_000, { ev: [[100, "goal", "A"], [400, "goal", "B"], [1_000, "goal", "A"]] })]);
    expect(goalTimes(events, 9_000)).toEqual([{ goal: "A", ticks: 8_300 }, { goal: "B", ticks: 600 }]);
  });
});
