import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import type { LiveGameEnvelope, LiveGamePayload } from "../overlay/types";
import type { SpinOutcome } from "@/lib/randomizer/types";
import { defaultRandomizerConfig } from "@/lib/randomizer/config";

type Handler = (...args: unknown[]) => void;
class FakeSocket {
  handlers = new Map<string, Handler>();
  on(event: string, handler: Handler) { this.handlers.set(event, handler); }
  emit() {}
  disconnect() {}
  fire(event: string, value: unknown) { this.handlers.get(event)?.(value); }
}
let socket: FakeSocket;
const reveals: string[] = [];

vi.mock("socket.io-client", () => ({
  io: () => (socket = new FakeSocket()),
}));
vi.mock("@/lib/clientApi", () => ({ API_BASE: "http://test.invalid" }));
vi.mock("@/lib/timeseries", () => ({ clientTimezone: () => "UTC" }));
vi.mock("@/components/overlay/useVoiceReadout", () => ({
  useVoiceReadout: () => ({ needsGesture: false, onUserGesture: vi.fn() }),
}));
vi.mock("@/components/randomizer/reveals/revealSound", () => ({
  setRevealSoundEnabled: vi.fn(),
  setRevealSoundVolume: vi.fn(),
  useRevealAudioUnlock: vi.fn(),
}));
vi.mock("@/components/randomizer/RandomizerSequence", () => ({
  RandomizerSequence: ({ outcome }: { outcome: SpinOutcome }) => {
    useEffect(() => { reveals.push(outcome.matchup); }, [outcome]);
    return <span data-testid="reveal">{outcome.matchup}</span>;
  },
}));

import { OverlayWidgetClient } from "../OverlayWidgetClient";

function envelope(over: Partial<LiveGameEnvelope> = {}): LiveGameEnvelope {
  return {
    type: "liveGameState", phase: "match_loading", capturedAt: 1,
    gameKey: "game-1", user: { name: "Streamer", race: "Protoss" },
    opponent: { name: "Opponent", race: "Terran" }, ...over,
  };
}
function fireEnvelope(over: Partial<LiveGameEnvelope> = {}) {
  act(() => socket.fire("overlay:liveGame", envelope(over)));
}
function configure() {
  const config = defaultRandomizerConfig();
  for (const matchup of ["PvT", "PvZ"] as const) {
    config.matchups[matchup].enabled = true;
    config.matchups[matchup].builds = [{
      id: matchup, name: matchup, race: "Protoss", source: "catalog", weight: 1,
    }];
  }
  act(() => socket.fire("overlay:config", { randomizer: config }));
}

describe("dedicated game-start widgets", () => {
  beforeEach(() => { vi.useFakeTimers(); reveals.length = 0; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("does not restart the randomizer during loading/menu/reconnect oscillation", () => {
    const view = render(<OverlayWidgetClient token="token" widget="randomizer" />);
    configure();
    fireEnvelope();
    expect(reveals).toEqual(["PvT"]);
    act(() => vi.advanceTimersByTime(2_000));
    fireEnvelope({ phase: "menu" });
    act(() => vi.advanceTimersByTime(1_000));
    fireEnvelope({ phase: "match_loading", synthetic: true });
    fireEnvelope({ phase: "match_started", capturedAt: 4 });
    fireEnvelope({ phase: "match_loading", capturedAt: 5 });
    expect(reveals).toEqual(["PvT"]);
    act(() => vi.advanceTimersByTime(29_000));
    expect(view.container.querySelector<HTMLElement>(".overlay-widget-frame")?.style.display)
      .toBe("none");
    fireEnvelope({ phase: "menu" });
    fireEnvelope({ phase: "match_in_progress", capturedAt: 34 });
    expect(reveals).toEqual(["PvT"]);
    expect(view.container.querySelector<HTMLElement>(".overlay-widget-frame")?.style.display)
      .toBe("none");
    fireEnvelope({ gameKey: "game-2", capturedAt: 35 });
    expect(reveals).toEqual(["PvT", "PvT"]);
  });

  it("keeps the scouting deadline across a brief start-state gap", () => {
    const view = render(<OverlayWidgetClient token="token" widget="scouting" />);
    fireEnvelope();
    expect(view.container.textContent).toContain("Opponent");
    act(() => vi.advanceTimersByTime(5_000));
    fireEnvelope({ phase: "menu" });
    fireEnvelope({ phase: "match_started", capturedAt: 6 });
    expect(view.container.textContent).toContain("Opponent");
    act(() => vi.advanceTimersByTime(10_000));
    expect(view.container.textContent).not.toContain("Opponent");
    fireEnvelope({ phase: "menu" });
    fireEnvelope({ phase: "match_loading", capturedAt: 16 });
    expect(view.container.textContent).not.toContain("Opponent");
    fireEnvelope({ gameKey: "game-2", capturedAt: 17 });
    expect(view.container.textContent).toContain("Opponent");
  });

  it("keeps the same reveal and deadline through an identity-less partial tick", () => {
    const view = render(<OverlayWidgetClient token="token" widget="randomizer" />);
    configure();
    fireEnvelope();
    act(() => vi.advanceTimersByTime(5_000));
    fireEnvelope({ gameKey: undefined, user: undefined, opponent: undefined, synthetic: true });
    fireEnvelope({ phase: "match_started", capturedAt: 6 });
    expect(reveals).toEqual(["PvT"]);
    act(() => vi.advanceTimersByTime(27_000));
    fireEnvelope({ gameKey: undefined, synthetic: true });
    fireEnvelope({ phase: "match_in_progress", capturedAt: 33 });
    expect(reveals).toEqual(["PvT"]);
    expect(view.container.querySelector<HTMLElement>(".overlay-widget-frame")?.style.display)
      .toBe("none");
  });

  it("does not start a hidden reveal when current matchup data arrives after timeout", () => {
    render(<OverlayWidgetClient token="token" widget="randomizer" />);
    configure();
    fireEnvelope({ user: undefined, opponent: undefined });
    act(() => vi.advanceTimersByTime(32_000));
    fireEnvelope({ phase: "match_in_progress", capturedAt: 33 });
    expect(reveals).toEqual([]);
    fireEnvelope({ gameKey: "game-2", capturedAt: 34 });
    expect(reveals).toEqual(["PvT"]);
  });

  it("waits for the current matchup instead of spinning from the previous game", () => {
    render(<OverlayWidgetClient token="token" widget="randomizer" />);
    configure();
    act(() => socket.fire("overlay:live", {
      gameKey: "old-game", matchup: "PvT", result: "loss",
    } satisfies LiveGamePayload));
    fireEnvelope({ gameKey: "new-game", synthetic: true, user: undefined, opponent: undefined });
    expect(reveals).toEqual([]);
    fireEnvelope({ gameKey: "new-game", opponent: { name: "NewOpponent", race: "Zerg" } });
    expect(reveals).toEqual(["PvZ"]);
    fireEnvelope({
      gameKey: "new-game", phase: "match_started",
      opponent: { name: "NewOpponent", race: "Zerg" },
      streamerHistory: { oppName: "NewOpponent", matchup: "PvZ" },
    });
    expect(reveals).toEqual(["PvZ"]);
  });

  it("does not spin again when enrichment changes a matchup or config", () => {
    render(<OverlayWidgetClient token="token" widget="randomizer" />);
    configure();
    fireEnvelope();
    fireEnvelope({ streamerHistory: { oppName: "Opponent", matchup: "PvZ" } });
    configure();
    expect(reveals).toEqual(["PvT"]);
  });

  it("permits distinct Test clicks but does not replay a duplicate nonce", () => {
    render(<OverlayWidgetClient token="token" widget="randomizer" />);
    configure();
    const test = { isTest: true, matchup: "PvT", testNonce: "first" } satisfies LiveGamePayload;
    act(() => socket.fire("overlay:live", test));
    act(() => vi.advanceTimersByTime(20_000));
    act(() => socket.fire("overlay:live", { ...test }));
    expect(reveals).toEqual(["PvT"]);
    act(() => socket.fire("overlay:live", { ...test, testNonce: "second" }));
    expect(reveals).toEqual(["PvT", "PvT"]);
  });
});
