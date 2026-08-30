import { describe, expect, it } from "vitest";
import { isSharedReplayDetailPath } from "./replayRouteAccess";

describe("shared replay middleware boundary", () => {
  it.each([
    "/players/reaver-7a6b5c4d3e/replays",
    "/players/reaver-7a6b5c4d3e/replays/",
    "/players/reaver-7a6b5c4d3e/replays/opengraph-image",
    "/p/legacy-share-id/replays",
    "/p/legacy-share-id/replays/",
    "/p/legacy-share-id/replays/opengraph-image",
  ])("keeps replay-list surface public at %s", (pathname) => {
    expect(isSharedReplayDetailPath(pathname)).toBe(false);
  });

  it.each([
    "/players/reaver-7a6b5c4d3e/replays/game-42",
    "/players/reaver-7a6b5c4d3e/replays/game%2F42",
    "/players/reaver-7a6b5c4d3e/replays/game.with.dots",
    "/players/reaver-7a6b5c4d3e/replays/game-42/",
    "/p/legacy-share-id/replays/game-42",
  ])("requires sign-in for replay detail at %s", (pathname) => {
    expect(isSharedReplayDetailPath(pathname)).toBe(true);
  });
});
