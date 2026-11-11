import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaygroundWidget, WidgetPlayground } from "./WidgetPlayground";
import { ALL_WIDGETS, type WidgetId } from "@/components/overlay/widgetLifecycle";
import { themeToCssVars } from "@/lib/overlayTheme";
import type { CSSProperties } from "react";
import { MultiChatWidget, ChatOracleWidget, SupporterWallWidget, BuildProfileWidget, StatsTickerWidget } from "@/components/overlay/widgets/PrePostFlow";

const { socket } = vi.hoisted(() => ({ socket: vi.fn(() => { throw new Error("Preview opened a socket"); }) }));
vi.mock("socket.io-client", () => ({ io: socket }));
const fetchSpy = vi.fn(), transport = vi.fn(), speak = vi.fn(), audio = vi.fn();
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-02T12:00:00Z"));
  vi.clearAllMocks();
  fetchSpy.mockRejectedValue(new Error("Preview fetched a resource"));
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal("WebSocket", transport); vi.stubGlobal("EventSource", transport);
  vi.stubGlobal("speechSynthesis", { speak, cancel: vi.fn(), getVoices: () => [], addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("Audio", audio); vi.stubGlobal("AudioContext", audio);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  window.history.replaceState(null, "", "/stream-studio/playground?audio=1&voice=1");
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function expectOffline() { expect(fetchSpy).not.toHaveBeenCalled(); expect(socket).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled(); expect(audio).not.toHaveBeenCalled(); expect(speak).not.toHaveBeenCalled(); }

const cardWidgets: WidgetId[] = ["chat-poll", "chat-highlight", "stream-goals", "lower-third", "countdown-timer",
  "supporter-wall", "chat-oracle", "session-recap", "build-profile", "clip-flag", "chat-alerts"];

describe("real local widget previews", () => {
  it.each(cardWidgets)("renders the Large creative frame for %s", async (widget) => {
    const { container } = render(<div style={themeToCssVars({ style: "arena-broadcast", scale: 1.25 }) as CSSProperties}>
      <PlaygroundWidget widget={widget} scenario="victory" />
    </div>);
    await act(async () => { await vi.dynamicImportSettled(); });
    const panel = container.querySelector<HTMLElement>('[data-overlay-panel="framed"]');
    expect(panel).not.toBeNull();
    expect(panel?.style.zoom).toContain("--ov-scale");
    expect(panel?.style.clipPath).toContain("--ov-clip");
    expect(panel?.querySelector<HTMLElement>(".widget-shell__texture")?.style.background).toContain("--ov-texture");
    expect(panel?.querySelector<HTMLElement>(".widget-shell__ornament")?.style.background).toContain("--ov-ornament");
    expectOffline();
  });

  it.each(ALL_WIDGETS)("keeps %s offline through feed refresh and test expiry", async widget => {
    render(<PlaygroundWidget widget={widget} scenario="victory" />);
    await act(async () => { vi.advanceTimersByTime(90_000); });
    expectOffline();
  });
  it.each([MultiChatWidget, ChatOracleWidget, SupporterWallWidget, BuildProfileWidget, StatsTickerWidget])("gives a self-driven demo sample without transport", async Component => {
    const { container } = render(<Component token="never-used" demo />);
    expect(container.textContent?.length).toBeGreaterThan(10);
    await act(async () => { vi.advanceTimersByTime(90_000); });
    expectOffline();
  });
  it("renders the scenario controls and all widgets locally, and replays timed samples", async () => {
    render(<WidgetPlayground initialWidget="unknown" />);
    expect((screen.getByRole("combobox", { name: /^Widget$/ }) as HTMLSelectElement).value).toBe("opponent");
    fireEvent.click(screen.getByRole("button", { name: /^Defeat$/ }));
    expect(screen.getByRole("button", { name: /^Defeat$/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByRole("combobox", { name: /^Widget$/ }), { target: { value: "all" } });
    expect(screen.getAllByRole("img", { name: /sample preview$/ })).toHaveLength(ALL_WIDGETS.length);
    expect(document.querySelectorAll("[inert]")).toHaveLength(ALL_WIDGETS.length);
    fireEvent.change(screen.getByRole("combobox", { name: "Theme preset" }), { target: { value: "arena-broadcast" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Scale" }), { target: { value: "1.25" } });
    const sample = document.querySelector<HTMLElement>("[inert]");
    expect(sample?.style.getPropertyValue("--ov-scale")).toBe("1.25");
    expect(sample?.style.getPropertyValue("--ov-clip")).not.toBe("");
    fireEvent.click(screen.getByRole("button", { name: /^Replay sample$/ }));
    await act(async () => { vi.advanceTimersByTime(90_000); });
    expectOffline();
  });
});
