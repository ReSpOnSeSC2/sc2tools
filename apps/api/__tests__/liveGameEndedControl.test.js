// @ts-nocheck
"use strict";
const { withEndedGameControl, ENDED_CONTROL_MS } = require("../src/services/liveGameEndedControl");
const { LiveGameBroker } = require("../src/services/liveGameBroker");
const NOW = 1_700_000_000_000;
const ended = { type: "liveGameState", phase: "match_ended", gameKey: "one", opponent: { name: "Private opponent" } };
test("menu keeps only a cloud-observed bounded key and replays it without retaining opponent fields", () => {
  const broker = new LiveGameBroker();
  broker.publish("owner", { ...ended, capturedAt: 1 });
  broker.publish("owner", { type: "liveGameState", phase: "menu", capturedAt: 2 });
  const live = broker.latest("owner");
  expect(live.opponent).toBeUndefined(); expect(live.lastEndedGame).toEqual({ gameKey: "one", endedAt: expect.any(Number) });
  expect(broker.replayLatestForOverlay("owner").envelope.lastEndedGame.gameKey).toBe("one");
  expect(broker.currentGameKey("owner")).toBeNull();
  broker.publish("owner", { type: "liveGameState", phase: "match_loading", gameKey: "two", capturedAt: 3 });
  expect(broker.latest("owner").lastEndedGame).toBeUndefined(); broker.clear();
});
test("forged, replay and keyless ended frames cannot create an eligible control", () => {
  expect(withEndedGameControl({ phase: "menu", lastEndedGame: { gameKey: "forged", endedAt: NOW } }, undefined, NOW).lastEndedGame).toBeUndefined();
  expect(withEndedGameControl({ ...ended, isReplay: true }, undefined, NOW).lastEndedGame).toBeUndefined();
  expect(withEndedGameControl({ ...ended, gameKey: "" }, undefined, NOW).lastEndedGame).toBeUndefined();
});
test("menu heartbeats and repeated ended ticks cannot extend the window", () => {
  const first = withEndedGameControl(ended, undefined, NOW);
  const repeat = withEndedGameControl(ended, first, NOW + 60_000); expect(repeat.lastEndedGame.endedAt).toBe(NOW);
  const menu = withEndedGameControl({ phase: "menu" }, repeat, NOW + 120_000); expect(menu.lastEndedGame.endedAt).toBe(NOW);
  expect(withEndedGameControl({ phase: "menu" }, menu, NOW + ENDED_CONTROL_MS + 1).lastEndedGame).toBeUndefined();
  const expired = withEndedGameControl(ended, repeat, NOW + ENDED_CONTROL_MS + 1); expect(expired.lastEndedGame.gameKey).toBeUndefined();
  const later = withEndedGameControl(ended, expired, NOW + ENDED_CONTROL_MS + 60_000); expect(later.lastEndedGame).toEqual({ endedAt: NOW });
});
