import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ChatEvent } from "../events";
import type { ChatMessage } from "../types";
import { useEngagementReporter } from "../useEngagementReporter";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("engagement replay suppression", () => {
  it("does not award engagement for late-discovered history newer than the reporter mount", async () => {
    vi.useFakeTimers();
    const mountedAt = Date.now();
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = renderHook(
      ({ messages, events }: { messages: ChatMessage[]; events: ChatEvent[] }) =>
        useEngagementReporter("tok", messages, events),
      { initialProps: { messages: [] as ChatMessage[], events: [] as ChatEvent[] } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    const restoredEvent: ChatEvent = {
      platform: "youtube", id: "portrait:old-support", kind: "superchat",
      user: "Supporter", detail: "sent support", atMs: mountedAt + 40_000, replayed: true,
    };
    const restoredMessage: ChatMessage = {
      platform: "youtube", id: "portrait:old-message", user: "Viewer",
      text: "restored chat", badges: [], atMs: mountedAt + 40_000, backlog: true,
    };
    const liveEvent: ChatEvent = { ...restoredEvent, id: "portrait:new-support", atMs: Date.now(), replayed: false };
    const liveMessage: ChatMessage = { ...restoredMessage, id: "portrait:new-message", atMs: Date.now(), backlog: false };
    rerender({ messages: [restoredMessage, liveMessage], events: [restoredEvent, liveEvent] });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body)).events.map((item: { id: string }) => item.id)).toEqual([
      "portrait:new-message", "ev:portrait:new-support",
    ]);

    // Replayed identities remain seen even if a later live relay copy arrives.
    rerender({ messages: [], events: [{ ...restoredEvent, replayed: false }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
