import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const mounts = vi.hoisted(() => ({ scouting: vi.fn(), randomizer: vi.fn() }));

type SocketHandler = (...args: unknown[]) => void;
class FakeSocket {
  handlers = new Map<string, SocketHandler>();
  on(event: string, handler: SocketHandler) { this.handlers.set(event, handler); }
  emit() {}
  disconnect() {}
  fire(event: string, ...args: unknown[]) { this.handlers.get(event)?.(...args); }
}
let activeSocket: FakeSocket | null = null;

vi.mock("socket.io-client", () => ({ io: () => {
  activeSocket = new FakeSocket();
  return activeSocket;
} }));
vi.mock("@/lib/clientApi", () => ({ API_BASE: "http://test.invalid" }));
vi.mock("@/lib/timeseries", () => ({ clientTimezone: () => "UTC" }));
vi.mock("@/components/overlay/useVoiceReadout", () => ({
  useVoiceReadout: () => ({ needsGesture: false, onUserGesture: vi.fn() }),
}));
vi.mock("@/components/overlay/widgets/ScoutingWidget", async () => {
  const { useEffect } = await import("react");
  return { ScoutingWidget: () => {
    useEffect(() => { mounts.scouting(); }, []);
    return <div data-testid="scouting-start">Scouting</div>;
  } };
});
vi.mock("@/components/overlay/widgets/RandomizerWidget", async () => {
  const { useEffect } = await import("react");
  return { RandomizerWidget: ({ live }: { live: { testNonce?: number } | null }) => {
    useEffect(() => { mounts.randomizer(); }, []);
    return <div data-testid="randomizer-start" data-test-nonce={live?.testNonce}>Randomizer</div>;
  } };
});

import { OverlayClient } from "../OverlayClient";
import type { LiveGameEnvelope, LiveGamePayload } from "../overlay/types";

function setup(): FakeSocket {
  render(<OverlayClient token="tok" />);
  const socket = activeSocket as FakeSocket;
  act(() => socket.fire("overlay:config", { enabledWidgets: ["scouting", "randomizer"] }));
  return socket;
}
function envelope(socket: FakeSocket, over: Partial<LiveGameEnvelope> = {}) {
  act(() => socket.fire("overlay:liveGame", {
    type: "liveGameState", phase: "match_loading", capturedAt: 1,
    gameKey: "game-1", opponent: { name: "Maru", race: "Terran" }, ...over,
  }));
}
function payload(socket: FakeSocket, over: Partial<LiveGamePayload> = {}) {
  act(() => socket.fire("overlay:live", {
    gameKey: "game-1", oppName: "Maru", matchup: "PvT", ...over,
  }));
}
function advance(ms: number) { act(() => vi.advanceTimersByTime(ms)); }
function randomizerVisible(): boolean {
  return screen.getByTestId("randomizer-start").parentElement?.style.display !== "none";
}
function expectStartHidden() {
  expect(screen.queryByTestId("scouting-start")).toBeNull();
  expect(randomizerVisible()).toBe(false);
}

describe("OverlayClient game-start deduplication", () => {
  beforeEach(() => {
    activeSocket = null;
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("starts scouting at match start and preserves its deadline through enrichment", () => {
    const socket = setup();
    envelope(socket);
    expect(screen.queryByTestId("scouting-start")).toBeNull();
    expect(randomizerVisible()).toBe(true);
    advance(10_000);
    payload(socket);
    expect(screen.queryByTestId("scouting-start")).toBeNull();
    envelope(socket, { phase: "match_started", capturedAt: 2 });
    expect(screen.queryByTestId("scouting-start")).not.toBeNull();
    payload(socket);
    advance(5_000);
    expect(screen.queryByTestId("scouting-start")).not.toBeNull();
    expect(randomizerVisible()).toBe(true);
    envelope(socket, {
      phase: "match_in_progress", capturedAt: 3,
      streamerHistory: { oppName: "Maru", matchup: "PvT" },
    });
    advance(10_000);
    expect(screen.queryByTestId("scouting-start")).toBeNull();
    expect(randomizerVisible()).toBe(true);
    advance(7_000);
    expectStartHidden();
    payload(socket);
    envelope(socket, { phase: "match_in_progress", capturedAt: 4 });
    expectStartHidden();
    expect(mounts.scouting).toHaveBeenCalledTimes(1);
    expect(mounts.randomizer).toHaveBeenCalledTimes(1);
  });

  it("does not restart or remount the reveal on a same-key menu interruption", () => {
    const socket = setup();
    envelope(socket, { phase: "match_started" });
    advance(10_000);
    envelope(socket, { phase: "menu", capturedAt: 2 });
    advance(3_000);
    envelope(socket, { phase: "match_started", capturedAt: 3 });
    advance(2_000);
    expect(screen.queryByTestId("scouting-start")).toBeNull();
    advance(17_000);
    expectStartHidden();
    envelope(socket, { phase: "idle", capturedAt: 4 });
    envelope(socket, { phase: "match_in_progress", capturedAt: 5 });
    expectStartHidden();
    expect(mounts.scouting).toHaveBeenCalledTimes(1);
    expect(mounts.randomizer).toHaveBeenCalledTimes(1);
  });

  it("ignores same-key reconnect preludes after the start windows expired", () => {
    const socket = setup();
    envelope(socket, { phase: "match_started" });
    advance(33_000);
    envelope(socket, { phase: "match_ended", capturedAt: 2 });
    envelope(socket, { synthetic: true, opponent: undefined, capturedAt: 2 });
    envelope(socket, { phase: "match_in_progress", capturedAt: 2 });
    expectStartHidden();
    expect(mounts.scouting).toHaveBeenCalledTimes(1);
    expect(mounts.randomizer).toHaveBeenCalledTimes(1);
  });

  it("keeps the original start deadlines through a keyless active partial", () => {
    const socket = setup();
    envelope(socket, { phase: "match_started" });
    advance(10_000);
    envelope(socket, { gameKey: undefined, synthetic: true, opponent: undefined });
    envelope(socket, { phase: "match_started", capturedAt: 2 });
    advance(5_000);
    expect(screen.queryByTestId("scouting-start")).toBeNull();
    expect(randomizerVisible()).toBe(true);
    advance(17_000);
    expectStartHidden();
    expect(mounts.scouting).toHaveBeenCalledTimes(1);
    expect(mounts.randomizer).toHaveBeenCalledTimes(1);
  });

  it("does not rearm an expired start when recovery briefly lacks a key", () => {
    const socket = setup();
    envelope(socket, { phase: "match_started" });
    advance(33_000);
    envelope(socket, { gameKey: undefined, synthetic: true, opponent: undefined });
    expectStartHidden();
    envelope(socket, { phase: "match_in_progress", capturedAt: 2 });
    expectStartHidden();
    expect(mounts.scouting).toHaveBeenCalledTimes(1);
    expect(mounts.randomizer).toHaveBeenCalledTimes(1);
  });

  it("ignores duplicate resultless live payloads when the agent is offline", () => {
    const socket = setup();
    payload(socket);
    advance(33_000);
    payload(socket);
    expectStartHidden();
    expect(mounts.scouting).toHaveBeenCalledTimes(1);
  });

  it("rearms both start windows for the next game without a menu phase", () => {
    const socket = setup();
    envelope(socket, { phase: "match_started" });
    advance(33_000);
    envelope(socket, { gameKey: "game-2", capturedAt: 2 });
    expect(screen.queryByTestId("scouting-start")).toBeNull();
    expect(randomizerVisible()).toBe(true);
    envelope(socket, { gameKey: "game-2", phase: "match_started", capturedAt: 3 });
    expect(screen.queryByTestId("scouting-start")).not.toBeNull();
    expect(randomizerVisible()).toBe(true);
    expect(mounts.scouting).toHaveBeenCalledTimes(2);
    expect(mounts.randomizer).toHaveBeenCalledTimes(1);
    advance(32_000);
    expectStartHidden();
  });

  it("ignores synthetic loading and ended reconnect snapshots until a confirmed start", () => {
    const socket = setup();
    envelope(socket, { synthetic: true, opponent: undefined });
    expect(screen.queryByTestId("scouting-start")).toBeNull();
    envelope(socket, { phase: "match_ended", capturedAt: 2 });
    expect(screen.queryByTestId("scouting-start")).toBeNull();
    advance(5_000);
    envelope(socket, { phase: "match_in_progress", capturedAt: 3 });
    expect(screen.queryByTestId("scouting-start")).not.toBeNull();
    advance(15_000);
    expect(screen.queryByTestId("scouting-start")).toBeNull();
    expect(mounts.scouting).toHaveBeenCalledTimes(1);
  });

  it("waits for a named opponent and ignores replay starts", () => {
    const socket = setup();
    envelope(socket, { phase: "match_started", opponent: undefined });
    expect(screen.queryByTestId("scouting-start")).toBeNull();
    envelope(socket, { phase: "match_in_progress", isReplay: true, capturedAt: 2 });
    expect(screen.queryByTestId("scouting-start")).toBeNull();
    envelope(socket, { phase: "match_in_progress", capturedAt: 3 });
    expect(screen.queryByTestId("scouting-start")).not.toBeNull();
    expect(mounts.scouting).toHaveBeenCalledTimes(1);
  });

  it("keeps the scouting deadline when a keyless confirmed start gains its match key", () => {
    const socket = setup();
    envelope(socket, { phase: "match_started", gameKey: undefined });
    expect(screen.queryByTestId("scouting-start")).not.toBeNull();
    advance(10_000);
    envelope(socket, { phase: "match_in_progress", capturedAt: 2 });
    advance(5_000);
    expect(screen.queryByTestId("scouting-start")).toBeNull();
    envelope(socket, { phase: "menu", capturedAt: 3 });
    envelope(socket, { phase: "match_in_progress", capturedAt: 4 });
    expect(screen.queryByTestId("scouting-start")).toBeNull();
    expect(mounts.scouting).toHaveBeenCalledTimes(1);
  });

  it("allows each explicit Test nonce once and keeps duplicate Test deadlines", () => {
    const socket = setup();
    payload(socket, { isTest: true, testNonce: 100, result: "win" });
    advance(10_000);
    payload(socket, { isTest: true, testNonce: 100, result: "win" });
    expect(randomizerVisible()).toBe(true);
    advance(10_000);
    expectStartHidden();
    payload(socket, { isTest: true, testNonce: 100, result: "win" });
    expectStartHidden();
    payload(socket, { isTest: true, testNonce: 101, result: "win" });
    expect(screen.queryByTestId("scouting-start")).not.toBeNull();
    expect(randomizerVisible()).toBe(true);
    expect(mounts.scouting).toHaveBeenCalledTimes(2);
  });

  it("keeps an unrelated per-widget Test out of the mounted randomizer", () => {
    const socket = setup();
    payload(socket, { isTest: true, testNonce: 100, testWidget: "scouting" });
    expect(screen.queryByTestId("scouting-start")).not.toBeNull();
    expect(randomizerVisible()).toBe(false);
    expect(screen.getByTestId("randomizer-start").getAttribute("data-test-nonce")).toBeNull();
  });
});
