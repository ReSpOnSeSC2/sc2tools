import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatAlertsWidget } from "../ChatAlertsWidget";
import { DEFAULT_ALERTS } from "@/lib/multichat/alerts";
import { DEFAULT_SOUND } from "@/lib/multichat/sound";
import { DEFAULT_APPEARANCE } from "@/lib/multichat/appearance";
import { DEFAULT_STUDIO_STATE } from "@/lib/multichat/useStudioState";
import type { ChatEvent } from "@/lib/multichat/events";
import { sanitizeGameMomentConfig } from "@/lib/gameMoments";
const fixture = vi.hoisted(() => ({ config: {} as Record<string, unknown>, studio: {} as Record<string, unknown>, events: [] as ChatEvent[], messages: [], play: vi.fn(), close: vi.fn(), reporter: vi.fn() }));
vi.mock("@/components/overlay/widgets/MultiChatWidget", () => ({ useMultichatConfig: () => fixture.config, MultiChatWidget: () => null }));
vi.mock("@/lib/multichat/useMultiChat", () => ({ useMultiChat: () => ({ events: fixture.events, messages: fixture.messages }) }));
vi.mock("@/lib/multichat/useStudioState", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/multichat/useStudioState")>(), useStudioState: () => fixture.studio }));
vi.mock("@/lib/multichat/useEngagementReporter", () => ({ useEngagementReporter: (...args: unknown[]) => fixture.reporter(...args) }));
vi.mock("@/lib/multichat/useAlertMediaGrant", () => ({ useOverlayAlertMediaGrant: () => {} }));
vi.mock("@/lib/multichat/useTestFireFlag", () => ({ useTestFireFlag: () => false }));
vi.mock("@/components/overlay/useOverlayBuildRefresh", () => ({ overlayFeedTailIsQuiet: () => true, useOverlayBuildRefresh: () => {} }));
vi.mock("@/components/overlay/widgets/widgetAudio", () => ({ useWidgetAudioOwner: () => true, useSpeechSynthesisIdle: () => true }));
vi.mock("@/lib/multichat/sound", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/multichat/sound")>(), createEventSounder: () => ({ play: fixture.play, close: fixture.close }) }));
const NOW = 1_700_000_000_000;
const moment = (gameId = "one") => ({ kind: "winStreak", gameId, atMs: NOW, headline: "Five recorded wins", detail: "Recorded on this ladder account/race." });
const raid = (): ChatEvent => ({ id: "raid", kind: "raid", platform: "twitch", user: "Supporter raid", detail: "brought20 viewers", atMs: Date.now() });
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); fixture.play.mockClear(); fixture.close.mockClear(); fixture.reporter.mockClear(); fixture.events = []; fixture.messages = [];
  fixture.config = { platforms: {}, appearance: DEFAULT_APPEARANCE, loaded: true, sound: { ...DEFAULT_SOUND, eventSoundsEnabled: true },
    alerts: { ...DEFAULT_ALERTS, gameMoments: sanitizeGameMomentConfig({ moments: { winStreak: { enabled: true, preset: "classic", sound: "victory" } } }) } };
  fixture.studio = { ...DEFAULT_STUDIO_STATE, snapshotReady: true };
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe("real Ladder/provider alert consumers", () => {
  it("labels recorded moments as Ladder and never submits them as provider intake", () => {
    render(<ChatAlertsWidget token="owner" momentEvent={moment()} />);
    expect(screen.getByText("Five recorded wins")).toBeTruthy(); expect(screen.getByText("Ladder")).toBeTruthy(); expect(screen.queryByText("TW")).toBeNull();
    expect(fixture.play.mock.calls.filter(([kind]) => kind === "reward")).toHaveLength(1);
    expect(fixture.reporter.mock.calls.every(call => (call[2] as unknown[]).length === 0)).toBe(true);
  });
  it("preempts a Ladder toast for a raid, then resumes without replaying its sound", () => {
    const view = render(<ChatAlertsWidget token="owner" momentEvent={moment()} />);
    fixture.events = [raid()]; view.rerender(<ChatAlertsWidget token="owner" momentEvent={moment()} />);
    expect(screen.getByText("Supporter raid")).toBeTruthy(); expect(screen.queryByText("Five recorded wins")).toBeNull();
    act(() => vi.advanceTimersByTime(8000)); expect(screen.getByText("Five recorded wins")).toBeTruthy();
    expect(fixture.play.mock.calls.filter(([kind]) => kind === "reward")).toHaveLength(1);
    expect(fixture.play.mock.calls.filter(([kind]) => kind === "raid")).toHaveLength(1);
  });
  it("consumes duplicate, paused and reset moments without suppressing supporter alerts", () => {
    const view = render(<ChatAlertsWidget token="owner" momentEvent={moment()} />);
    view.rerender(<ChatAlertsWidget token="owner" momentEvent={{ ...moment() }} />); expect(fixture.play.mock.calls.filter(([kind]) => kind === "reward")).toHaveLength(1);
    fixture.studio = { ...fixture.studio, gameWidgetsPaused: true }; view.rerender(<ChatAlertsWidget token="owner" momentEvent={moment("paused")} />);
    expect(screen.queryByText("Five recorded wins")).toBeNull(); fixture.events = [raid()]; view.rerender(<ChatAlertsWidget token="owner" momentEvent={moment("paused")} />); expect(screen.getByText("Supporter raid")).toBeTruthy();
    fixture.studio = { ...fixture.studio, gameWidgetsPaused: false }; act(() => vi.advanceTimersByTime(8000)); view.rerender(<ChatAlertsWidget token="owner" momentEvent={moment("paused")} />); expect(screen.queryByText("Five recorded wins")).toBeNull();
    view.rerender(<ChatAlertsWidget token="owner" momentEvent={moment("new")} />); expect(screen.getByText("Five recorded wins")).toBeTruthy();
    view.rerender(<ChatAlertsWidget token="owner" momentEvent={null} />); expect(screen.queryByText("Five recorded wins")).toBeNull();
    view.rerender(<ChatAlertsWidget token="owner" momentEvent={moment("new")} />); expect(screen.queryByText("Five recorded wins")).toBeNull();
  });
  it("waits for saved settings and discards stale queued moments behind a long supporter queue", () => {
    fixture.config = { ...fixture.config, loaded: false }; const view = render(<ChatAlertsWidget token="owner" momentEvent={moment()} />);
    expect(screen.queryByText("Five recorded wins")).toBeNull(); fixture.config = { ...fixture.config, loaded: true }; fixture.events = [raid()]; view.rerender(<ChatAlertsWidget token="owner" momentEvent={moment()} />);
    act(() => vi.setSystemTime(NOW + 121000)); act(() => vi.advanceTimersByTime(8000)); expect(screen.queryByText("Five recorded wins")).toBeNull();
  });
});
