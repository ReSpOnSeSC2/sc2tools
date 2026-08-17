import { afterEach, describe, expect, it, vi } from "vitest";

import { createTikTokChat } from "./tiktok";

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  emit(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  close() {
    this.closed = true;
  }
}

afterEach(() => {
  FakeEventSource.instances = [];
  vi.unstubAllGlobals();
});

describe("TikTok SSE chat", () => {
  it("forwards chat after the relay reports a green connection", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const onMessage = vi.fn();
    const onEvent = vi.fn();
    const onStatus = vi.fn();
    const engine = createTikTokChat({
      apiBase: "https://api.example.test",
      token: "overlay token",
      username: "@Some.User",
      callbacks: { onMessage, onEvent, onStatus },
    });

    const source = FakeEventSource.instances[0];
    expect(source.url).toBe(
      "https://api.example.test/v1/multichat/overlay%20token/tiktok/stream" +
        "?username=%40Some.User",
    );
    expect(onStatus).toHaveBeenCalledWith("connecting");

    source.emit({ type: "status", state: "connected" });
    source.emit({
      type: "chat",
      session: "room-1",
      message: {
        id: "live-1",
        user: "live_viewer",
        text: "copy that",
        badges: ["moderator", "unknown-new-badge"],
        atMs: 1_786_838_664_165,
      },
    });
    // EventSource reconnects can replay the relay backlog. The engine
    // owns a bounded id set so downstream consumers see this once.
    source.emit({
      type: "chat",
      session: "room-1",
      replay: true,
      message: {
        id: "live-1",
        user: "live_viewer",
        text: "copy that",
        badges: ["moderator"],
        atMs: 1_786_838_664_165,
      },
    });

    expect(onStatus).toHaveBeenLastCalledWith("connected", undefined);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({
      platform: "tiktok",
      id: "room-1:live-1",
      user: "live_viewer",
      text: "copy that",
      badges: ["moderator"],
      atMs: 1_786_838_664_165,
    });

    source.emit({
      type: "chat",
      session: "room-1",
      replay: true,
      message: {
        id: "history-1",
        user: "earlier_viewer",
        text: "sent before this dock attached",
        badges: [],
        atMs: 1_786_838_600_000,
      },
    });
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenLastCalledWith({
      platform: "tiktok",
      id: "room-1:history-1",
      user: "earlier_viewer",
      text: "sent before this dock attached",
      badges: [],
      atMs: 1_786_838_600_000,
      backlog: true,
    });

    source.emit({
      type: "chat",
      session: "room-2",
      message: {
        id: "live-1",
        user: "next_live_viewer",
        text: "same source id in the next broadcast",
        badges: [],
        atMs: 1_786_839_000_000,
      },
    });
    expect(onMessage).toHaveBeenCalledTimes(3);
    expect(onMessage).toHaveBeenLastCalledWith({
      platform: "tiktok",
      id: "room-2:live-1",
      user: "next_live_viewer",
      text: "same source id in the next broadcast",
      badges: [],
      atMs: 1_786_839_000_000,
    });

    source.emit({
      type: "event",
      session: "room-2",
      replay: true,
      event: {
        id: "gift-1",
        kind: "gift",
        user: "supporter",
        detail: "sent a Rose",
        amount: "5 diamonds",
        atMs: 1_786_839_000_100,
      },
    });
    expect(onEvent).toHaveBeenCalledWith({
      platform: "tiktok",
      id: "room-2:gift-1",
      kind: "gift",
      user: "supporter",
      detail: "sent a Rose",
      amount: "5 diamonds",
      atMs: 1_786_839_000_100,
      replayed: true,
    });

    engine.close();
    expect(source.closed).toBe(true);
  });
});
