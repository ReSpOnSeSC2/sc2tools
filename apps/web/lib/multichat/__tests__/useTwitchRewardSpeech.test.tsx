import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io-client";
import type { ChatMessage } from "../types";
import { useTwitchRewardSpeech } from "../useTwitchRewardSpeech";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function mount(ready = () => true, speak = vi.fn(async (_message: ChatMessage, _signal: AbortSignal) => true)) {
  const callbacks = new Map<string, (...args: unknown[]) => void>();
  const socket = {
    on: (event: string, callback: (...args: unknown[]) => void) => callbacks.set(event, callback),
    off: (event: string) => callbacks.delete(event),
  } as unknown as Socket;
  const rendered = renderHook(() => useTwitchRewardSpeech(socket, ready, speak, new Set(["blocked-viewer"])));
  await vi.dynamicImportSettled();
  const probe = (id: string) => {
    const reply = vi.fn();
    callbacks.get("overlay:rewardSpeechReady")?.(id, reply);
    return reply;
  };
  return { callbacks, speak, probe, ...rendered };
}

const cue = { id: "fixture-1", name: "Viewer", text: "Hello" };

describe("targeted Twitch reward speech", () => {
  it("advertises start-aware readiness, acknowledges the cue result, and detaches on cleanup", async () => {
    const { callbacks, speak, probe, unmount } = await mount();
    const reply = vi.fn();
    expect(probe(cue.id)).toHaveBeenCalledWith("start-ack-v1");
    callbacks.get("overlay:rewardSpeech")?.(cue, reply);
    await waitFor(() => expect(reply).toHaveBeenLastCalledWith(true));
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({ id: "reward:fixture-1", user: "Viewer", platform: "twitch", text: "Hello" }), expect.any(AbortSignal), expect.any(Number));
    unmount(); expect(callbacks.size).toBe(0);
  });

  it("rejects blocked viewers, unsafe cues, and unavailable audio without enqueueing", async () => {
    const active = await mount(); const inactive = await mount(() => false); const reply = vi.fn();
    active.probe("fixture-1");
    active.callbacks.get("overlay:rewardSpeech")?.({ id: "fixture-1", name: "@BLOCKED-VIEWER", text: "Hi" }, reply);
    active.probe("fixture-2");
    active.callbacks.get("overlay:rewardSpeech")?.({ id: "fixture-2", name: "Viewer", text: "Hello\nworld" }, reply);
    expect(inactive.probe("fixture-3")).toHaveBeenCalledWith(false);
    inactive.callbacks.get("overlay:rewardSpeech")?.({ id: "fixture-3", name: "Viewer", text: "Hello" }, reply);
    await waitFor(() => expect(reply.mock.calls).toEqual([[false], [false], [false]]));
    expect(active.speak).not.toHaveBeenCalled(); expect(inactive.speak).not.toHaveBeenCalled();
  });

  it("shares one pending result and remembers a negative result for retransmitted cues", async () => {
    let finish!: (started: boolean) => void;
    const speak = vi.fn((_message: ChatMessage, _signal: AbortSignal) => new Promise<boolean>(resolve => { finish = resolve; }));
    const ready = vi.fn(() => true);
    const { callbacks, probe } = await mount(ready, speak);
    const dispatch = callbacks.get("overlay:rewardSpeech")!;
    const first = vi.fn(), duplicate = vi.fn(), later = vi.fn();
    probe(cue.id);
    dispatch(cue, first);
    await waitFor(() => expect(speak).toHaveBeenCalledOnce());
    ready.mockReturnValue(false);
    dispatch(cue, duplicate);
    expect(first).not.toHaveBeenCalled();
    expect(duplicate).not.toHaveBeenCalled();
    finish(false);
    await waitFor(() => expect(first).toHaveBeenCalledWith(false));
    expect(duplicate).toHaveBeenCalledWith(false);
    ready.mockReturnValue(true);
    dispatch(cue, later);
    await waitFor(() => expect(later).toHaveBeenCalledWith(false));
    expect(speak).toHaveBeenCalledOnce();
  });

  it("aborts an outstanding cue on disconnect", async () => {
    const speak = vi.fn((_message: ChatMessage, signal: AbortSignal) => new Promise<boolean>(resolve => {
      signal.addEventListener("abort", () => resolve(false), { once: true });
    }));
    const { callbacks, probe } = await mount(() => true, speak);
    const reply = vi.fn();
    probe(cue.id);
    callbacks.get("overlay:rewardSpeech")?.(cue, reply);
    await waitFor(() => expect(speak).toHaveBeenCalledOnce());
    callbacks.get("disconnect")?.();
    await waitFor(() => expect(reply.mock.calls).toEqual([[false]]));
  });

  it("refuses unprobed and late socket cues without starting browser speech", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(200);
    const { callbacks, probe, speak } = await mount();
    const reply = vi.fn();
    const dispatch = callbacks.get("overlay:rewardSpeech")!;
    dispatch({ ...cue, id: "unprobed" }, reply);
    expect(probe(cue.id)).toHaveBeenCalledWith("start-ack-v1");
    clock.mockReturnValue(2_000);
    dispatch(cue, reply);
    await waitFor(() => expect(reply.mock.calls).toEqual([[false], [false]]));
    expect(speak).not.toHaveBeenCalled();
  });
});
