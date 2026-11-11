import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io-client";
import { useTwitchRewardSpeech } from "../useTwitchRewardSpeech";

afterEach(cleanup);

function mount(ready = () => true) {
  const callbacks = new Map<string, (...args: unknown[]) => void>();
  const socket = {
    on: (event: string, callback: (...args: unknown[]) => void) => callbacks.set(event, callback),
    off: (event: string) => callbacks.delete(event),
  } as unknown as Socket;
  const ref = { current: socket };
  const speak = vi.fn(() => true);
  const rendered = renderHook(() => useTwitchRewardSpeech(ref, ready, speak, new Set(["blocked-viewer"])));
  return { callbacks, speak, ...rendered };
}

describe("targeted Twitch reward speech", () => {
  it("only acknowledges a valid live cue as a reward speech request and detaches on cleanup", () => {
    const { callbacks, speak, unmount } = mount();
    const reply = vi.fn();
    callbacks.get("overlay:rewardSpeechReady")?.(reply);
    expect(reply).toHaveBeenLastCalledWith(true);
    callbacks.get("overlay:rewardSpeech")?.({ id: "fixture-1", name: "Viewer", text: "Hello" }, reply);
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({ id: "reward:fixture-1", user: "Viewer", platform: "twitch", text: "Hello" }));
    expect(reply).toHaveBeenLastCalledWith(true);
    unmount(); expect(callbacks.size).toBe(0);
  });

  it("rejects blocked viewers, unsafe cues, and unavailable audio without enqueueing", () => {
    const active = mount(); const inactive = mount(() => false); const reply = vi.fn();
    active.callbacks.get("overlay:rewardSpeech")?.({ id: "fixture-1", name: "@BLOCKED-VIEWER", text: "Hi" }, reply);
    active.callbacks.get("overlay:rewardSpeech")?.({ id: "fixture-2", name: "Viewer", text: "Hello\nworld" }, reply);
    inactive.callbacks.get("overlay:rewardSpeech")?.({ id: "fixture-3", name: "Viewer", text: "Hello" }, reply);
    expect(reply.mock.calls).toEqual([[false], [false], [false]]);
    expect(active.speak).not.toHaveBeenCalled(); expect(inactive.speak).not.toHaveBeenCalled();
  });
});
