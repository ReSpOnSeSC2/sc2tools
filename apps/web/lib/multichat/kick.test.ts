import { afterEach, describe, expect, it, vi } from "vitest";

import { createKickChat } from "./kick";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly sent: string[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  emit(event: string, data: unknown) {
    this.onmessage?.({
      data: JSON.stringify({ event, data: JSON.stringify(data) }),
    });
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }
}

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.unstubAllGlobals();
});

describe("Kick Pusher chat", () => {
  it("forwards documented literal follow and reward frames", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onEvent = vi.fn();
    const onStatus = vi.fn();
    const engine = createKickChat({
      chatroomId: 4242,
      callbacks: { onMessage: vi.fn(), onEvent, onStatus },
      url: "wss://kick.example.test/app",
    });

    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toBe("wss://kick.example.test/app");
    expect(onStatus).toHaveBeenCalledWith("connecting");

    socket.emit("channel.followed", {
      id: "follow-frame-1",
      follower: { username: "NewFollower" },
    });
    socket.emit("channel.reward.redemption.updated", {
      id: "reward-frame-1",
      user: { username: "HydratedViewer" },
      reward: { title: "Hydrate" },
    });

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        platform: "kick",
        id: "follow-frame-1",
        kind: "follow",
        user: "NewFollower",
        detail: "followed",
      }),
    );
    expect(onEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        platform: "kick",
        id: "reward-frame-1",
        kind: "reward",
        user: "HydratedViewer",
        detail: "redeemed Hydrate",
      }),
    );

    // Other dotted Pusher/control events remain outside the platform parser.
    socket.emit("pusher:error", { message: "ignored" });
    socket.emit("channel.unrecognized", { username: "ignored" });
    expect(onEvent).toHaveBeenCalledTimes(2);

    engine.close();
    expect(socket.closed).toBe(true);
  });
});
