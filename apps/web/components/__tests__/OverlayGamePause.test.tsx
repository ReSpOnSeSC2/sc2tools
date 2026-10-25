import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LiveGameEnvelope, LiveGamePayload } from "../overlay/types";
type Handler = (...args: unknown[]) => void;
class Socket {
  handlers = new Map<string, Handler[]>(); outgoing: Handler[] = [];
  on(event: string, handler: Handler) { this.handlers.set(event, [...this.handlers.get(event) || [], handler]); }
  off() {} connect() {} disconnect() {} removeAllListeners() {}
  onAnyOutgoing(handler: Handler) { this.outgoing.push(handler); }
  offAnyOutgoing(handler: Handler) { this.outgoing = this.outgoing.filter(value => value !== handler); }
  emit(event: string) { for (const handler of this.outgoing) handler(event); }
  fire(event: string, value?: unknown) { for (const handler of this.handlers.get(event) || []) handler(value); }
}
const voice = vi.hoisted(() => vi.fn());
const sockets: Socket[] = [];
vi.mock("socket.io-client", () => ({ io: () => { const socket = new Socket(); sockets.push(socket); return socket; } }));
vi.mock("@/lib/clientApi", () => ({ API_BASE: "http://fixture.invalid" }));
vi.mock("@/components/overlay/useVoiceReadout", () => ({ useVoiceReadout: (...args: unknown[]) => { voice(...args); return { needsGesture: false }; } }));
vi.mock("@/components/overlay/useRevealAudioUnlock", () => ({ useRevealAudioUnlock: () => {} }));
vi.mock("@/components/overlay/widgets/MmrDeltaWidget", () => ({ MmrDeltaWidget: ({ live }: { live: LiveGamePayload | null }) => live?.mmrDelta ? <span data-testid="rating-card">Rating change</span> : null }));
vi.mock("@/components/overlay/widgets/SessionWidget", () => ({ SessionWidget: ({ session }: { session: LiveGamePayload["session"] }) => <span data-testid="session-card">{session?.wins} wins</span> }));
vi.mock("@/components/overlay/widgets/MultiChatWidget", () => ({ MultiChatWidget: () => <span>Chat keeps running</span> }));
vi.mock("@/components/overlay/widgets/ScoutingWidget", () => ({ ScoutingWidget: () => <span>Scouting card</span> }));
import { OverlayClient } from "../OverlayClient";
import { OverlayWidgetClient } from "../OverlayWidgetClient";
beforeEach(() => { sockets.length = 0; voice.mockClear(); vi.useFakeTimers(); vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false }))); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const send = (socket: Socket, event: string, value?: unknown) => act(() => socket.fire(event, value));
it.each(["all-in-one", "widget"])("%s waits for saved pause, resumes, and gates reconnect/resync without another socket", surface => {
  render(surface === "all-in-one" ? <OverlayClient token="owner" /> : <OverlayWidgetClient token="owner" widget="mmr-delta" />);
  const socket = sockets[0];
  send(socket, "overlay:config", { enabledWidgets: ["mmr-delta"] });
  send(socket, "overlay:live", { gameKey: "one", mmrDelta: 20, result: "win" });
  expect(screen.queryByTestId("rating-card")).toBeNull();
  send(socket, "overlay:multichat", { gameWidgetsPaused: true }); expect(screen.queryByTestId("rating-card")).toBeNull();
  send(socket, "overlay:multichat", { gameWidgetsPaused: false }); expect(screen.getByTestId("rating-card")).toBeTruthy();
  act(() => socket.emit("overlay:resync")); expect(screen.queryByTestId("rating-card")).toBeNull();
  send(socket, "overlay:multichat", {}); expect(screen.getByTestId("rating-card")).toBeTruthy();
  send(socket, "disconnect"); expect(screen.queryByTestId("rating-card")).toBeNull();
  send(socket, "connect"); send(socket, "overlay:multichat", { gameWidgetsPaused: true }); expect(screen.queryByTestId("rating-card")).toBeNull();
  expect(sockets).toHaveLength(1);
});
it.each(["all-in-one", "widget"])("%s rejects a held pre-reset session event", surface => {
  render(surface === "all-in-one" ? <OverlayClient token="owner" /> : <OverlayWidgetClient token="owner" widget="session" />);
  const socket = sockets[0]; send(socket, "overlay:config", { enabledWidgets: ["session"] }); send(socket, "overlay:multichat", { gameWidgetsPaused: false });
  send(socket, "overlay:session", { wins: 0, losses: 0, games: 0, sessionAnchorAt: "2026-10-25T12:00:00Z" });
  send(socket, "overlay:session", { wins: 20, losses: 2, games: 22 });
  expect(screen.getByTestId("session-card").textContent).toBe("0 wins");
});
it("pauses scouting speech with game cards while chat continues", () => {
  const view = render(<OverlayWidgetClient token="owner" widget="scouting" />); const socket = sockets[0];
  send(socket, "overlay:config", { enabledWidgets: ["scouting"] });
  const live: LiveGameEnvelope = { type: "liveGameState", phase: "match_started", gameKey: "one", capturedAt: 1, opponent: { name: "Opponent", race: "Zerg" } };
  send(socket, "overlay:liveGame", live); expect(voice.mock.calls.at(-1)?.[2]).toBeNull();
  send(socket, "overlay:multichat", { gameWidgetsPaused: false }); expect(voice.mock.calls.at(-1)?.[2]).toMatchObject({ gameKey: "one" });
  send(socket, "overlay:multichat", { gameWidgetsPaused: true }); expect(voice.mock.calls.at(-1)?.[2]).toBeNull();
  view.unmount(); render(<OverlayWidgetClient token="owner" widget="multichat" />);
  send(sockets[1], "overlay:multichat", { gameWidgetsPaused: true }); expect(screen.getByText("Chat keeps running")).toBeTruthy();
});
