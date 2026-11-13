import { describe, expect, it } from "vitest";
import { isRoomObsPath } from "@/lib/matchRoomRoute";
import { matchRoomObsPath, parseMatchRoomObsInvite, type Room } from "@/lib/matchRoom";
import { obsMapLabel, roomObsState } from "@/lib/matchRoomObs";

const id = "abcdefghijklmnopqrstuvwx12345678";
const titles = ["Alcyone LE"];

const veto: Room = {
  config: { format: 1, preset: "standard", maps: ["Alcyone LE", "Secret Player Alias"], practice: false },
  rev: 1, expiresAt: 100_000, serverTime: 1_000, phase: "veto",
  names: { a: "Private player", b: "Private opponent" }, ready: { a: true, b: true }, score: { a: 0, b: 0 },
  first: "a", turn: { seat: "b", kind: "ban" }, deadline: 31_000,
  moves: [{ seat: "a", kind: "pick", map: 1, automatic: true }], order: [], winners: [],
  replay: { replayScoring: true, reports: [{ confirmed: true, submittedBy: "a" }], undoBy: "b" },
};

describe("Match Room Browser Source links", () => {
  it("contains only the watch locator and puts the optional credit parameter before it", () => {
    expect(matchRoomObsPath(id, true)).toBe("/overlay/match-room#r=" + id);
    expect(matchRoomObsPath(id, false)).toBe("/overlay/match-room?credit=0#r=" + id);
    expect(parseMatchRoomObsInvite("#r=" + id)).toEqual({ id, role: "watch" });
  });

  it.each(["", "#r=short", "#r=" + id + "&seat=host&key=secret", "#r=" + id + "&seat=a&key=secret",
    "#r=" + id + "&r=" + id, "#r=" + id + "#ignored", "#r=" + id + "&key=", "#r=" + id + "\n"])(
    "rejects any fragment besides the watch locator (%s)", fragment => {
      expect(parseMatchRoomObsInvite(fragment)).toBeNull();
    },
  );

  it.each(["/overlay/match-room", "/overlay/%6datch-room/", "/%6Fverlay/match%2Droom"])(
    "matches the private source route %s", path => expect(isRoomObsPath(path)).toBe(true),
  );

  it.each(["/overlay/match-room-extra", "/overlay/match-room/other", "/overlay%2Fmatch-room", "/overlay/%ab"])(
    "keeps the route exemption narrowly scoped (%s)", path => expect(isRoomObsPath(path)).toBe(false),
  );
});

describe("neutral OBS room model", () => {
  it("projects only public catalog labels, neutral seats and veto decisions", () => {
    expect(roomObsState(veto, titles)).toEqual({
      phase: "veto", bestOf: 1, readyCount: 2, score: { a: 0, b: 0 },
      turn: { seat: "b", kind: "ban" }, nextMap: null,
      maps: [{ label: "Alcyone LE", move: undefined }, { label: "Map 2", move: { seat: "a", kind: "pick" } }],
    });
    expect(obsMapLabel(" Alcyone LE", 2, titles)).toBe("Map 3");
    expect(obsMapLabel("Alcyone LE - Secret", 3, titles)).toBe("Map 4");
  });

  it("displays the safe next map during play and removes it once the series completes", () => {
    const playing = { ...veto, phase: "play", order: [1], turn: null } satisfies Room;
    expect(roomObsState(playing, titles)).toMatchObject({ maps: [], nextMap: "Map 2" });
    expect(roomObsState({ ...playing, phase: "complete", winners: ["a"], score: { a: 1, b: 0 } }, titles))
      .toMatchObject({ maps: [], nextMap: null, score: { a: 1, b: 0 } });
  });
});
