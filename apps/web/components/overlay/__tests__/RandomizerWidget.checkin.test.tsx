import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import type {
  LiveGameEnvelope,
  LiveGamePayload,
  RandomizerIntentGate,
  RandomizerSpinEvent,
} from "../types";
import type { RandomizerConfig, SpinOutcome } from "@/lib/randomizer/types";
import { defaultRandomizerConfig } from "@/lib/randomizer/config";
import { RANDOMIZER_INTENT_WAIT_MS } from "../buildIntentGate";

const reveals = vi.hoisted(() => [] as string[]);

vi.mock("@/components/randomizer/reveals/revealSound", () => ({
  setRevealSoundEnabled: vi.fn(),
  setRevealSoundVolume: vi.fn(),
}));
vi.mock("@/components/randomizer/RandomizerSequence", () => ({
  RandomizerSequence: ({ outcome }: { outcome: SpinOutcome }) => {
    useEffect(() => { reveals.push(outcome.winner.id); }, [outcome]);
    return <span data-testid="reveal">{outcome.winner.name}</span>;
  },
}));

import { RandomizerWidget } from "../widgets/RandomizerWidget";

const GAME = "Opponent|Streamer|1700000000000";

function config(): RandomizerConfig {
  const cfg = defaultRandomizerConfig();
  cfg.matchups.PvT.enabled = true;
  cfg.matchups.PvT.builds = [{
    id: "pvt-blink-stalkers", name: "PvT - Blink Stalkers", race: "Protoss", source: "catalog", weight: 1,
  }];
  return cfg;
}
function envelope(over: Partial<LiveGameEnvelope> = {}): LiveGameEnvelope {
  return {
    type: "liveGameState", phase: "match_loading", capturedAt: 1, gameKey: GAME,
    user: { name: "Streamer", race: "Protoss" }, opponent: { name: "Opponent", race: "Terran" }, ...over,
  };
}
function intent(over: Partial<RandomizerIntentGate> = {}): RandomizerIntentGate {
  return { gameKey: GAME, seen: true, suppressRandomizer: false, holdDeadlineMs: 0, ...over };
}
/** Hold that ends ``ms`` from now on the local clock. */
function held(ms: number, over: Partial<RandomizerIntentGate> = {}): RandomizerIntentGate {
  return intent({ holdDeadlineMs: Date.now() + ms, ...over });
}

interface Props {
  live?: LiveGamePayload | null;
  liveGame?: LiveGameEnvelope | null;
  intent?: RandomizerIntentGate | null;
  visible?: boolean;
  config?: RandomizerConfig;
}
const cfg = config();
let spins: RandomizerSpinEvent[];
function harness(initial: Props) {
  const onSpin = (spin: RandomizerSpinEvent) => { spins.push(spin); };
  const element = (p: Props) => (
    <RandomizerWidget
      live={p.live ?? null}
      liveGame={p.liveGame === undefined ? envelope() : p.liveGame}
      config={p.config ?? cfg}
      visible={p.visible ?? true}
      intent={p.intent ?? null}
      onSpin={onSpin}
    />
  );
  const view = render(element(initial));
  return { update: (next: Props) => view.rerender(element(next)) };
}
function advance(ms: number) { act(() => vi.advanceTimersByTime(ms)); }
function revealShown() { return screen.queryByTestId("reveal") !== null; }

describe("RandomizerWidget build check-in gate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reveals.length = 0;
    spins = [];
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("spins after the bounded wait when no check-in state ever arrives", () => {
    harness({});
    advance(RANDOMIZER_INTENT_WAIT_MS - 1);
    expect(reveals).toEqual([]);
    advance(1);
    expect(reveals).toEqual(["pvt-blink-stalkers"]);
    expect(spins).toEqual([{
      triggerKey: `game:${GAME}`,
      startedAtMs: Date.now(),
      roll: { gameKey: GAME, buildId: "pvt-blink-stalkers" },
    }]);
  });

  it("does not restart a reveal on repeated match ticks, enrichment, phase changes or cloned saved picks", () => {
    const saved = { key: "pvt-blink-stalkers", name: "PvT - Blink Stalkers", source: "catalog" as const };
    const view = harness({ intent: intent({ randomizer: saved }) });
    expect(reveals).toEqual([saved.key]);
    for (let displayTime = 0; displayTime < 60; displayTime++) {
      view.update({
        liveGame: envelope({
          phase: displayTime < 2 ? "match_started" : "match_in_progress",
          displayTime,
          streamerHistory: { oppName: "Opponent", matchup: "PvT", headToHead: { wins: 3, losses: 2 } },
        }),
        config: { ...cfg, matchups: { ...cfg.matchups } },
        intent: intent({ randomizer: { ...saved } }),
      });
      advance(1000);
    }
    expect(reveals).toEqual([saved.key]);
    expect(spins).toHaveLength(1);
    expect(spins[0].roll).toBeNull();
  });

  it("starts the wait once the matchup is known, so a late hold still lands", () => {
    const view = harness({ liveGame: envelope({ user: undefined, opponent: undefined }) });
    advance(5_000);
    view.update({});
    expect(reveals).toEqual([]);
    view.update({ intent: held(6_000) });
    advance(5_999);
    expect(reveals).toEqual([]);
    advance(1);
    expect(reveals).toEqual(["pvt-blink-stalkers"]);
  });

  it("still spins within the bounded wait after a late matchup", () => {
    const view = harness({ liveGame: envelope({ user: undefined, opponent: undefined }) });
    advance(5_000);
    view.update({});
    advance(RANDOMIZER_INTENT_WAIT_MS);
    expect(reveals).toEqual(["pvt-blink-stalkers"]);
  });

  it("spins as soon as state without a hold arrives", () => {
    const view = harness({});
    advance(200);
    view.update({ intent: intent() });
    expect(reveals).toEqual(["pvt-blink-stalkers"]);
  });

  it("reveals the saved check-in choice without making a second draw or report", () => {
    const saved = { key: "custom:saved-pick", name: "Saved check-in choice", source: "custom" as const };
    const view = harness({ intent: intent({ randomizer: saved }) });
    expect(reveals).toEqual([saved.key]);
    expect(screen.getByTestId("reveal").textContent).toBe(saved.name);
    expect(spins[0].roll).toBeNull();
    view.update({ intent: intent({ randomizer: { ...saved } }) });
    expect(reveals).toEqual([saved.key]);
    expect(spins).toHaveLength(1);
  });

  it("reconciles an unaccepted local reveal with the saved canonical result", () => {
    const view = harness({ intent: intent() });
    expect(reveals).toEqual(["pvt-blink-stalkers"]);
    view.update({ intent: intent({ randomizer: { key: "custom:canonical", name: "Canonical result", source: "custom" } }) });
    expect(reveals).toEqual(["pvt-blink-stalkers", "custom:canonical"]);
    expect(spins[1].roll).toBeNull();
  });

  it("hides immediately when the matchup is disabled and never replays that spin", () => {
    const view = harness({ intent: intent() });
    expect(revealShown()).toBe(true);
    view.update({ intent: intent(), config: { ...cfg, matchups: { ...cfg.matchups, PvT: { ...cfg.matchups.PvT, enabled: false } } } });
    expect(revealShown()).toBe(false);
    view.update({ intent: intent(), config: cfg });
    expect(revealShown()).toBe(false);
    expect(spins).toHaveLength(1);
  });

  it("holds until the local deadline, then spins", () => {
    const view = harness({ intent: held(6_000) });
    advance(5_999);
    expect(reveals).toEqual([]);
    view.update({ intent: held(1) });
    advance(1);
    expect(reveals).toEqual(["pvt-blink-stalkers"]);
    expect(spins).toHaveLength(1);
  });

  it("spins at the deadline without any further update", () => {
    harness({ intent: held(6_000) });
    advance(5_999);
    expect(reveals).toEqual([]);
    advance(1);
    expect(reveals).toEqual(["pvt-blink-stalkers"]);
  });

  it("never spins for a game declared during the hold", () => {
    const view = harness({ intent: held(6_000) });
    advance(2_000);
    const declared = intent({ suppressRandomizer: true });
    view.update({ intent: declared });
    advance(10_000);
    view.update({ intent: declared, liveGame: envelope({ phase: "match_started" }) });
    view.update({ intent: declared, liveGame: envelope({ phase: "match_in_progress" }) });
    advance(30_000);
    expect(reveals).toEqual([]);
    expect(spins).toEqual([]);
  });

  it("spins immediately when the hold is released", () => {
    const view = harness({ intent: held(6_000) });
    advance(1_000);
    view.update({ intent: intent({ holdDeadlineMs: 0 }) });
    expect(reveals).toEqual(["pvt-blink-stalkers"]);
  });

  it.each(["match_started", "match_in_progress"] as const)("lets %s end the hold", (phase) => {
    const view = harness({ intent: held(6_000) });
    advance(1_000);
    view.update({ intent: held(5_000), liveGame: envelope({ phase }) });
    expect(reveals).toEqual(["pvt-blink-stalkers"]);
  });

  it("spins once an undeclare lifts the suppression", () => {
    const view = harness({ intent: intent({ suppressRandomizer: true }) });
    advance(4_000);
    expect(reveals).toEqual([]);
    view.update({ intent: intent() });
    expect(reveals).toEqual(["pvt-blink-stalkers"]);
  });

  it("hides a running reveal when a different build is declared, for good", () => {
    const view = harness({ intent: intent() });
    expect(revealShown()).toBe(true);
    view.update({ intent: intent({ suppressRandomizer: true }) });
    expect(revealShown()).toBe(false);
    view.update({ intent: intent() });
    expect(revealShown()).toBe(false);
    expect(reveals).toHaveLength(1);
    expect(spins).toHaveLength(1);
  });

  it("keeps the reveal when the declaration matches the roll", () => {
    const view = harness({ intent: intent() });
    view.update({ intent: intent(), liveGame: envelope({ phase: "match_started" }) });
    expect(revealShown()).toBe(true);
  });

  it("ignores state that belongs to another game", () => {
    harness({ intent: intent({ gameKey: "Someone|Else|1", suppressRandomizer: true }) });
    advance(RANDOMIZER_INTENT_WAIT_MS);
    expect(reveals).toEqual(["pvt-blink-stalkers"]);
  });

  it("does not spin while hidden, and keeps waiting for visibility", () => {
    const view = harness({ intent: intent(), visible: false });
    advance(10_000);
    expect(reveals).toEqual([]);
    view.update({ intent: intent(), visible: true });
    expect(reveals).toEqual(["pvt-blink-stalkers"]);
  });

  it("never gates or reports a Test fire", () => {
    const test: LiveGamePayload = { isTest: true, testNonce: "n1", matchup: "PvT", result: "win" };
    harness({ live: test, liveGame: null, intent: null });
    expect(reveals).toEqual(["pvt-blink-stalkers"]);
    expect(spins).toEqual([expect.objectContaining({ triggerKey: "test:n1", roll: null })]);
  });

  it("reports a result-less pre-game payload when the agent is offline", () => {
    harness({ live: { gameKey: "cloud-key", matchup: "PvT" }, liveGame: null });
    advance(RANDOMIZER_INTENT_WAIT_MS);
    expect(spins).toEqual([expect.objectContaining({
      roll: { gameKey: "cloud-key", buildId: "pvt-blink-stalkers" },
    })]);
  });

  it("never spins or reports from a result-bearing payload", () => {
    harness({ live: { gameKey: "cloud-key", matchup: "PvT", result: "win" }, liveGame: null });
    advance(RANDOMIZER_INTENT_WAIT_MS * 4);
    expect(reveals).toEqual([]);
    expect(spins).toEqual([]);
  });
});
