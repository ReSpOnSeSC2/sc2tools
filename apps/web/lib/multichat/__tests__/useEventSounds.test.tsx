import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendEvents, type ChatEvent } from "../events";
import { useEventSounds } from "../useEventSounds";

const sounder = vi.hoisted(() => ({
  play: vi.fn(),
  close: vi.fn(),
}));

vi.mock("../sound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sound")>();
  return {
    ...actual,
    createEventSounder: () => sounder,
  };
});

const config = { eventSoundsEnabled: true, eventVolume: 70 };

function follow(overrides: Partial<ChatEvent>): ChatEvent {
  return {
    platform: "twitch",
    id: "follow-1",
    kind: "follow",
    user: "Viewer",
    detail: "followed",
    atMs: Date.now(),
    ...overrides,
  };
}

describe("useEventSounds", () => {
  beforeEach(() => vi.clearAllMocks());

  it("never plays replayed events, even when they are near-live", () => {
    const { rerender } = renderHook(
      ({ events }: { events: ChatEvent[] }) => useEventSounds(events, config),
      { initialProps: { events: [] as ChatEvent[] } },
    );
    const replayed = follow({ replayed: true });

    act(() => rerender({ events: [replayed] }));
    expect(sounder.play).not.toHaveBeenCalled();

    // The replay identity is marked seen while silent. A later payload that
    // loses its replay marker cannot turn the retained event into fresh audio.
    act(() => rerender({ events: [{ ...replayed, replayed: false }] }));
    expect(sounder.play).not.toHaveBeenCalled();

    act(() => rerender({ events: [replayed, follow({ id: "live-follow" })] }));
    expect(sounder.play).toHaveBeenCalledOnce();
    expect(sounder.play).toHaveBeenCalledWith("follow");
  });

  it("does not replay audio when a durable official copy replaces public chat", () => {
    const { rerender } = renderHook(
      ({ events }: { events: ChatEvent[] }) => useEventSounds(events, config),
      { initialProps: { events: [] as ChatEvent[] } },
    );
    const direct = follow({
      id: "public-sub",
      kind: "sub",
      dedupeKey: "support:sub:viewer",
      dedupeWindowMs: 120_000,
    });
    const official = {
      ...direct,
      id: "official-sub",
      official: true,
      detail: "subscribed on Twitch",
      atMs: direct.atMs + 200,
    };
    const provisional = appendEvents([], [direct]);
    act(() => rerender({ events: provisional }));
    expect(sounder.play).toHaveBeenCalledTimes(1);

    const durable = appendEvents(provisional, [official]);
    act(() => rerender({ events: durable }));
    expect(sounder.play).toHaveBeenCalledTimes(1);
    expect(durable).toEqual([
      expect.objectContaining({ id: "public-sub", official: true }),
    ]);
  });
});
