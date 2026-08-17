import { afterEach, describe, expect, it, vi } from "vitest";

import { createTwitchChat } from "./twitch";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  emitLines(...lines: string[]) {
    this.onmessage?.({ data: lines.join("\r\n") });
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }
}

function giftNotice(args: {
  id: string;
  notice: "subgift" | "submysterygift";
  originId?: string;
  communityGiftId?: string;
  recipient?: string;
  count?: number;
}): string {
  const tags = [
    "display-name=GiftLord",
    "login=giftlord",
    `id=${args.id}`,
    `msg-id=${args.notice}`,
    ...(args.originId ? [`msg-param-origin-id=${args.originId}`] : []),
    ...(args.communityGiftId
      ? [`msg-param-community-gift-id=${args.communityGiftId}`]
      : []),
    ...(args.recipient
      ? [`msg-param-recipient-display-name=${args.recipient}`]
      : []),
    ...(args.count ? [`msg-param-mass-gift-count=${args.count}`] : []),
    `tmi-sent-ts=${Date.now()}`,
  ];
  return `@${tags.join(";")} :tmi.twitch.tv USERNOTICE #somechannel`;
}

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Twitch community gift correlation", () => {
  it("emits one summary regardless of child order and falls back for an orphan child", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onEvent = vi.fn();
    const engine = createTwitchChat({
      channel: "somechannel",
      callbacks: { onMessage: vi.fn(), onEvent, onStatus: vi.fn() },
      url: "wss://twitch.example.test/irc",
    });
    const socket = FakeWebSocket.instances[0];

    // Normal order: summary is visible once and every linked child is silent.
    socket.emitLines(
      giftNotice({ id: "summary-1", notice: "submysterygift", communityGiftId: "bundle-1", count: 2 }),
      giftNotice({ id: "child-1a", notice: "subgift", originId: "bundle-1", recipient: "LuckyOne" }),
      giftNotice({ id: "child-1b", notice: "subgift", originId: "bundle-1", recipient: "LuckyTwo" }),
      giftNotice({ id: "summary-1-retry", notice: "submysterygift", communityGiftId: "bundle-1", count: 2 }),
    );
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "community-gift:bundle-1",
        detail: "gifted 2 subs",
      }),
    );

    // Defensive out-of-order handling: hold the child until its summary lands.
    socket.emitLines(
      giftNotice({ id: "child-2", notice: "subgift", originId: "bundle-2", recipient: "LuckyThree" }),
    );
    expect(onEvent).toHaveBeenCalledTimes(1);
    socket.emitLines(
      giftNotice({ id: "summary-2", notice: "submysterygift", communityGiftId: "bundle-2", count: 1 }),
    );
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "community-gift:bundle-2",
        detail: "gifted 1 sub",
      }),
    );

    // A source can join mid-bundle and miss the summary. Do not lose that gift:
    // after the correlation window, surface the child with recipient context.
    socket.emitLines(
      giftNotice({ id: "orphan-child", notice: "subgift", originId: "bundle-3", recipient: "SeenViewer" }),
    );
    vi.advanceTimersByTime(1_501);
    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        // Same identity another source's summary would carry, so the
        // engagement API's (platform,id) uniqueness prevents double XP.
        id: "community-gift:bundle-3",
        detail: "gifted a sub to SeenViewer",
      }),
    );
    // If its summary arrives exceptionally late, the recognized fallback wins;
    // never alert/credit the same community gift twice.
    socket.emitLines(
      giftNotice({ id: "late-summary", notice: "submysterygift", communityGiftId: "bundle-3", count: 1 }),
    );
    expect(onEvent).toHaveBeenCalledTimes(3);

    // A targeted gift with no community linkage is genuinely standalone.
    socket.emitLines(
      giftNotice({ id: "standalone", notice: "subgift", recipient: "SoloViewer" }),
    );
    expect(onEvent).toHaveBeenCalledTimes(4);
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ detail: "gifted a sub to SoloViewer" }),
    );

    engine.close();
    expect(socket.closed).toBe(true);
  });
});
