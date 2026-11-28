import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import type { LiveGameEnvelope, RandomizerIntentGate, RandomizerSpinEvent } from "../types";
import type { GameDraw, RandomizerConfig } from "@/lib/randomizer/types";
import { defaultRandomizerConfig } from "@/lib/randomizer/config";

const draws = vi.hoisted(() => [] as GameDraw[]);

vi.mock("@/components/randomizer/reveals/revealSound", () => ({
  setRevealSoundEnabled: vi.fn(),
  setRevealSoundVolume: vi.fn(),
}));
vi.mock("@/components/randomizer/RandomizerSequence", () => ({
  RandomizerSequence: ({ draw }: { draw: GameDraw }) => {
    useEffect(() => { draws.push(draw); }, [draw]);
    return <span data-testid="reveal" />;
  },
  loadUnitStage: () => Promise.resolve(),
}));

import { RandomizerWidget, streamerRace } from "../widgets/RandomizerWidget";

const GAME = "Opponent|Streamer|1700000000000";

function unitsOnly(): RandomizerConfig {
  const cfg = defaultRandomizerConfig();
  for (const matchup of ["TvP", "ZvP"] as const) {
    cfg.matchups[matchup] = {
      ...cfg.matchups[matchup], unitRandomizerEnabled: true,
      units: { gateCount: 1, useCustomWeights: false, units: [{ id: matchup === "TvP" ? "marine" : "zergling", weight: 1 }] },
    };
  }
  return cfg;
}

function envelope(over: Partial<LiveGameEnvelope> = {}): LiveGameEnvelope {
  return {
    type: "liveGameState", phase: "match_started", capturedAt: 1, gameKey: GAME,
    user: { name: "Streamer", race: "Terran" }, opponent: { name: "Opponent", race: "Protoss" }, ...over,
  };
}

/** A Random streamer: the latched choice, and the client's player list. */
function random(reported: string): Partial<LiveGameEnvelope> {
  return {
    user: { name: "Streamer", race: "Random" },
    players: [
      { name: "Streamer", type: "user", race: reported, result: "Undecided" },
      { name: "Opponent", type: "user", race: "Prot", result: "Undecided" },
    ],
  };
}

let spins: RandomizerSpinEvent[];
function show(liveGame: LiveGameEnvelope, config: RandomizerConfig, intent: RandomizerIntentGate | null = null) {
  const element = (game: LiveGameEnvelope) => (
    <RandomizerWidget live={null} liveGame={game} config={config} intent={intent} onSpin={(spin) => spins.push(spin)} />
  );
  const view = render(element(liveGame));
  return (next: LiveGameEnvelope) => view.rerender(element(next));
}

describe("RandomizerWidget switches and Random", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    draws.length = 0;
    spins = [];
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("reveals units alone, with no build and no roll for the server", () => {
    show(envelope(), unitsOnly(), { gameKey: GAME, seen: true, suppressRandomizer: false, holdDeadlineMs: 0 });
    expect(draws).toHaveLength(1);
    expect(draws[0]).toMatchObject({ matchup: "TvP", build: null, units: { race: "Terran", picks: ["marine"] } });
    expect(spins.map((spin) => spin.roll)).toEqual([null]);
  });

  it("ignores a saved pick while the build draw is off, so units drawn alone play once", () => {
    const config = unitsOnly();
    const gate = (holdDeadlineMs: number): RandomizerIntentGate => ({
      gameKey: GAME, seen: true, suppressRandomizer: false, holdDeadlineMs,
      randomizer: { key: "custom:earlier", name: "Earlier pick", source: "custom" },
    });
    const element = (intent: RandomizerIntentGate, game: LiveGameEnvelope) => (
      <RandomizerWidget live={null} liveGame={game} config={config} intent={intent} onSpin={(spin) => spins.push(spin)} />
    );
    const view = render(element(gate(0), envelope()));
    act(() => vi.advanceTimersByTime(60_000));
    view.rerender(element(gate(1), envelope({ displayTime: 12 })));
    act(() => vi.advanceTimersByTime(60_000));
    expect(draws).toHaveLength(1);
    expect(draws[0]).toMatchObject({ build: null, units: { picks: ["marine"] } });
    expect(spins).toHaveLength(1);
  });

  it("keeps units drawn alone for a game whose build was declared", () => {
    show(envelope(), unitsOnly(), { gameKey: GAME, seen: true, suppressRandomizer: true, holdDeadlineMs: 0 });
    expect(draws.map((draw) => draw.units?.picks)).toEqual([["marine"]]);
  });

  it("takes units drawn alone off screen when the unit draw turns off, never replaying them", () => {
    const config = unitsOnly();
    const element = (cfg: RandomizerConfig) => (
      <RandomizerWidget live={null} liveGame={envelope()} config={cfg} intent={null} onSpin={(spin) => spins.push(spin)} />
    );
    const view = render(element(config));
    act(() => vi.advanceTimersByTime(60_000));
    expect(view.queryByTestId("reveal")).not.toBeNull();
    const off = { ...config, matchups: { ...config.matchups, TvP: { ...config.matchups.TvP, unitRandomizerEnabled: false } } };
    view.rerender(element(off));
    expect(view.queryByTestId("reveal")).toBeNull();
    view.rerender(element(config));
    act(() => vi.advanceTimersByTime(60_000));
    expect(view.queryByTestId("reveal")).toBeNull();
    expect(draws).toHaveLength(1);
  });

  it("draws nothing for a matchup with both switches off", () => {
    show(envelope({ user: { name: "Streamer", race: "Protoss" } }), unitsOnly());
    act(() => vi.advanceTimersByTime(60_000));
    expect(draws).toHaveLength(0);
  });

  it("waits while a Random streamer's race is unknown, then draws once for the race they got", () => {
    const update = show(envelope(random("random")), unitsOnly());
    act(() => vi.advanceTimersByTime(60_000));
    expect(draws).toHaveLength(0);
    update(envelope(random("Zerg")));
    act(() => vi.advanceTimersByTime(60_000));
    update(envelope({ ...random("Zerg"), displayTime: 12 }));
    act(() => vi.advanceTimersByTime(60_000));
    expect(draws.map((draw) => [draw.matchup, draw.units?.picks])).toEqual([["ZvP", ["zergling"]]]);
  });
});

describe("streamerRace", () => {
  it("keeps a concrete race and reads a Random streamer's race from the player list", () => {
    expect(streamerRace(envelope())).toBe("Terran");
    expect(streamerRace(envelope(random("Zerg")))).toBe("Zerg");
    expect(streamerRace(envelope(random("?")))).toBe("Random");
  });

  it("never guesses between two players of the same name, or a missing name", () => {
    const twins = envelope({ ...random("Zerg"), players: [
      { name: "Streamer", type: "user", race: "Zerg", result: "Undecided" },
      { name: "Streamer", type: "user", race: "Terran", result: "Undecided" },
    ] });
    expect(streamerRace(twins)).toBe("Random");
    expect(streamerRace(envelope({ ...random("Zerg"), user: { race: "Random" } }))).toBe("Random");
  });
});
