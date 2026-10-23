import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { OverlayClient } from "@/components/OverlayClient";
import { OverlayWidgetClient } from "@/components/OverlayWidgetClient";
import { localOverlaySample } from "@/lib/overlayDemo.server";
import { TEST_DURATION_MS } from "../widgetLifecycle";

type Handler = (...args: unknown[]) => void;
class FakeSocket {
  handlers = new Map<string, Handler>();
  connect() {} off() {} emit() {} disconnect() {}
  on(event: string, handler: Handler) { this.handlers.set(event, handler); }
  fire(event: string, value: unknown) { this.handlers.get(event)?.(value); }
}
const sockets: FakeSocket[] = [];
vi.mock("socket.io-client", () => ({ io: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; } }));
vi.mock("@/lib/clientApi", () => ({ API_BASE: "http://fixture.invalid" }));
vi.mock("@/lib/timeseries", () => ({ clientTimezone: () => "UTC" }));
vi.mock("@/components/overlay/useVoiceReadout", () => ({ useVoiceReadout: () => ({ needsGesture: false, onUserGesture: vi.fn() }) }));
beforeEach(() => { sockets.length = 0; vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const fire = (event: string, value: unknown) => act(() => { sockets.forEach((socket) => socket.fire(event, value)); });
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const realGame = (name = "RealOpponent") => ({ type: "liveGameState", phase: "match_in_progress", gameKey: "real-game", opponent: { name, race: "Terran" }, capturedAt: 1 });
const realSession = (mmrCurrent = 5432) => ({ wins: 7, losses: 2, games: 9, mmrCurrent, region: "NA" });
function sample() {
  fire("overlay:live", { isTest: true, testNonce: "sample-1", oppName: "SampleOpponent", oppRace: "Zerg", session: { wins: 99, losses: 1, games: 100, mmrCurrent: 9999 } });
  fire("overlay:session", { wins: 99, losses: 1, games: 100, mmrCurrent: 9999, isTest: true, testNonce: "sample-1" });
}
function mount(surface: string) {
  const view = render(surface === "all" ? <OverlayClient token="token" /> : <><OverlayWidgetClient token="token" widget="opponent" /><OverlayWidgetClient token="token" widget="session" /></>);
  fire("overlay:config", { enabledWidgets: ["opponent", "session"] }); fire("overlay:liveGame", realGame()); fire("overlay:session", realSession());
  return view.container;
}
const layer = (container: HTMLElement) => [...container.querySelectorAll('[data-overlay-layer="test"]')].map((node) => node.textContent).join(" ");

describe.each(["all", "dedicated"])("safe samples on %s sources", (surface) => {
  it.each([undefined, "test"])("Stop restores the latest real opponent/session (scope %s)", (scope) => {
    const container = mount(surface), connections = sockets.length;
    const real = container.querySelector<HTMLElement>('[data-overlay-real="opponent"], [data-overlay-layer="real"]')!;
    sample(); expect(layer(container)).toContain("SampleOpponent"); expect(layer(container)).toContain("9999");
    fire("overlay:liveGame", realGame("UpdatedOpponent")); fire("overlay:session", realSession(5555));
    expect(layer(container)).toContain("SampleOpponent"); expect(real.textContent).toContain("UpdatedOpponent"); expect(real.style.display).toBe("none");
    fire("overlay:clear", { scope, widget: null });
    expect(layer(container)).toBe(""); expect(real.style.display).toBe("");
    expect(container.textContent).toContain("UpdatedOpponent"); expect(container.textContent).toContain("5555"); expect(sockets.length).toBe(connections);
  });
  it("expires the sample, retains real updates and rejects duplicate test/session replay", () => {
    const container = mount(surface); sample();
    advance(10_000); sample(); advance(TEST_DURATION_MS - 10_000);
    expect(layer(container)).toBe(""); expect(container.textContent).toContain("RealOpponent"); expect(container.textContent).toContain("5432");
    sample(); expect(layer(container)).toBe("");
  });
  it("a targeted Stop removes only that sample, while unknown scopes never erase live state", () => {
    const container = mount(surface); sample();
    fire("overlay:clear", { scope: "all", widget: null }); expect(layer(container)).toContain("SampleOpponent");
    fire("overlay:clear", { scope: "test", widget: "opponent" });
    expect(layer(container)).not.toContain("SampleOpponent"); expect(layer(container)).toContain("9999");
    fire("overlay:clear", { scope: "test", widget: "session" }); expect(layer(container)).toBe("");
    expect(container.textContent).toContain("RealOpponent"); expect(container.textContent).toContain("5432");
  });
  it("keeps real post-game payload updates underneath a targeted result sample", () => {
    const { container } = render(surface === "all" ? <OverlayClient token="token" /> : <OverlayWidgetClient token="token" widget="match-result" />);
    fire("overlay:config", { enabledWidgets: ["match-result"] });
    fire("overlay:live", { oppName: "RealOpponent", result: "win", map: "RealMapAlpha" });
    fire("overlay:live", { oppName: "SampleOpponent", result: "loss", map: "SampleMapBeta", isTest: true, testNonce: "result-sample", testWidget: "match-result" });
    fire("overlay:live", { oppName: "RealOpponent", result: "win", map: "RealMapOmega" });
    expect(layer(container)).toContain("SampleMapBeta");
    fire("overlay:clear", { scope: "test", widget: "match-result" });
    expect(container.textContent).toContain("RealMapOmega"); expect(container.textContent).not.toContain("SampleMapBeta");
  });
  it("does not restart a real announcement's expired deadline after the sample ends", () => {
    const { container } = render(surface === "all" ? <OverlayClient token="token" /> : <OverlayWidgetClient token="token" widget="match-result" />);
    fire("overlay:config", { enabledWidgets: ["match-result"] });
    fire("overlay:live", { oppName: "RealOpponent", result: "win", map: "RealMap" }); advance(5_000);
    fire("overlay:live", { oppName: "SampleOpponent", result: "loss", map: "SampleMap", isTest: true, testNonce: "timed-result", testWidget: "match-result" });
    advance(TEST_DURATION_MS);
    expect(layer(container)).toBe(""); expect(container.textContent).not.toContain("RealMap"); expect(container.textContent).not.toContain("SampleMap");
  });
});

describe("local sample pages", () => {
  it.each([["opponent", "TestOpponent"], ["multichat", "Test fire! This is how your Twitch chat will look."], ["chat-poll", "Test poll — which matchup next?"], ["supporter-wall", "TestGrinder"]])("%s preview renders sample content without a socket, feed or engagement request", async (widget, text) => {
    const fetch = vi.fn(() => { throw new Error("Preview attempted live network"); }); vi.stubGlobal("fetch", fetch);
    render(<OverlayWidgetClient token="never-used" widget={widget} demo={localOverlaySample(widget)} />);
    expect(screen.getByText("Local preview · sample data")).toBeTruthy();
    expect(screen.getByText(text)).toBeTruthy();
    await act(async () => { await Promise.resolve(); }); advance(TEST_DURATION_MS);
    expect(screen.getByText("Preview finished.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replay sample" }));
    expect(screen.queryByText("Preview finished.")).toBeNull();
    expect(sockets).toHaveLength(0); expect(fetch).not.toHaveBeenCalled();
  });
});
