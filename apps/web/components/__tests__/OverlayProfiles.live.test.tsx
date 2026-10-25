import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { encodeOverlayTheme } from "@/lib/overlayTheme";

type Handler = (...args: unknown[]) => void;
class Socket {
  handlers = new Map<string, Handler>();
  on(event: string, handler: Handler) { this.handlers.set(event, handler); }
  off() {} emit() {} connect() {} disconnect() {} removeAllListeners() {}
  fire(event: string, payload: unknown) { this.handlers.get(event)?.(payload); }
}
const sockets: Socket[] = [];
const authPackets: Record<string, unknown>[] = [];
vi.mock("socket.io-client", () => ({ io: (_url: string, options: { auth: Record<string, unknown> }) => { authPackets.push(options.auth); const socket = new Socket(); sockets.push(socket); return socket; } }));
vi.mock("@/lib/clientApi", () => ({ API_BASE: "http://test.invalid" }));
vi.mock("@/lib/timeseries", () => ({ clientTimezone: () => "UTC" }));
vi.mock("@/components/overlay/useVoiceReadout", () => ({ useVoiceReadout: () => ({ needsGesture: false }) }));
vi.mock("@/components/overlay/widgets/MmrDeltaWidget", () => ({ MmrDeltaWidget: ({ live }: { live: { mmrDelta?: number } | null }) => live?.mmrDelta != null ? <span data-testid="rating-card">Rating change</span> : null }));
vi.mock("@/components/overlay/scenes/SC2BackdropScene", () => ({
  SC2BackdropScene: ({ accent }: { accent: string }) => <span data-testid="scene-accent">{accent}</span>,
  accentForRace: () => "#a855f7", DEFAULT_BACKDROP_ACCENT: "#3ec0c7", VARIANT_LAYOUT: { "between-games": "frame" },
}));
import { OverlayClient } from "../OverlayClient";
import { OverlayWidgetClient } from "../OverlayWidgetClient";
import { OverlaySceneClient } from "../overlay/scenes/OverlaySceneClient";

const profile = (durationSec = 45, accent = "#abcdef") => ({ v: 1, theme: { accent }, widgetOptions: { "mmr-delta": { durationSec } } });
const config = (socket: Socket, duration = 45, revision = 1, accent = "#abcdef") => act(() => {
  socket.fire("overlay:multichat", { gameWidgetsPaused: false });
  socket.fire("overlay:config", { enabledWidgets: ["mmr-delta"], profile: profile(duration, accent), profileRevision: revision });
});
const live = (socket: Socket, extra = {}) => act(() => socket.fire("overlay:live", { gameKey: "new-game", mmrDelta: 18, oppName: "Synthetic", ...extra }));
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const accent = (container: HTMLElement) => container.querySelector<HTMLElement>('[style*="--ov-accent"]')?.style.getPropertyValue("--ov-accent") || "";
beforeEach(() => { sockets.length = 0; authPackets.length = 0; window.history.replaceState(null, "", "/overlay/one"); vi.useFakeTimers(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false })); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

for (const surface of ["all-in-one", "widget"] as const) describe(`${surface} saved overlay profile`, () => {
  const component = (token = "one", themeParam?: string | null) => surface === "widget" ? <OverlayWidgetClient token={token} widget="mmr-delta" themeParam={themeParam} /> : <OverlayClient token={token} themeParam={themeParam} />;
  it("applies a live theme and production duration, rejects older snapshots, and does not revive an expired card", () => {
    const view = render(component()); const socket = sockets[0];
    config(socket); live(socket); expect(accent(view.container)).toBe("#abcdef");
    advance(11_000); expect(screen.queryByTestId("rating-card")).not.toBeNull();
    config(socket, 60, 2, "#fedcba"); config(socket, 5, 1, "#000000");
    expect(accent(view.container)).toBe("#fedcba"); expect(sockets).toHaveLength(1);
    advance(34_000); expect(screen.queryByTestId("rating-card")).toBeNull();
    config(socket, 60, 3); expect(screen.queryByTestId("rating-card")).toBeNull();
  });
  it("honors short test overrides and caps a 60-second override at the existing test limit", () => {
    render(component()); const socket = sockets[0]; config(socket, 5);
    live(socket, { isTest: true, testWidget: "mmr-delta", testNonce: 1 }); expect(screen.queryByTestId("rating-card")).not.toBeNull();
    advance(5000); expect(screen.queryByTestId("rating-card")).toBeNull();
    config(socket, 60, 2); live(socket, { isTest: true, testWidget: "mmr-delta", testNonce: 2 });
    advance(19_999); expect(screen.queryByTestId("rating-card")).not.toBeNull();
    advance(1); expect(screen.queryByTestId("rating-card")).toBeNull();
  });
  it.each(["", "hostile-css", encodeOverlayTheme({ accent: "#123456" })])("keeps explicit URL theme precedence for %j", themeParam => {
    const view = render(component("one", themeParam)); config(sockets[0]); live(sockets[0]);
    expect(accent(view.container)).toBe(themeParam && themeParam !== "hostile-css" ? "#123456" : "");
  });
  it("cannot apply a previous token's late profile after a warm token change", () => {
    const view = render(component()); const old = sockets[0]; config(old);
    view.rerender(component("two")); const current = sockets.at(-1)!; config(current, 5, 1, "#123456");
    config(old, 60, 50, "#000000"); live(current);
    expect(accent(view.container)).toBe("#123456");
    view.rerender(component("one")); const returned = sockets.at(-1)!;
    config(old, 60, 100, "#000000"); live(returned);
    expect(accent(view.container)).toBe("");
    config(returned, 5, 2, "#654321"); expect(accent(view.container)).toBe("#654321");
  });
});

it("scene sources share live profile precedence and reject a late connect snapshot", () => {
  const view = render(<OverlaySceneClient token="scene" scene="between-games" />); const socket = sockets[0];
  config(socket, 45, 2); config(socket, 5, 1, "#000000");
  expect(screen.getByTestId("scene-accent").textContent).toBe("#abcdef"); expect(accent(view.container)).toBe("#abcdef");
  view.rerender(<OverlaySceneClient token="scene" scene="between-games" themeParam="" />);
  expect(screen.getByTestId("scene-accent").textContent).toBe("#3ec0c7"); expect(accent(view.container)).toBe("");
  expect(sockets).toHaveLength(1);
});

it.each(["session", "scouting", "multichat", "not-supported"])("identifies legacy ?w=%s according to what the composite source renders", widget => {
  window.history.replaceState(null, "", `/overlay/one?w=${widget}`);
  render(<OverlayClient token="one" />);
  expect(authPackets[0]).toMatchObject({ surface: "widget", widget: ["session", "scouting"].includes(widget) ? widget : "unknown" });
});
