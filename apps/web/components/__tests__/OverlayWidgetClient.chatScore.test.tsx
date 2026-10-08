import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { LiveGamePayload } from "../overlay/types";
import type { SessionSummary } from "../overlay/widgets/SessionWidget";

type SocketHandler = (...args: unknown[]) => void;

class FakeSocket {
  handlers = new Map<string, SocketHandler>();
  on(event: string, handler: SocketHandler) { this.handlers.set(event, handler); }
  emit() {}
  disconnect() {}
  fire(event: string, ...args: unknown[]) { this.handlers.get(event)?.(...args); }
}

let activeSocket: FakeSocket;

vi.mock("socket.io-client", () => ({
  io: () => {
    activeSocket = new FakeSocket();
    return activeSocket;
  },
}));
vi.mock("@/lib/clientApi", () => ({ API_BASE: "http://test.invalid" }));
vi.mock("@/lib/timeseries", () => ({ clientTimezone: () => "UTC" }));
vi.mock("@/components/overlay/widgets/PrePostFlow", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/components/overlay/widgets/PrePostFlow")>(),
  MultiChatWidget: ({ session, live }: { session?: SessionSummary | null; live?: LiveGamePayload | null }) => (
    <div data-testid="chat-props">
      {session ? `${session.wins}:${session.losses}` : "no-session"}
      {live?.isTest ? ` demo:${live.testWidget ?? "all"}` : ""}
    </div>
  ),
}));

import { OverlayWidgetClient } from "../OverlayWidgetClient";

describe("OverlayWidgetClient chat score subscription", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("forwards real session updates and ignores another widget's session Test", () => {
    render(<OverlayWidgetClient token="tok-score" widget="multichat" />);
    act(() => activeSocket.fire("overlay:session", { wins: 3, losses: 2, games: 5 }));
    expect(screen.getByTestId("chat-props").textContent).toBe("3:2");

    act(() => {
      activeSocket.fire("overlay:session", { wins: 99, losses: 99, games: 198, isTest: true });
      activeSocket.fire("overlay:live", {
        isTest: true,
        testWidget: "session",
        session: { wins: 99, losses: 99, games: 198 },
      });
    });
    expect(screen.getByTestId("chat-props").textContent).toBe("3:2");

    act(() => activeSocket.fire("overlay:session", { wins: 4, losses: 2, games: 6 }));
    expect(screen.getByTestId("chat-props").textContent).toBe("4:2");
  });

  it("preserves the real score snapshot when a targeted chat demo is cleared", () => {
    render(<OverlayWidgetClient token="tok-score" widget="multichat" />);
    act(() => {
      activeSocket.fire("overlay:session", { wins: 3, losses: 2, games: 5 });
      activeSocket.fire("overlay:live", {
        isTest: true,
        testWidget: "multichat",
        session: { wins: 0, losses: 4, games: 4 },
      });
    });
    expect(screen.getByTestId("chat-props").textContent).toBe("3:2 demo:multichat");

    act(() => activeSocket.fire("overlay:clear", { widget: "multichat" }));
    expect(screen.getByTestId("chat-props").textContent).toBe("3:2");
  });
});
