import { describe, expect, test } from "vitest";
import { normaliseGame } from "../hooks/useArcadeData";

describe("useArcadeData — normaliseGame", () => {
  test("aliases API camelCase durationSec onto duration", () => {
    const g = normaliseGame({
      gameId: "g1",
      date: "2026-05-10T12:00:00Z",
      result: "Victory",
      durationSec: 720,
    });
    expect(g.duration).toBe(720);
  });

  test("aliases API camelCase macroScore onto macro_score", () => {
    const g = normaliseGame({
      gameId: "g1",
      date: "2026-05-10T12:00:00Z",
      result: "Victory",
      macroScore: 87,
    });
    expect(g.macro_score).toBe(87);
  });

  test("lifts opponent.race onto top-level oppRace when oppRace is absent", () => {
    const g = normaliseGame({
      gameId: "g1",
      date: "2026-05-10T12:00:00Z",
      result: "Victory",
      opponent: { displayName: "Bob", race: "Protoss" },
    });
    expect(g.oppRace).toBe("Protoss");
  });

  test("prefers top-level duration over durationSec when both present", () => {
    const g = normaliseGame({
      gameId: "g1",
      date: "2026-05-10T12:00:00Z",
      result: "Victory",
      duration: 500,
      durationSec: 999,
    });
    expect(g.duration).toBe(500);
  });

  test("prefers top-level macro_score over macroScore when both present", () => {
    const g = normaliseGame({
      gameId: "g1",
      date: "2026-05-10T12:00:00Z",
      result: "Victory",
      macro_score: 60,
      macroScore: 99,
    });
    expect(g.macro_score).toBe(60);
  });

  test("prefers top-level oppRace over opponent.race when both present", () => {
    const g = normaliseGame({
      gameId: "g1",
      date: "2026-05-10T12:00:00Z",
      result: "Victory",
      oppRace: "Zerg",
      opponent: { race: "Protoss" },
    });
    expect(g.oppRace).toBe("Zerg");
  });

  test("leaves duration undefined when neither field is present", () => {
    const g = normaliseGame({
      gameId: "g1",
      date: "2026-05-10T12:00:00Z",
      result: "Victory",
    });
    expect(g.duration).toBeUndefined();
  });

  test("macro_score collapses to null when neither field is a finite number", () => {
    const g = normaliseGame({
      gameId: "g1",
      date: "2026-05-10T12:00:00Z",
      result: "Victory",
    });
    expect(g.macro_score).toBeNull();
  });
});
