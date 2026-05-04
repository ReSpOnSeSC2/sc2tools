"use strict";

const { validateGameRecord } = require("../src/validation/gameRecord");

describe("validateGameRecord", () => {
  test("accepts a minimal real-shaped record", () => {
    const r = validateGameRecord({
      gameId: "abc-123",
      date: "2026-05-04T12:00:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
    });
    expect(r.valid).toBe(true);
  });

  test("rejects bad result enum", () => {
    const r = validateGameRecord({
      gameId: "abc-123",
      date: "2026-05-04T12:00:00.000Z",
      result: "Win",
      myRace: "Protoss",
      map: "Goldenaura",
    });
    expect(r.valid).toBe(false);
  });

  test("rejects missing gameId", () => {
    const r = validateGameRecord({
      date: "2026-05-04T12:00:00.000Z",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
    });
    expect(r.valid).toBe(false);
  });

  test("rejects non-ISO date", () => {
    const r = validateGameRecord({
      gameId: "abc-123",
      date: "May 4 2026",
      result: "Victory",
      myRace: "Protoss",
      map: "Goldenaura",
    });
    expect(r.valid).toBe(false);
  });

  test("accepts opponent block when present", () => {
    const r = validateGameRecord({
      gameId: "abc-123",
      date: "2026-05-04T12:00:00.000Z",
      result: "Defeat",
      myRace: "Zerg",
      map: "Site Delta",
      opponent: {
        pulseId: "1234",
        displayName: "Foo#1",
        race: "Protoss",
        mmr: 4500,
        opening: "Pool first",
      },
    });
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(/** @type {any} */ (r.value).opponent.mmr).toBe(4500);
    }
  });
});
