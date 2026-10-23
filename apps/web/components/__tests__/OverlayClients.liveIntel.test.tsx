import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { LiveGameEnvelope, LiveGamePayload } from "../overlay/types";
import type { WidgetId } from "../overlay/widgetLifecycle";

type Handler = (...args: unknown[]) => void;
class FakeSocket {
  connect() {}
  off() {}
  handlers = new Map<string, Handler>();
  on(event: string, handler: Handler) { this.handlers.set(event, handler); }
  emit() {}
  disconnect() {}
  fire(event: string, value: unknown) { this.handlers.get(event)?.(value); }
}
let socket: FakeSocket;
vi.mock("socket.io-client", () => ({ io: () => (socket = new FakeSocket()) }));
vi.mock("@/lib/clientApi", () => ({ API_BASE: "http://test.invalid" }));
vi.mock("@/lib/timeseries", () => ({ clientTimezone: () => "UTC" }));
vi.mock("@/components/overlay/useVoiceReadout", () => ({
  useVoiceReadout: () => ({ needsGesture: false, onUserGesture: vi.fn() }),
}));
vi.mock("@/components/randomizer/reveals/revealSound", () => ({ useRevealAudioUnlock: vi.fn() }));

import { OverlayClient } from "../OverlayClient";
import { OverlayWidgetClient } from "../OverlayWidgetClient";

const history: NonNullable<LiveGameEnvelope["streamerHistory"]> = {
  oppName: "CurrentOpponent", oppRace: "Terran", matchup: "PvT",
  headToHead: { wins: 4, losses: 2 },
  streak: { kind: "win", count: 3 }, cheeseProbability: 0.8,
  rematch: { isRematch: true }, rival: { name: "CurrentOpponent" },
  meta: { matchup: "PvT", topBuilds: [{ name: "Marine pressure", share: 0.7 }] },
  topBuilds: [{ name: "Blink opener", total: 5, winRate: 0.8 }],
  favOpening: { name: "Marine pressure", share: 0.7, samples: 7 },
  bestAnswer: { build: "Blink opener", total: 5, winRate: 0.8 },
};
function envelope(over: Partial<LiveGameEnvelope> = {}) {
  act(() => socket.fire("overlay:liveGame", {
    type: "liveGameState", phase: "match_started", capturedAt: 1,
    gameKey: "game-1", opponent: { name: "CurrentOpponent", race: "Terran" }, ...over,
  } satisfies LiveGameEnvelope));
}
function advance(ms: number) { act(() => vi.advanceTimersByTime(ms)); }

describe.each(["dedicated", "composite"] as const)("%s live intel widgets", (mode) => {
  function setup(widget: WidgetId) {
    const view = render(mode === "dedicated"
      ? <OverlayWidgetClient token="token" widget={widget} />
      : <OverlayClient token="token" showCredit={false} />);
    act(() => socket.fire("overlay:config", { enabledWidgets: [widget] }));
    return view;
  }
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it.each([
    ["streak", "Hot streak"], ["cheese", "Cheese alert"],
    ["rematch", "Rematch"], ["rival", "Rival"],
    ["meta", "Ladder meta"], ["topbuilds", "Your top builds"],
    ["fav-opening", "Their favorite opener"], ["best-answer", "Best answer"],
  ] as const)("shows %s from cloud history before any replay arrives", (widget, label) => {
    const view = setup(widget);
    envelope({ phase: "match_loading", streamerHistory: history });
    expect(view.container.textContent).not.toContain(label);
    envelope();
    expect(view.container.textContent).toContain(label);
  });

  it("gives late history a full window and never restarts it on ticks or reconnects", () => {
    const view = setup("cheese");
    envelope({ streamerHistory: { oppName: "CurrentOpponent" } });
    advance(20_000);
    envelope({ phase: "match_in_progress", streamerHistory: history });
    expect(view.container.textContent).toContain("Cheese alert");
    advance(10_000);
    envelope({ phase: "match_in_progress" });
    envelope({ phase: "match_in_progress", streamerHistory: history });
    advance(4_999);
    expect(view.container.textContent).toContain("Cheese alert");
    advance(1);
    expect(view.container.textContent).not.toContain("Cheese alert");
    envelope({ phase: "menu" });
    envelope({ phase: "match_loading", synthetic: true });
    envelope({ phase: "match_in_progress", streamerHistory: history });
    expect(view.container.textContent).not.toContain("Cheese alert");
    envelope({ gameKey: "game-2", streamerHistory: history });
    expect(view.container.textContent).toContain("Cheese alert");
  });

  it("keeps top builds persistent during gameplay and clears them in menu", () => {
    const view = setup("topbuilds");
    envelope({ streamerHistory: history });
    advance(90_000);
    expect(view.container.textContent).toContain("Blink opener");
    envelope({ phase: "menu" });
    expect(view.container.textContent).not.toContain("Blink opener");
  });

  it("rejects replay and mismatched-opponent history", () => {
    const view = setup("cheese");
    envelope({ isReplay: true, streamerHistory: history });
    expect(view.container.textContent).not.toContain("Cheese alert");
    envelope({ streamerHistory: { ...history, oppName: "PreviousOpponent" } });
    expect(view.container.textContent).not.toContain("Cheese alert");
    envelope({ streamerHistory: history });
    expect(view.container.textContent).toContain("Cheese alert");
  });

  it.each(["match-result", "post-game", "mmr-delta", "rank"] as const)("keeps %s waiting for replay data", (widget) => {
    const view = setup(widget);
    envelope({ streamerHistory: history });
    expect(view.container.textContent).toBe("");
  });

  it("still renders replay-derived intel after the match ends", () => {
    const view = setup("cheese");
    envelope({ phase: "match_ended" });
    act(() => socket.fire("overlay:live", {
      gameKey: "game-1", oppName: "CurrentOpponent", result: "win", cheeseProbability: 0.9,
    } satisfies LiveGamePayload));
    expect(view.container.textContent).toContain("90%");
  });
});
