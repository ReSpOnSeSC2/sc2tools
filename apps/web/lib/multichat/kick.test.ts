import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createKickChat, KICK_PUSHER_URL } from "./kick";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly sent: string[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
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
    this.onclose?.({ code: 1000 });
  }

  disconnect(code = 1006) {
    this.closed = true;
    this.onclose?.({ code });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("Kick Pusher chat", () => {
  function startChat() {
    const callbacks = { onMessage: vi.fn(), onEvent: vi.fn(), onStatus: vi.fn() };
    const engine = createKickChat({ chatroomId: 4242, callbacks });
    return { engine, socket: FakeWebSocket.instances[0], ...callbacks };
  }

  function startDiscoveredChat() {
    const callbacks = { onMessage: vi.fn(), onEvent: vi.fn(), onStatus: vi.fn() };
    const engine = createKickChat({
      chatroomId: 4242, apiBase: "https://api.example.test/", token: "overlay token", callbacks,
    });
    return { engine, ...callbacks };
  }

  const discoveryResponse = (key: string) => ({
    ok: true,
    json: async () => ({ provider: "pusher", url: `wss://ws-us2.pusher.com/app/${key}?protocol=7` }),
  });

  it("discovers current public credentials before opening the chat socket", async () => {
    const fetchMock = vi.fn().mockResolvedValue(discoveryResponse("newkey"));
    vi.stubGlobal("fetch", fetchMock);
    const { engine } = startDiscoveredChat();
    expect(FakeWebSocket.instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/v1/multichat/overlay%20token/kick/connection",
      { cache: "no-store", signal: expect.any(AbortSignal) },
    );
    expect(FakeWebSocket.instances[0].url).toBe("wss://ws-us2.pusher.com/app/newkey?protocol=7");
    engine.close();
  });

  it("rediscovers a rotated key after the current endpoint is rejected", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(discoveryResponse("oldkey"))
      .mockResolvedValueOnce(discoveryResponse("newkey"));
    vi.stubGlobal("fetch", fetchMock);
    const { engine, onStatus } = startDiscoveredChat();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.instances[0].emit("pusher:error", { code: 4001, message: "App key not in this cluster" });
    expect(onStatus).toHaveBeenLastCalledWith("error", "Kick chat (4001): App key not in this cluster");
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances[1].url).toContain("/app/newkey");
    FakeWebSocket.instances[1].emit("pusher_internal:subscription_succeeded", {});
    expect(onStatus).toHaveBeenLastCalledWith("connected");
    engine.close();
  });

  it.each([
    { ok: false },
    { ok: true, json: async () => ({ provider: "pusher", url: "wss://untrusted.example/app/key" }) },
  ])("uses the verified fallback when discovery is unavailable or invalid", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const { engine } = startDiscoveredChat();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances[0].url).toBe(KICK_PUSHER_URL);
    expect(KICK_PUSHER_URL).not.toContain("32cbd69e4b950bf97679");
    engine.close();
  });

  it("aborts discovery on disposal without opening a late socket", async () => {
    let finish: (value: ReturnType<typeof discoveryResponse>) => void = () => undefined;
    const fetchMock = vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const { engine, onStatus } = startDiscoveredChat();
    engine.close();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    finish(discoveryResponse("latekey"));
    await vi.advanceTimersByTimeAsync(60000);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(onStatus).toHaveBeenCalledTimes(1);
  });

  it("bounds a stalled discovery request before trying the fallback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")));
    })));
    const { engine } = startDiscoveredChat();
    await vi.advanceTimersByTimeAsync(15000);
    expect(FakeWebSocket.instances[0].url).toBe(KICK_PUSHER_URL);
    engine.close();
  });

  it("subscribes after the handshake and becomes connected after acknowledgement", () => {
    const { engine, socket, onStatus } = startChat();
    socket.emit("pusher:connection_established", { socket_id: "1.2" });
    expect(JSON.parse(socket.sent[0])).toEqual({
      event: "pusher:subscribe",
      data: { auth: "", channel: "chatrooms.4242.v2" },
    });
    expect(onStatus).toHaveBeenLastCalledWith("connecting");
    socket.emit("pusher_internal:subscription_succeeded", {});
    expect(onStatus).toHaveBeenLastCalledWith("connected");
    vi.advanceTimersByTime(16000);
    expect(socket.closed).toBe(false);
    socket.emit("pusher:ping", {});
    expect(JSON.parse(socket.sent[1])).toEqual({ event: "pusher:pong", data: {} });
    engine.close();
  });

  it.each([true, false])("surfaces a rejected app key and stops retrying (string payload: %s)", (stringPayload) => {
    const { engine, socket, onStatus } = startChat();
    const rejection = { code: 4001, message: "App key not in this cluster" };
    socket.onmessage?.({ data: JSON.stringify({
      event: "pusher:error",
      data: stringPayload ? JSON.stringify(rejection) : rejection,
    }) });
    expect(onStatus).toHaveBeenLastCalledWith(
      "error", "Kick chat (4001): App key not in this cluster",
    );
    expect(socket.closed).toBe(true);
    vi.advanceTimersByTime(60000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    engine.close();
  });

  it("retries a transient rejection without overwriting its error on close", () => {
    const { engine, socket, onStatus } = startChat();
    socket.emit("pusher:error", { code: 4200, message: "Try again" });
    expect(onStatus).toHaveBeenLastCalledWith("error", "Kick chat (4200): Try again");
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    engine.close();
  });

  it.each([false, true])("times out a stalled connection (handshake received: %s)", (handshake) => {
    const { engine, socket, onStatus } = startChat();
    if (handshake) socket.emit("pusher:connection_established", {});
    vi.advanceTimersByTime(15000);
    expect(onStatus).toHaveBeenLastCalledWith("error", "Kick chat connection timed out; retrying");
    expect(socket.closed).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    // A late callback from the discarded socket cannot clear the new one.
    socket.disconnect();
    socket.emit("pusher_internal:subscription_succeeded", {});
    expect(onStatus).toHaveBeenLastCalledWith("connecting");
    FakeWebSocket.instances[1].emit("pusher_internal:subscription_succeeded", {});
    expect(onStatus).toHaveBeenLastCalledWith("connected");
    vi.advanceTimersByTime(16000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    engine.close();
  });

  it("reports socket failures, backs off, and cancels pending retries on disposal", () => {
    const { engine, socket, onStatus } = startChat();
    socket.disconnect();
    expect(onStatus).toHaveBeenLastCalledWith("error", "Kick chat disconnected; retrying");
    vi.advanceTimersByTime(1000);
    FakeWebSocket.instances[1].disconnect();
    vi.advanceTimersByTime(1999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    FakeWebSocket.instances[2].disconnect();
    engine.close();
    vi.advanceTimersByTime(60000);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("does not retry terminal Pusher close codes", () => {
    const { engine, socket, onStatus } = startChat();
    socket.disconnect(4001);
    expect(onStatus).toHaveBeenLastCalledWith("error", "Kick chat connection rejected (4001)");
    vi.advanceTimersByTime(60000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    engine.close();
  });

  it("handles a browser rejecting WebSocket construction", () => {
    vi.stubGlobal("WebSocket", class {
      constructor() { throw new Error("blocked"); }
    });
    const callbacks = { onMessage: vi.fn(), onStatus: vi.fn() };
    const engine = createKickChat({ chatroomId: 4242, callbacks });
    expect(callbacks.onStatus).toHaveBeenLastCalledWith("error", "Kick chat connection could not start; retrying");
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    engine.close();
  });

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

    // Unknown platform events stay outside the parser.
    socket.emit("channel.unrecognized", { username: "ignored" });
    expect(onEvent).toHaveBeenCalledTimes(2);

    engine.close();
    expect(socket.closed).toBe(true);
  });
});
