import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { LOCKER_VOICE_MAX_BYTES, useLockerVoiceRecorder } from "./useLockerVoiceRecorder";

class FakeRecorder {
  static latest: FakeRecorder;
  static isTypeSupported = () => true;
  state: RecordingState = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() { FakeRecorder.latest = this; }
  start() { this.state = "recording"; }
  stop() { this.state = "inactive"; this.onstop?.(); }
  chunk(size: number) { this.ondataavailable?.({ data: new Blob([new Uint8Array(size)]) }); }
}

function browser() {
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] };
  const getUserMedia = vi.fn(async () => stream);
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("navigator", Object.create(navigator, { mediaDevices: { value: { getUserMedia } } }));
  return { stream, stop, getUserMedia };
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

test("requests the microphone only after Record and stops it at 90 seconds", async () => {
  vi.useFakeTimers();
  const { stop, getUserMedia } = browser();
  const saved = vi.fn();
  const { result } = renderHook(() => useLockerVoiceRecorder(saved));
  expect(getUserMedia).not.toHaveBeenCalled();
  await act(() => result.current.start());
  expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
  expect(result.current.phase).toBe("recording");
  act(() => { FakeRecorder.latest.chunk(1024); vi.advanceTimersByTime(90_000); });
  expect(saved).toHaveBeenCalledWith(expect.objectContaining({ name: "voice-memo.webm", type: "audio/webm;codecs=opus", size: 1024 }));
  expect(result.current.phase).toBe("idle");
  expect(stop).toHaveBeenCalledTimes(1);
});

test("unmount releases a late microphone grant without creating a recorder or attachment", async () => {
  const { stream, stop, getUserMedia } = browser();
  let grant: (() => void) | undefined;
  getUserMedia.mockImplementationOnce(() => new Promise(resolve => { grant = () => resolve(stream); }));
  const saved = vi.fn();
  const { result, unmount } = renderHook(() => useLockerVoiceRecorder(saved));
  let start: Promise<void> | undefined;
  act(() => { start = result.current.start(); });
  expect(result.current.phase).toBe("requesting");
  unmount();
  await act(async () => { grant?.(); await start; });
  expect(stop).toHaveBeenCalledTimes(1);
  expect(saved).not.toHaveBeenCalled();
});

test("a denied or oversize recording leaves the audio file fallback available", async () => {
  const { getUserMedia, stop } = browser();
  getUserMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
  const saved = vi.fn();
  const { result } = renderHook(() => useLockerVoiceRecorder(saved));
  await act(() => result.current.start());
  expect(result.current.error).toContain("attach an audio file");
  await act(() => result.current.start());
  act(() => FakeRecorder.latest.chunk(LOCKER_VOICE_MAX_BYTES + 1));
  expect(result.current.phase).toBe("idle");
  expect(result.current.error).toContain("2.5 MiB");
  expect(stop).toHaveBeenCalledTimes(1);
  expect(saved).not.toHaveBeenCalled();
});
