import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaygroundWidget, WidgetPlayground } from "./WidgetPlayground";
import { ALL_WIDGETS } from "@/components/overlay/widgetLifecycle";
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

describe("real local widget previews", () => {
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
    fireEvent.click(screen.getByRole("button", { name: /^Replay sample$/ }));
    await act(async () => { vi.advanceTimersByTime(90_000); });
    expectOffline();
  });
});
