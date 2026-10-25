import { describe, expect, it } from "vitest";
import { GAME_MOMENT_KINDS, GAME_MOMENT_LABELS, MOMENT_FRESH_MS, momentCardEvent, sanitizeGameMoment, sanitizeGameMomentConfig } from "../gameMoments";
import { isAlertVisualSelection, sanitizeAlertConfig } from "../multichat/alerts";
const NOW = 1_700_000_000_000;
const event = { kind: "winStreak", gameId: "recorded-game", atMs: NOW, headline: "Five wins", detail: "Recorded on this ladder account/race." };
describe("game moment wire and preference boundary", () => {
  it("shares nine known kinds and real preset defaults with the API catalog", () => {
    const config = sanitizeGameMomentConfig(undefined);
    expect(GAME_MOMENT_KINDS).toHaveLength(9); expect(Object.keys(GAME_MOMENT_LABELS)).toEqual(GAME_MOMENT_KINDS);
    expect(Object.values(config.moments).every(choice => !choice.enabled && choice.sound === "none" && isAlertVisualSelection(choice.preset))).toBe(true);
    expect(config.botPost).toBe(false); expect(config.mmrStep).toBe(100);
  });
  it("keeps old alert snapshots compatible and new snapshots complete/safe", () => {
    expect(sanitizeAlertConfig({}).gameMoments).toBeUndefined();
    const config = sanitizeAlertConfig({ gameMoments: { mmrStep: 250, botPost: "true", moments: { winStreak: { enabled: true, preset: "classic", sound: "ding" }, forged: { enabled: true } } } }).gameMoments!;
    expect(config).toMatchObject({ mmrStep: 250, botPost: false, moments: { winStreak: { enabled: true, preset: "classic", sound: "ding" } } });
    expect(Object.keys(config.moments)).toHaveLength(9);
  });
  it.each([{ kind: "unknown" }, { gameId: "x".repeat(201) }, { gameId: "" }, { atMs: NOW - MOMENT_FRESH_MS - 1 }, { atMs: NOW + 30001 }, { headline: "" }, { atMs: "now" }])("rejects unknown, stale or unbounded wire values: %j", patch => {
    expect(sanitizeGameMoment({ ...event, ...patch }, NOW)).toBeNull();
  });
  it("whitelist-shapes text and keeps the card-only adapter separate from provider reporting", () => {
    const moment = sanitizeGameMoment({ ...event, headline: "<b>Five wins</b>\n", privateNote: "never" }, NOW)!;
    expect(moment).toEqual(event); expect(momentCardEvent(moment)).toMatchObject({ id: "ladder:recorded-game:winStreak", user: "Five wins" });
    expect(moment).not.toHaveProperty("privateNote");
  });
});
