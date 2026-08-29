import { describe, expect, it, vi } from "vitest";
import {
  createOfficialPlatformEvents,
  parseOfficialPlatformEvent,
} from "./official";

describe("official platform event socket", () => {
  it("accepts the normalized event contract and preserves replay suppression", () => {
    expect(parseOfficialPlatformEvent({
      platform: "twitch",
      id: "follow-1",
      kind: "follow",
      user: "Alpha",
      detail: "followed on Twitch",
      atMs: 123,
      receivedAtMs: 456,
      official: true,
      replayed: true,
      dedupeKey: "support:follow:alpha",
      dedupeWindowMs: 120_000,
    })).toEqual({
      platform: "twitch",
      id: "follow-1",
      kind: "follow",
      user: "Alpha",
      detail: "followed on Twitch",
      atMs: 123,
      receivedAtMs: 456,
      official: true,
      replayed: true,
      dedupeKey: "support:follow:alpha",
      dedupeWindowMs: 120_000,
    });
  });

  it.each([
    null,
    {},
    { platform: "unknown", id: "1", kind: "follow", user: "A", atMs: 1 },
    { platform: "kick", id: "1", kind: "unknown", user: "A", atMs: 1 },
    { platform: "kick", id: "", kind: "follow", user: "A", atMs: 1 },
    { platform: "kick", id: "1", kind: "follow", user: "", atMs: 1 },
  ])("rejects malformed wire payload %#", (value) => {
    expect(parseOfficialPlatformEvent(value)).toBeNull();
  });

  it("uses overlay-token auth, forwards valid events, and detaches cleanly", () => {
    const handlers = new Map<string, (value: unknown) => void>();
    const socket = {
      on: vi.fn((name: string, fn: (value: unknown) => void) => {
        handlers.set(name, fn);
        return socket;
      }),
      off: vi.fn(),
      disconnect: vi.fn(),
    };
    const socketFactory = vi.fn(() => socket);
    const onEvent = vi.fn();
    const engine = createOfficialPlatformEvents({
      apiBase: "https://api.sc2tools.com",
      token: "overlay-token",
      onEvent,
      socketFactory: socketFactory as never,
    });
    expect(socketFactory).toHaveBeenCalledWith(
      "https://api.sc2tools.com",
      expect.objectContaining({ auth: { overlayToken: "overlay-token" } }),
    );
    handlers.get("overlay:platformEvent")?.({
      platform: "youtube",
      id: "subscriber:1",
      kind: "follow",
      user: "Viewer",
      detail: "subscribed on YouTube",
      atMs: 456,
      receivedAtMs: 789,
    });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      platform: "youtube",
      kind: "follow",
      receivedAtMs: 789,
    }));
    handlers.get("overlay:platformEvent")?.({ bad: true });
    expect(onEvent).toHaveBeenCalledTimes(1);
    engine.close();
    expect(socket.off).toHaveBeenCalledWith(
      "overlay:platformEvent",
      handlers.get("overlay:platformEvent"),
    );
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });
});
