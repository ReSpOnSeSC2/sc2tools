import { describe, expect, it } from "vitest";
import {
  TOON_HANDLE_RE,
  isMultiplayerReplayPath,
  pathSegments,
  toonFromPath,
} from "../toonPath";

describe("toonFromPath", () => {
  it("returns the toon folder from a forward-slash relative path", () => {
    expect(toonFromPath("Accounts/123/1-S2-1-267727/Replays/Multiplayer/a.SC2Replay")).toBe(
      "1-S2-1-267727",
    );
  });

  it("splits on backslashes like Windows Path.parts", () => {
    expect(toonFromPath("C:\\Users\\me\\Accounts\\9\\2-S2-1-42\\Replays\\Multiplayer\\x.SC2Replay")).toBe(
      "2-S2-1-42",
    );
  });

  it("returns the FIRST matching segment (root to leaf)", () => {
    expect(toonFromPath("1-S2-1-5/2-S2-1-6/a.SC2Replay")).toBe("1-S2-1-5");
  });

  it("returns null without a toon segment", () => {
    expect(toonFromPath("Downloads/Tourmaline LE.SC2Replay")).toBeNull();
    expect(toonFromPath("")).toBeNull();
  });

  it("is case-sensitive on S2 and anchored on the whole segment", () => {
    expect(toonFromPath("1-s2-1-5/a.SC2Replay")).toBeNull();
    expect(toonFromPath("x1-S2-1-5/a.SC2Replay")).toBeNull();
    expect(toonFromPath("1-S2-1-5x/a.SC2Replay")).toBeNull();
    expect(TOON_HANDLE_RE.test("98-S2-3-1234567")).toBe(true);
  });

  it("matches exactly what the agent's Python regex matches", () => {
    // Expected values produced by Python 3 `re.compile(r"^\d+-S2-\d+-\d+$").match(s)`:
    // `\d` is any Unicode Nd digit and `$` also matches before one final "\n".
    const pythonTruth: Array<[string, boolean]> = [
      ["1-S2-1-267727", true],
      ["1-S2-1-267727\n", true],
      ["١-S2-١-٥", true],
      ["１-S2-1-5", true],
      ["1-s2-1-5", false],
      [" 1-S2-1-5", false],
      ["1-S2-1-5 ", false],
      ["1-S2-1-5\n\n", false],
      ["1-S2-1-5\r", false],
    ];
    for (const [segment, matches] of pythonTruth) {
      expect([segment, TOON_HANDLE_RE.test(segment)]).toEqual([segment, matches]);
    }
    // First toon-shaped segment wins even when it cannot match a player.
    expect(toonFromPath("١-S2-١-٥/1-S2-1-5/a.SC2Replay")).toBe("١-S2-١-٥");
  });
});

describe("pathSegments", () => {
  it("drops empty segments from mixed separators", () => {
    expect(pathSegments("a\\b//c.SC2Replay")).toEqual(["a", "b", "c.SC2Replay"]);
  });
});

describe("isMultiplayerReplayPath", () => {
  it("accepts <toon>/Replays/Multiplayer/*.SC2Replay in any case", () => {
    expect(isMultiplayerReplayPath("1-S2-1-5/Replays/Multiplayer/a.SC2Replay")).toBe(true);
    expect(isMultiplayerReplayPath("1-S2-1-5/replays/MULTIPLAYER/a.sc2replay")).toBe(true);
    expect(isMultiplayerReplayPath("Replays\\Multiplayer\\a.SC2Replay")).toBe(true);
  });

  it("accepts the Multiplayer folder picked as the root", () => {
    expect(isMultiplayerReplayPath("Multiplayer/a.SC2Replay")).toBe(true);
  });

  it("rejects other replay folders, other files and loose replays", () => {
    expect(isMultiplayerReplayPath("1-S2-1-5/Replays/VersusAI/a.SC2Replay")).toBe(false);
    expect(isMultiplayerReplayPath("Foo/Multiplayer/a.SC2Replay")).toBe(false);
    expect(isMultiplayerReplayPath("1-S2-1-5/Replays/Multiplayer/a.txt")).toBe(false);
    expect(isMultiplayerReplayPath("a.SC2Replay")).toBe(false);
  });
});
