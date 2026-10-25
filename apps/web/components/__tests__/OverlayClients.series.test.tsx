import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SERIES_SAMPLE } from "@/lib/streamSeries";
type Handler = (...args: unknown[]) => void;
class FakeSocket {
  handlers = new Map<string, Set<Handler>>(); outgoing = new Set<Handler>(); disconnected = false;
  connect() {} emit() {} onAnyOutgoing(handler: Handler) { this.outgoing.add(handler); } offAnyOutgoing(handler: Handler) { this.outgoing.delete(handler); }
  on(event: string, handler: Handler) { if (!this.handlers.has(event)) this.handlers.set(event, new Set()); this.handlers.get(event)!.add(handler); if (event === "overlay:multichat") handler({ gameWidgetsPaused: false }); }
  off(event?: string, handler?: Handler) { if (event && handler) this.handlers.get(event)?.delete(handler); }
  disconnect() { this.disconnected = true; }
  fire(event: string, ...args: unknown[]) { for (const handler of this.handlers.get(event) ?? []) handler(...args); }
}
const h = vi.hoisted(() => ({ sockets: [] as FakeSocket[] }));
vi.mock("socket.io-client", () => ({ io: () => { const socket = new FakeSocket(); h.sockets.push(socket); return socket; } }));
vi.mock("@/lib/clientApi", () => ({ API_BASE: "http://test.invalid" }));
vi.mock("@/lib/timeseries", () => ({ clientTimezone: () => "UTC" }));
vi.mock("@/components/overlay/useVoiceReadout", () => ({ useVoiceReadout: () => ({ needsGesture: false, onUserGesture: vi.fn() }) }));
import { OverlayClient } from "../OverlayClient";
import { OverlayWidgetClient } from "../OverlayWidgetClient";
const current = () => h.sockets.at(-1)!;
const real = { ...SERIES_SAMPLE, opponentName: "Recorded opponent", revision: 4 };
beforeEach(() => { h.sockets = []; vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network for Series render"); })); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it.each(["dedicated", "composite"])("%s uses one existing socket and ignores held older snapshots", async surface => {
  render(surface === "dedicated" ? <OverlayWidgetClient token="one" widget="series" /> : <OverlayClient token="one" />);
  act(() => { current().fire("overlay:config", { enabledWidgets: ["series"] }); current().fire("overlay:series", real); });
  await screen.findByText("Recorded opponent"); expect(h.sockets).toHaveLength(1);
  act(() => { current().fire("overlay:series", { ...SERIES_SAMPLE, opponentName: "Old bootstrap", revision: 1 }); current().fire("overlay:series", null); });
  expect(screen.queryByText("Old bootstrap")).toBeNull(); expect(screen.getByText("Recorded opponent")).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});
it("sample and real layers stay separate and Stop restores the newest actual series without writing", async () => {
  render(<OverlayWidgetClient token="one" widget="series" />);
  act(() => { current().fire("overlay:config", { enabledWidgets: ["series"] }); current().fire("overlay:series", real); });
  await screen.findByText("Recorded opponent");
  act(() => current().fire("overlay:live", { isTest: true, testWidget: "series", testNonce: "sample" }));
  await screen.findByText("Sample opponent");
  act(() => current().fire("overlay:series", { ...real, revision: 5, score: { you: 1, opponent: 1 } }));
  act(() => current().fire("overlay:clear", { scope: "test", widget: "series" }));
  await waitFor(() => expect(screen.queryByText("Sample opponent")).toBeNull());
  expect(screen.getByText("Recorded opponent")).toBeTruthy(); expect(screen.getByText("1–1")).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});
it("token switches retire old snapshots, including an A to B to A callback", async () => {
  const view = render(<OverlayWidgetClient token="A" widget="series" />), old = current();
  const held = [...old.handlers.get("overlay:series")!][0];
  act(() => { old.fire("overlay:config", { enabledWidgets: ["series"] }); old.fire("overlay:series", real); });
  await screen.findByText("Recorded opponent");
  view.rerender(<OverlayWidgetClient token="B" widget="series" />); view.rerender(<OverlayWidgetClient token="A" widget="series" />);
  act(() => held({ ...real, opponentName: "Late old account" }));
  expect(screen.queryByText("Recorded opponent")).toBeNull(); expect(screen.queryByText("Late old account")).toBeNull(); expect(old.disconnected).toBe(true);
});
