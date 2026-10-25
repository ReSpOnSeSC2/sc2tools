import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import type { LiveGameEnvelope, LiveGamePayload } from "../overlay/types";
import type { SpinOutcome } from "@/lib/randomizer/types";
import { defaultRandomizerConfig } from "@/lib/randomizer/config";
import { RANDOMIZER_INTENT_WAIT_MS } from "../overlay/buildIntentGate";

type Handler = (...args: unknown[]) => void;
class FakeSocket {
  connect() {}
  off() {}
  handlers = new Map<string, Handler>();
  emitted: Array<[string, unknown]> = [];
  on(event: string, handler: Handler) { this.handlers.set(event, handler); }
  emit(event: string, payload?: unknown) { this.emitted.push([event, payload]); }
  disconnect() {}
  fire(event: string, value?: unknown) { this.handlers.get(event)?.(value); }
  rolls() { return this.emitted.filter(([event]) => event === "overlay:randomizer:rolled").map(([, p]) => p); }
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
    useEffect(() => { reveals.push(outcome.winner.id); }, [outcome]);
    return <span data-testid="reveal">{outcome.winner.name}</span>;
  },
}));

import { OverlayWidgetClient } from "../OverlayWidgetClient";

const GAME = "Opponent|Streamer|1700000000000";
const ROLL = { gameKey: GAME, buildId: "pvt-blink-stalkers" };

function envelope(over: Partial<LiveGameEnvelope> = {}): LiveGameEnvelope {
  return {
    type: "liveGameState", phase: "match_loading", capturedAt: 1,
    gameKey: GAME, user: { name: "Streamer", race: "Protoss" },
    opponent: { name: "Opponent", race: "Terran" }, ...over,
  };
}
function fireEnvelope(over: Partial<LiveGameEnvelope> = {}) {
  act(() => socket.fire("overlay:liveGame", envelope(over)));
}
function fireIntent(suppressRandomizer: boolean, holdRemainingMs: number, gameKey = GAME) {
  act(() => socket.fire("overlay:buildIntent", { gameKey, suppressRandomizer, holdRemainingMs }));
}
function configure() {
  const config = defaultRandomizerConfig();
  config.matchups.PvT.enabled = true;
  config.matchups.PvT.builds = [{
    id: "pvt-blink-stalkers", name: "PvT - Blink Stalkers", race: "Protoss", source: "catalog", weight: 1,
  }];
  act(() => socket.fire("overlay:config", { randomizer: config }));
}
function mount(widget = "randomizer") {
  const view = render(<OverlayWidgetClient token="token" widget={widget} />);
  configure();
  return view;
}
function advance(ms: number) { act(() => vi.advanceTimersByTime(ms)); }
function frameShown(): boolean {
  const frame = document.querySelector<HTMLElement>(".overlay-widget-frame");
  return !!frame && frame.style.display !== "none" && screen.queryByTestId("reveal") !== null;
}

describe("dedicated randomizer source — build check-in", () => {
  beforeEach(() => { vi.useFakeTimers(); reveals.length = 0; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("spins after the bounded wait when no check-in state arrives, and reports it once", () => {
    mount();
    fireEnvelope();
    advance(RANDOMIZER_INTENT_WAIT_MS - 1);
    expect(reveals).toEqual([]);
    advance(1);
    expect(reveals).toEqual(["pvt-blink-stalkers"]);
    expect(socket.rolls()).toEqual([ROLL]);
  });

  it("waits out a hold, spins at its local deadline and keeps the full reveal window", () => {
    mount();
    fireEnvelope();
    fireIntent(false, 6_000);
    advance(5_999);
    expect(reveals).toEqual([]);
    expect(socket.rolls()).toEqual([]);
    advance(1);
    expect(reveals).toEqual(["pvt-blink-stalkers"]);
    expect(socket.rolls()).toEqual([ROLL]);
    // Armed at the start key (0 s) the window would close at 32 s; it now
    // runs 32 s from the spin at 6 s.
    advance(31_999);
    expect(frameShown()).toBe(true);
    advance(1);
    expect(frameShown()).toBe(false);
  });

  it("anchors the hold to local receipt time, not the server's clock", () => {
    mount();
    fireEnvelope();
    advance(1_000);
    fireIntent(false, 2_000);
    advance(1_999);
    expect(reveals).toEqual([]);
    advance(1);
    expect(reveals).toEqual(["pvt-blink-stalkers"]);
  });

  it("never spins or reports a game declared during the hold", () => {
    mount();
    fireEnvelope();
    fireIntent(false, 6_000);
    advance(2_000);
    fireIntent(true, 0);
    advance(10_000);
    fireEnvelope({ phase: "match_started", capturedAt: 13 });
    fireEnvelope({ phase: "match_in_progress", capturedAt: 14 });
    advance(30_000);
    expect(reveals).toEqual([]);
    expect(socket.rolls()).toEqual([]);
  });

  it("spins immediately when the hold is released", () => {
    mount();
    fireEnvelope();
    fireIntent(false, 6_000);
    advance(500);
    fireIntent(false, 0);
    expect(reveals).toEqual(["pvt-blink-stalkers"]);
    expect(socket.rolls()).toEqual([ROLL]);
  });

  it("shows the check-in's saved result when the widget opens after the choice", () => {
    mount();
    act(() => socket.fire("overlay:buildIntent", { gameKey: GAME, suppressRandomizer: false, holdRemainingMs: 0,
      randomizer: { key: "custom:saved", name: "Already selected build", source: "custom" } }));
    fireEnvelope();
    expect(reveals).toEqual(["custom:saved"]);
    expect(frameShown()).toBe(true);
    expect(socket.rolls()).toEqual([]);
  });

  it("ends the hold when the match starts", () => {
    mount();
    fireEnvelope();
    fireIntent(false, 6_000);
    advance(3_000);
    fireEnvelope({ phase: "match_started", capturedAt: 4 });
    expect(reveals).toEqual(["pvt-blink-stalkers"]);
  });

  it("takes a running reveal off stream when a different build is declared", () => {
    mount();
    fireEnvelope();
    fireIntent(false, 0);
    expect(frameShown()).toBe(true);
    advance(3_000);
    fireIntent(true, 0);
    expect(frameShown()).toBe(false);
    fireIntent(false, 0);
    expect(frameShown()).toBe(false);
    expect(reveals).toEqual(["pvt-blink-stalkers"]);
    expect(socket.rolls()).toEqual([ROLL]);
  });

  it("reports exactly once per real game through oscillation and reconnect replays", () => {
    mount();
    fireEnvelope();
    advance(RANDOMIZER_INTENT_WAIT_MS);
    fireEnvelope({ phase: "menu" });
    act(() => socket.fire("connect"));
    fireEnvelope({ synthetic: true });
    fireEnvelope({ phase: "match_in_progress", capturedAt: 5 });
    fireIntent(false, 0);
    advance(40_000);
    expect(socket.rolls()).toEqual([ROLL]);
    fireEnvelope({ gameKey: "Next|Streamer|1700000900000", capturedAt: 50 });
    advance(RANDOMIZER_INTENT_WAIT_MS);
    expect(socket.rolls()).toEqual([ROLL, { gameKey: "Next|Streamer|1700000900000", buildId: "pvt-blink-stalkers" }]);
  });

  it("never reports a Test fire", () => {
    mount();
    act(() => socket.fire("overlay:live", {
      isTest: true, testNonce: "t1", matchup: "PvT", result: "win",
    } satisfies LiveGamePayload));
    expect(reveals).toEqual(["pvt-blink-stalkers"]);
    expect(socket.rolls()).toEqual([]);
  });

  it("applies a replayed hold after reconnecting from the new receipt time", () => {
    mount();
    fireEnvelope();
    fireIntent(false, 6_000);
    advance(1_000);
    act(() => socket.fire("disconnect"));
    act(() => socket.fire("connect"));
    // The cloud replays what is left of the hold on resync.
    fireIntent(false, 1_000);
    advance(999);
    expect(reveals).toEqual([]);
    advance(1);
    expect(reveals).toEqual(["pvt-blink-stalkers"]);
  });

  it("does not re-spin a declared game when an OBS reload replays its state", () => {
    mount();
    fireEnvelope({ synthetic: true });
    fireEnvelope({ phase: "match_in_progress", capturedAt: 40 });
    advance(RANDOMIZER_INTENT_WAIT_MS - 300);
    fireIntent(true, 0);
    advance(30_000);
    expect(reveals).toEqual([]);
    expect(socket.rolls()).toEqual([]);
  });

  it("keeps a reveal held past the original window on screen when races arrive late", () => {
    mount();
    fireEnvelope({ user: undefined, opponent: undefined });
    advance(28_000);
    fireEnvelope({ capturedAt: 29 });
    fireIntent(false, 6_000);
    advance(5_999);
    expect(reveals).toEqual([]);
    advance(1);
    expect(reveals).toEqual(["pvt-blink-stalkers"]);
    advance(31_999);
    expect(frameShown()).toBe(true);
    advance(1);
    expect(frameShown()).toBe(false);
  });

  it("ignores check-in state for another game", () => {
    mount();
    fireEnvelope();
    fireIntent(true, 0, "Someone|Else|1");
    advance(RANDOMIZER_INTENT_WAIT_MS);
    expect(reveals).toEqual(["pvt-blink-stalkers"]);
  });

  it("only subscribes the randomizer source to check-in state", () => {
    mount("scouting");
    expect(socket.handlers.has("overlay:buildIntent")).toBe(false);
    cleanup();
    mount();
    expect(socket.handlers.has("overlay:buildIntent")).toBe(true);
  });
});
