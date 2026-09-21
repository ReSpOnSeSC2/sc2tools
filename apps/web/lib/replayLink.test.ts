import { describe, expect, it } from "vitest";
import { clampReplayTime, gameReplayHref, MAX_REPLAY_LINK_TIME_SEC, replayTimeFromQuery } from "./replayLink";

describe("timestamped replay links", () => {
  it("accepts zero, decimals and the first repeated query value", () => {
    expect(replayTimeFromQuery({ t: "0" })).toBe(0);
    expect(replayTimeFromQuery({ t: " 360.5 " })).toBe(360.5);
    expect(replayTimeFromQuery({ t: ["240", "480"] })).toBe(240);
  });

  it.each([undefined, "", " ", "-1", "Infinity", "NaN", "1e3", "1:20", "123abc", "0x10", "1".repeat(65)])(
    "ignores invalid input %s", (t) => expect(replayTimeFromQuery({ t })).toBeNull(),
  );

  it("bounds oversized numbers and clamps to the actual replay duration", () => {
    expect(replayTimeFromQuery({ t: "99999999999999" })).toBe(MAX_REPLAY_LINK_TIME_SEC);
    expect(clampReplayTime(900, 600)).toBe(600);
    expect(clampReplayTime(0, 600)).toBe(0);
    expect(clampReplayTime(900, 0)).toBe(0);
    expect(clampReplayTime(900, Number.NaN)).toBe(900);
    expect(clampReplayTime(Number.POSITIVE_INFINITY)).toBeNull();
    expect(clampReplayTime(-10)).toBeNull();
  });

  it("encodes game ids and keeps existing opponent-source query parameters", () => {
    expect(gameReplayHref("game/one", 360.5)).toBe("/app/game/game%2Fone?t=360.5");
    expect(gameReplayHref("g1", 240, { pulseId: "1-S2-1-99", displayName: "A & B" }))
      .toBe("/app/game/g1?opponent=1-S2-1-99&opponentName=A+%26+B&t=240");
    expect(gameReplayHref("g1", Number.NaN)).toBe("/app/game/g1");
    expect(gameReplayHref("g1", 0)).toBe("/app/game/g1?t=0");
  });
});
