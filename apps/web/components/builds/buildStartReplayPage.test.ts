import { describe, expect, it } from "vitest";
import { readBuildStartReplayPage } from "./buildStartReplayPage";
describe("build picker response boundary", () => {
  it.each([null, {}, { items: "old format" }, { items: [], page: { hasMore: true, nextCursor: null } },
    { items: [{ gameId: "x".repeat(257) }], page: { hasMore: false, nextCursor: null } },
    { items: [{ gameId: "same" }, { gameId: "same" }], page: { hasMore: false, nextCursor: null } },
    { items: [], page: { hasMore: true, nextCursor: "x".repeat(2049) } },
  ])("rejects a malformed/oversized page with a recoverable message", value => {
    expect(() => readBuildStartReplayPage(value)).toThrow("unexpected response");
  });
  it("projects only renderable display strings and valid dates", () => {
    expect(readBuildStartReplayPage({ items: [{ gameId: "native-game", map: { stale: true }, result: "win", date: "not a date", opponent: { displayName: ["invalid"] }, privateExtra: "omitted" }], page: { hasMore: false, nextCursor: null } }).items)
      .toEqual([{ gameId: "native-game", map: null, result: "win", date: null, myBuild: null, opponent: { displayName: null } }]);
  });
});
