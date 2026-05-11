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

  test("lifts opponent.strategy onto top-level opp_strategy", () => {
    // The agent persists strategy nested under `opponent.strategy`; arcade
    // modes (especially Buildle's oppOpener question) read `opp_strategy`
    // at the top level. Without this lift every Buildle game with a
    // resolved opponent strategy fails to qualify and today's case file
    // falls through to "couldn't build".
    const g = normaliseGame({
      gameId: "g1",
      date: "2026-05-10T12:00:00Z",
      result: "Victory",
      opponent: {
        displayName: "Bob",
        race: "Zerg",
        strategy: "Zergling Baneling all-in",
      } as never,
    });
    expect(g.opp_strategy).toBe("Zergling Baneling all-in");
  });

  test("prefers top-level opp_strategy over opponent.strategy when both present", () => {
    const g = normaliseGame({
      gameId: "g1",
      date: "2026-05-10T12:00:00Z",
      result: "Victory",
      opp_strategy: "Roach push",
      opponent: { strategy: "Mutalisk" } as never,
    });
    expect(g.opp_strategy).toBe("Roach push");
  });

  test("lifts opponent.pulseId onto top-level oppPulseId", () => {
    // Buildle's per-opponent questions (timesPlayed, careerWR) join games
    // against the opponents collection by `oppPulseId`. Without the lift
    // the per-opponent question types collapse with no candidate games.
    const g = normaliseGame({
      gameId: "g1",
      date: "2026-05-10T12:00:00Z",
      result: "Victory",
      opponent: { pulseId: "1-S2-1-12345" } as never,
    });
    expect(g.oppPulseId).toBe("1-S2-1-12345");
  });

  test("opp_strategy is null when neither top-level nor nested field is set", () => {
    const g = normaliseGame({
      gameId: "g1",
      date: "2026-05-10T12:00:00Z",
      result: "Victory",
    });
    expect(g.opp_strategy).toBeNull();
  });
});
