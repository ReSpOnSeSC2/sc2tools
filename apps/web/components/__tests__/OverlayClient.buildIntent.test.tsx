import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import type { LiveGameEnvelope, LiveGamePayload } from "../overlay/types";
import type { SpinOutcome } from "@/lib/randomizer/types";
import { defaultRandomizerConfig } from "@/lib/randomizer/config";
import { RANDOMIZER_INTENT_WAIT_MS } from "../overlay/buildIntentGate";

const reveals = vi.hoisted(() => [] as string[]);

type SocketHandler = (...args: unknown[]) => void;
class FakeSocket {
  connect() {}
  off() {}
  handlers = new Map<string, SocketHandler>();
  emitted: Array<[string, unknown]> = [];
  on(event: string, handler: SocketHandler) { this.handlers.set(event, handler); }
  emit(event: string, payload?: unknown) { this.emitted.push([event, payload]); }
  disconnect() {}
  fire(event: string, ...args: unknown[]) { this.handlers.get(event)?.(...args); }
  rolls() { return this.emitted.filter(([event]) => event === "overlay:randomizer:rolled").map(([, p]) => p); }
}
let socket: FakeSocket;

vi.mock("socket.io-client", () => ({ io: () => (socket = new FakeSocket()) }));
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

import { OverlayClient } from "../OverlayClient";

const GAME = "Maru|Streamer|1700000000000";
const ROLL = { gameKey: GAME, buildId: "pvt-blink-stalkers" };

function configure(enabledWidgets: string[] = ["randomizer"]) {
  const randomizer = defaultRandomizerConfig();
  randomizer.matchups.PvT.enabled = true;
  randomizer.matchups.PvT.builds = [{
    id: "pvt-blink-stalkers", name: "PvT - Blink Stalkers", race: "Protoss", source: "catalog", weight: 1,
  }];
  act(() => socket.fire("overlay:config", { enabledWidgets, randomizer }));
}
function setup() {
  render(<OverlayClient token="tok" showCredit={false} />);
  configure();
}
function envelope(over: Partial<LiveGameEnvelope> = {}) {
  act(() => socket.fire("overlay:liveGame", {
    type: "liveGameState", phase: "match_loading", capturedAt: 1, gameKey: GAME,
    user: { name: "Streamer", race: "Protoss" }, opponent: { name: "Maru", race: "Terran" }, ...over,
  } satisfies LiveGameEnvelope));
}
function intent(suppressRandomizer: boolean, holdRemainingMs: number) {
  act(() => socket.fire("overlay:buildIntent", { gameKey: GAME, suppressRandomizer, holdRemainingMs }));
}
function advance(ms: number) { act(() => vi.advanceTimersByTime(ms)); }
function revealOnScreen(): boolean {
  const reveal = screen.queryByTestId("reveal");
  if (!reveal) return false;
  let node: HTMLElement | null = reveal;
  while (node) {
    if (node.style.display === "none") return false;
    node = node.parentElement;
  }
  return true;
}

describe("all-in-one overlay randomizer — build check-in", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reveals.length = 0;
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("spins after the bounded wait without check-in state and reports the roll", () => {
    setup();
    envelope();
    advance(RANDOMIZER_INTENT_WAIT_MS - 1);
    expect(reveals).toEqual([]);
    advance(1);
    expect(revealOnScreen()).toBe(true);
    expect(socket.rolls()).toEqual([ROLL]);
  });

  it("holds the spin and runs the full window from the spin", () => {
    setup();
    envelope();
    intent(false, 6_000);
    advance(5_999);
    expect(reveals).toEqual([]);
    advance(1);
    expect(revealOnScreen()).toBe(true);
    advance(31_999);
    expect(revealOnScreen()).toBe(true);
    advance(1);
    expect(revealOnScreen()).toBe(false);
    expect(socket.rolls()).toEqual([ROLL]);
  });

  it("never spins a game declared during the hold", () => {
    setup();
    envelope();
    intent(false, 6_000);
    advance(3_000);
    intent(true, 0);
    envelope({ phase: "match_started", capturedAt: 2 });
    advance(30_000);
    expect(reveals).toEqual([]);
    expect(socket.rolls()).toEqual([]);
  });

  it("spins on release and when the match starts", () => {
    setup();
    envelope();
    intent(false, 6_000);
    advance(1_000);
    intent(false, 0);
    expect(reveals).toEqual(["pvt-blink-stalkers"]);

    cleanup();
    reveals.length = 0;
    setup();
    envelope();
    intent(false, 6_000);
    advance(1_000);
    envelope({ phase: "match_started", capturedAt: 2 });
    expect(reveals).toEqual(["pvt-blink-stalkers"]);
  });

  it("reveals the canonical check-in result without writing a duplicate roll", () => {
    setup();
    act(() => socket.fire("overlay:buildIntent", { gameKey: GAME, suppressRandomizer: false, holdRemainingMs: 0,
      randomizer: { key: "custom:saved", name: "Already selected build", source: "custom" } }));
    envelope();
    expect(reveals).toEqual(["custom:saved"]);
    expect(revealOnScreen()).toBe(true);
    expect(socket.rolls()).toEqual([]);
  });

  it("hides a running reveal when a different build is declared", () => {
    setup();
    envelope();
    intent(false, 0);
    expect(revealOnScreen()).toBe(true);
    intent(true, 0);
    expect(revealOnScreen()).toBe(false);
  });

  it("reports once per game even when the widget remounts and re-spins", () => {
    setup();
    envelope();
    intent(false, 0);
    configure([]);
    configure(["randomizer"]);
    advance(RANDOMIZER_INTENT_WAIT_MS);
    expect(reveals).toEqual(["pvt-blink-stalkers", "pvt-blink-stalkers"]);
    expect(socket.rolls()).toEqual([ROLL]);
  });

  it("never reports a Test fire", () => {
    setup();
    act(() => socket.fire("overlay:live", {
      isTest: true, testNonce: 7, matchup: "PvT", result: "win",
    } satisfies LiveGamePayload));
    expect(reveals).toEqual(["pvt-blink-stalkers"]);
    expect(socket.rolls()).toEqual([]);
  });

  it("applies a declaration replayed after a reconnect", () => {
    setup();
    envelope();
    intent(false, 6_000);
    advance(2_000);
    act(() => socket.fire("disconnect"));
    // Declared on the agent card while this source was offline.
    act(() => socket.fire("connect"));
    expect(socket.emitted.some(([event]) => event === "overlay:resync")).toBe(true);
    intent(true, 0);
    envelope({ synthetic: true });
    envelope({ phase: "match_in_progress", capturedAt: 3 });
    advance(30_000);
    expect(reveals).toEqual([]);
    expect(socket.rolls()).toEqual([]);
  });

  it("keeps a replayed hold on the local clock after a reconnect", () => {
    setup();
    envelope();
    intent(false, 6_000);
    advance(2_000);
    act(() => socket.fire("disconnect"));
    act(() => socket.fire("connect"));
    intent(false, 3_000);
    advance(2_999);
    expect(reveals).toEqual([]);
    advance(1);
    expect(reveals).toEqual(["pvt-blink-stalkers"]);
    expect(socket.rolls()).toEqual([ROLL]);
  });
});
