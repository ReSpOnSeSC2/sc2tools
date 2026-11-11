import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { Socket } from "socket.io-client";
import { useTwitchRewardSpeech } from "@/lib/multichat/useTwitchRewardSpeech";
import type { LiveGamePayload } from "../overlay/types";
import type { SessionSummary } from "../overlay/widgets/SessionWidget";

type SocketHandler = (...args: unknown[]) => void;

class FakeSocket {
  connect() {}
  off(event: string, handler: SocketHandler) { this.handlers.get(event)?.delete(handler); }
  handlers = new Map<string, Set<SocketHandler>>();
  on(event: string, handler: SocketHandler) {
    const listeners = this.handlers.get(event) ?? new Set<SocketHandler>();
    listeners.add(handler);
    this.handlers.set(event, listeners);
  }
  emit() {}
  disconnect() {}
  fire(event: string, ...args: unknown[]) { this.handlers.get(event)?.forEach(handler => handler(...args)); }
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
  MultiChatWidget: ({ session, live, rewardSocket }: { session?: SessionSummary | null; live?: LiveGamePayload | null; rewardSocket?: Socket | null }) => {
    useTwitchRewardSpeech(rewardSocket, () => true, async () => true, new Set());
    return <div data-testid="chat-props">
      {session ? `${session.wins}:${session.losses}` : "no-session"}
      {live?.isTest ? ` demo:${live.testWidget ?? "all"}` : ""}
    </div>;
  },
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
    const real = screen.getByTestId("chat-props");
    act(() => {
      activeSocket.fire("overlay:session", { wins: 3, losses: 2, games: 5 });
      activeSocket.fire("overlay:live", {
        isTest: true,
        testWidget: "multichat",
        session: { wins: 0, losses: 4, games: 4 },
      });
    });
    expect(screen.getAllByTestId("chat-props").map((node) => node.textContent)).toEqual(["3:2", "3:2 demo:multichat"]);
    expect(real.closest<HTMLElement>('[data-overlay-layer="real"]')?.style.display).toBe("none");

    act(() => activeSocket.fire("overlay:clear", { widget: "multichat" }));
    expect(screen.getByTestId("chat-props").textContent).toBe("3:2");
    expect(screen.getByTestId("chat-props")).toBe(real);
    expect(real.closest<HTMLElement>('[data-overlay-layer="real"]')?.style.display).toBe("");
  });

  it("subscribes reward readiness on the initial browser source and detaches during preview", async () => {
    render(<OverlayWidgetClient token="tok-score" widget="multichat" />);
    await act(async () => { await vi.dynamicImportSettled(); });
    const reply = vi.fn();
    activeSocket.fire("overlay:rewardSpeechReady", "fixture-reward", reply);
    expect(reply.mock.calls).toEqual([["start-ack-v1"]]);

    act(() => activeSocket.fire("overlay:live", { isTest: true, testWidget: "multichat" }));
    activeSocket.fire("overlay:rewardSpeechReady", "preview-reward", reply);
    expect(reply.mock.calls).toEqual([["start-ack-v1"]]);
  });
});
