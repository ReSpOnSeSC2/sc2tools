"use strict";
const { config, sanitizeTwitchAutomation, predictionTitle, markerDescription, eligibility } = require("../src/services/twitchAutomationPolicy");
const live = () => ({ phase: "match_loading", gameKey: "game-1", capturedAt: 1, isReplay: false, players: [{ name: "Me", type: "user" }, { name: "Opp", type: "user" }], user: { name: "Me" }, opponent: { name: "Opp" } });
const source = { source: "device", receivedAt: 1000 };
test("default-off reads strip unknown fields and writes accept bounded explicit preferences", () => {
  expect(sanitizeTwitchAutomation(null)).toEqual(config.defaults);
  expect(sanitizeTwitchAutomation({ predictionsEnabled: "true", markersEnabled: 1, token: "secret" })).toEqual(config.defaults);
  expect(sanitizeTwitchAutomation({ predictionsEnabled: true, markersEnabled: true, windowSec: 300, titleTemplate: "Will {me} beat {opp}?" }, true)).toMatchObject({ predictionsEnabled: true, markersEnabled: true, windowSec: 300 });
});
test.each([null, [], { extra: true }, { predictionsEnabled: 1 }, { markersEnabled: "yes" }, { windowSec: 29 }, { windowSec: 301 }, { windowSec: 30.5 }, { titleTemplate: "" }, { titleTemplate: "<b>win</b>" }, { titleTemplate: "{secret}" }, { titleTemplate: "{opp" }, { titleTemplate: "next\nline" }, { titleTemplate: "x".repeat(141) }])("strict settings reject malformed input %j", raw => {
  expect(() => sanitizeTwitchAutomation(raw, true)).toThrow();
});
test("provider text stays plain, uses missing-data placeholders and Unicode-safe limits", () => {
  expect(predictionTitle(config.defaults.titleTemplate, { me: "Me", opp: "Opp", oppRace: "Zerg", oppMmr: null })).toBe("Will Me beat Opp (Z ?)?");
  const title = predictionTitle("{opp}", { opp: "😀".repeat(60) }); expect(Array.from(title)).toHaveLength(45);
  expect(title.endsWith("…")).toBe(true); expect(title).not.toMatch(/[\uD800-\uDBFF]$/);
  expect(predictionTitle("{me}", { me: "<b>Me</b>\u0000" })).toBe("Me");
  expect(markerDescription({ opp: "Opp", myRace: "Protoss", oppRace: "Z", map: "Map" })).toBe("vs Opp · PvZ · Map");
  expect(Array.from(markerDescription({ opp: "x".repeat(400) }))).toHaveLength(140);
});
test("current live telemetry cannot authorize Predictions from raw ranked/MMR/history claims", () => {
  const envelope = { ...live(), isRanked: true, queue: "LOTV_1V1", mmr: 5000, streamerHistory: { ranked: true } };
  expect(eligibility(envelope, source, 1001)).toEqual({ marker: false, prediction: false, reason: "ranked_status_unavailable" });
  expect(eligibility({ ...envelope, phase: "match_started" }, source, 1001)).toEqual({ marker: true, prediction: false, reason: null });
});
test("only separately validated queue evidence enables loading predictions", () => {
  expect(eligibility(live(), source, 1001, { source: "verified-live-queue", ranked1v1: true }).prediction).toBe(true);
  // @ts-expect-error Deliberately untrusted evidence must also fail at runtime.
  expect(eligibility(live(), source, 1001, { source: "pulse", ranked1v1: true }).prediction).toBe(false);
});
test.each([{ synthetic: true }, { isTest: true }, { isReplay: true }, { isReplay: undefined }, { isObserver: true }, { sourceObserver: true }, { phase: "match_in_progress" }, { players: [{ name: "Me", type: "user" }, { name: "AI", type: "computer" }] }, { players: [...live().players, { name: "Third", type: "user" }] }, { user: { name: "Unknown" } }, { opponent: { name: "Me" } }, { capturedAt: undefined }, { capturedAt: -100 }, { capturedAt: 100 }, { gameKey: "" }])("ignores test/replay/observer/team/unresolved/non-start envelopes %j", patch => {
  const result = eligibility({ ...live(), ...patch }, source, 1001, { source: "verified-live-queue", ranked1v1: true }); expect(result.marker).toBe(false); expect(result.prediction).toBe(false);
});
test("browser-auth diagnostics and old/future loading events never trigger provider writes", () => {
  for (const request of [{ source: "clerk", receivedAt: 1000 }, { source: "device", receivedAt: -15000 }, { source: "device", receivedAt: 1002 }]) {
    const result = eligibility(live(), request, 1001, { source: "verified-live-queue", ranked1v1: true }); expect(result.marker).toBe(false); expect(result.prediction).toBe(false);
  }
});
