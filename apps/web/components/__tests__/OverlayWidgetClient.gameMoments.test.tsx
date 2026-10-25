import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ALERTS } from "@/lib/multichat/alerts";
import { DEFAULT_SOUND } from "@/lib/multichat/sound";
import { DEFAULT_APPEARANCE } from "@/lib/multichat/appearance";
import { sanitizeGameMomentConfig } from "@/lib/gameMoments";
type Handler = (...args: unknown[]) => void;
class FakeSocket {
  handlers = new Map<string, Set<Handler>>(); outgoing = new Set<Handler>(); disconnected = false;
  connect() {}
  on(event: string, handler: Handler) { if (!this.handlers.has(event)) this.handlers.set(event, new Set()); this.handlers.get(event)!.add(handler); }
  off(event?: string, handler?: Handler) { if (!event) this.handlers.clear(); else if (handler) this.handlers.get(event)?.delete(handler); }
  onAnyOutgoing(handler: Handler) { this.outgoing.add(handler); }
  offAnyOutgoing(handler: Handler) { this.outgoing.delete(handler); }
  emit(event: string, ...args: unknown[]) { for (const handler of this.outgoing) handler(event, ...args); }
  disconnect() { this.disconnected = true; }
  fire(event: string, ...args: unknown[]) { for (const handler of this.handlers.get(event) ?? []) handler(...args); }
}
const fixture = vi.hoisted(() => ({ sockets: [] as FakeSocket[], config: {} as Record<string, unknown>, play: vi.fn() }));
vi.mock("socket.io-client", () => ({ io: () => { const socket = new FakeSocket(); fixture.sockets.push(socket); return socket; } }));
vi.mock("@/lib/clientApi", () => ({ API_BASE: "http://test.invalid" }));
vi.mock("@/lib/timeseries", () => ({ clientTimezone: () => "UTC" }));
vi.mock("@/components/overlay/widgets/MultiChatWidget", () => ({ useMultichatConfig: () => fixture.config, MultiChatWidget: () => null }));
vi.mock("@/lib/multichat/useMultiChat", () => ({ useMultiChat: () => ({ events: [], messages: [] }) }));
vi.mock("@/lib/multichat/useStudioState", async original => {
  const studioModule = await original<typeof import("@/lib/multichat/useStudioState")>();
  return { ...studioModule, useStudioState: (_token: string, event: { gameWidgetsPaused?: boolean } | null) => ({ ...studioModule.DEFAULT_STUDIO_STATE, snapshotReady: event !== null, gameWidgetsPaused: event?.gameWidgetsPaused === true }) };
});
vi.mock("@/lib/multichat/useEngagementReporter", () => ({ useEngagementReporter: () => {} }));
vi.mock("@/lib/multichat/useAlertMediaGrant", () => ({ useOverlayAlertMediaGrant: () => {} }));
vi.mock("@/components/overlay/useOverlayBuildRefresh", () => ({ overlayFeedTailIsQuiet: () => true, useOverlayBuildRefresh: () => {} }));
vi.mock("@/components/overlay/widgets/widgetAudio", () => ({ useWidgetAudioOwner: () => true, useSpeechSynthesisIdle: () => true }));
vi.mock("@/lib/multichat/sound", async original => ({ ...await original<typeof import("@/lib/multichat/sound")>(), createEventSounder: () => ({ play: fixture.play, close: () => {} }) }));
import { OverlayWidgetClient } from "../OverlayWidgetClient";
const NOW = 1_700_000_000_000;
const moment = (gameId: string) => ({ kind: "winStreak", gameId, atMs: Date.now(), headline: `Moment ${gameId}`, detail: "Recorded ladder history" });
const current = () => fixture.sockets.at(-1)!;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); fixture.sockets = []; fixture.play.mockClear();
  fixture.config = { platforms: {}, appearance: DEFAULT_APPEARANCE, loaded: true, sound: DEFAULT_SOUND,
    alerts: { ...DEFAULT_ALERTS, gameMoments: sanitizeGameMomentConfig({ moments: { winStreak: { enabled: true } } }) } };
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe("actual Browser Source moment subscription", () => {
  it("preserves same-turn replay bursts and uses one socket for the source", () => {
    render(<OverlayWidgetClient token="a" widget="chat-alerts" />);
    act(() => { current().fire("overlay:multichat", { gameWidgetsPaused: false }); for (const id of ["first", "second", "third"]) current().fire("overlay:moment", moment(id)); });
    expect(screen.getByText("Moment first")).toBeTruthy();
    act(() => vi.advanceTimersByTime(8000)); expect(screen.getByText("Moment second")).toBeTruthy();
    act(() => vi.advanceTimersByTime(8000)); expect(screen.getByText("Moment third")).toBeTruthy();
    expect(fixture.sockets).toHaveLength(1);
  });
  it("retires token/widget callbacks and clears queued toasts on resync/disconnect", () => {
    const view = render(<OverlayWidgetClient token="a" widget="chat-alerts" />), old = current();
    const late = [...old.handlers.get("overlay:moment")!][0];
    act(() => { old.fire("overlay:multichat", {}); old.fire("overlay:moment", moment("a")); });
    expect(screen.getByText("Moment a")).toBeTruthy();
    view.rerender(<OverlayWidgetClient token="b" widget="chat-alerts" />);
    expect(screen.queryByText("Moment a")).toBeNull(); expect(old.disconnected).toBe(true);
    act(() => { late(moment("late-a")); current().fire("overlay:multichat", {}); current().fire("overlay:moment", moment("b")); });
    expect(screen.queryByText("Moment late-a")).toBeNull(); expect(screen.getByText("Moment b")).toBeTruthy();
    act(() => current().emit("overlay:resync")); expect(screen.queryByText("Moment b")).toBeNull();
    act(() => { current().fire("overlay:multichat", {}); current().fire("overlay:moment", moment("b")); });
    expect(screen.queryByText("Moment b")).toBeNull();
    act(() => current().fire("overlay:moment", moment("fresh"))); expect(screen.getByText("Moment fresh")).toBeTruthy();
    act(() => current().fire("disconnect")); expect(screen.queryByText("Moment fresh")).toBeNull();
    const retired = current(); view.rerender(<OverlayWidgetClient token="b" widget="chat-highlight" />);
    expect(retired.disconnected).toBe(true); expect(current().handlers.has("overlay:moment")).toBe(false);
  });
  it("rejects held A callbacks and snapshots after an A to B to A transition", () => {
    const view = render(<OverlayWidgetClient token="a" widget="chat-alerts" />), firstA = current();
    const held = [...firstA.handlers.get("overlay:moment")!][0];
    act(() => { firstA.fire("overlay:multichat", {}); firstA.fire("overlay:moment", moment("old-a")); });
    expect(screen.getByText("Moment old-a")).toBeTruthy();
    view.rerender(<OverlayWidgetClient token="b" widget="chat-alerts" />);
    view.rerender(<OverlayWidgetClient token="a" widget="chat-alerts" />);
    expect(screen.queryByText("Moment old-a")).toBeNull();
    act(() => { held(moment("held-a")); current().fire("overlay:multichat", {}); });
    expect(screen.queryByText("Moment held-a")).toBeNull();
    act(() => current().fire("overlay:moment", moment("current-a")));
    expect(screen.getByText("Moment current-a")).toBeTruthy(); expect(fixture.sockets).toHaveLength(3);
  });
});
