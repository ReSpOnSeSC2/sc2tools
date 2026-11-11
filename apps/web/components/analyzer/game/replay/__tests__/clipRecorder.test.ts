import { afterEach, describe, expect, it, vi } from "vitest";
import { createGifWorkerProtocol } from "@/lib/clip/gifWorkerProtocol";
import { clipFrameCount } from "@/lib/clip/clipPlan";
import { ClipError, recordGifClip, recordVideoClip } from "../clip/clipRecorder";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** A Worker stand-in running the real GIF protocol on the next tick. */
function fakeWorker() {
  const worker = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    terminated: false,
    posted: 0,
    terminate() { this.terminated = true; },
    postMessage(message: unknown) {
      this.posted += 1;
      setTimeout(() => protocol.receive(message), 0);
    },
  };
  const protocol = createGifWorkerProtocol((message) => worker.onmessage?.({ data: message } as MessageEvent));
  return worker;
}

/** jsdom's Blob has no arrayBuffer(); FileReader reads it. */
const blobBytes = (blob: Blob) => new Promise<Uint8Array>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
  reader.onerror = () => reject(reader.error);
  reader.readAsArrayBuffer(blob);
});

const pixels = (w: number, h: number) => new Uint8ClampedArray(w * h * 4).fill(200).buffer as ArrayBuffer;

describe("GIF clips", () => {
  it("renders and encodes exactly the planned frames, in order", async () => {
    const worker = fakeWorker();
    const count = clipFrameCount({ start: 100, end: 102 }, 1, 12);
    const rendered: number[] = [];
    const progress: number[] = [];
    const blob = await recordGifClip({
      count, fps: 12, width: 8, height: 6, maxBytes: 1e6, signal: new AbortController().signal,
      onProgress: (done) => progress.push(done),
      frame: (index) => { rendered.push(index); return pixels(8, 6); },
      factory: () => worker as unknown as Worker,
    });
    expect(count).toBe(24);
    expect(rendered).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(progress.at(-1)).toBe(24);
    expect(blob.type).toBe("image/gif");
    const bytes = await blobBytes(blob);
    expect(String.fromCharCode(...bytes.slice(0, 6))).toBe("GIF89a");
    expect(bytes.filter((byte, i) => byte === 0x2c && bytes[i - 1] === 0).length).toBeGreaterThanOrEqual(24);
    expect(worker.terminated).toBe(true);
  });

  it("stops on cancel and terminates the worker", async () => {
    const worker = fakeWorker();
    const controller = new AbortController();
    const run = recordGifClip({
      count: 50, fps: 12, width: 8, height: 6, maxBytes: 1e6, signal: controller.signal, onProgress: () => {},
      frame: (index) => { if (index === 3) controller.abort(); return pixels(8, 6); },
      factory: () => worker as unknown as Worker,
    });
    await expect(run).rejects.toMatchObject({ reason: "cancelled" });
    expect(worker.terminated).toBe(true);
    expect(worker.posted).toBeLessThan(50);
  });

  it("reports a clip past the byte cap as too large", async () => {
    await expect(recordGifClip({
      count: 5, fps: 12, width: 8, height: 6, maxBytes: 100, signal: new AbortController().signal, onProgress: () => {},
      frame: () => pixels(8, 6), factory: () => fakeWorker() as unknown as Worker,
    })).rejects.toBeInstanceOf(ClipError);
  });
});

describe("video clips", () => {
  function videoEnvironment({ manual = true, onStop }: { manual?: boolean; onStop?: () => void } = {}) {
    const requested: number[] = [];
    let frames = 0;
    class FakeRecorder {
      state: "inactive" | "recording" | "paused" = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(readonly stream: unknown, readonly options: { mimeType: string }) {}
      start() { this.state = "recording"; }
      pause() { this.state = "paused"; }
      resume() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        if (onStop) { onStop(); return; }
        this.ondataavailable?.({ data: new Blob([new Uint8Array(manual ? frames : 1)], { type: this.options.mimeType }) });
        this.onstop?.();
      }
      static isTypeSupported() { return true; }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const track = { stop: vi.fn(), ...(manual ? { requestFrame: () => { frames += 1; requested.push(frames); } } : {}) };
    const probe = { stop: vi.fn() };
    const captureStream = vi.fn((fps: number) => {
      const active = fps || manual ? track : probe;
      return { getVideoTracks: () => [active], getTracks: () => [active] };
    });
    const canvas = { captureStream } as unknown as HTMLCanvasElement;
    return { canvas, captureStream, probe, requested, track };
  }

  it("captures one recorder frame per planned frame and releases the stream", async () => {
    const { canvas, requested, track } = videoEnvironment();
    const rendered: number[] = [];
    const blob = await recordVideoClip({
      canvas, count: 6, fps: 500, mime: "video/webm;codecs=vp9", bitsPerSecond: 1e6, maxBytes: 1e6,
      signal: new AbortController().signal, onProgress: () => {}, render: (index) => rendered.push(index),
    });
    expect(rendered).toEqual([0, 1, 2, 3, 4, 5]);
    expect(requested).toHaveLength(6);
    expect(blob.type).toBe("video/webm");
    expect(blob.size).toBe(6);
    expect(track.stop).toHaveBeenCalled();
  });

  it("paces the stream in browsers without requestFrame", async () => {
    const { canvas, captureStream, probe, track } = videoEnvironment({ manual: false });
    const blob = await recordVideoClip({
      canvas, count: 2, fps: 60, mime: "video/webm", bitsPerSecond: 1, maxBytes: 100,
      signal: new AbortController().signal, onProgress: () => {}, render: () => {},
    });
    expect(captureStream.mock.calls).toEqual([[0], [60]]);
    expect(blob.size).toBe(1);
    expect(probe.stop).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("cancels and releases tracks while the recorder is finalizing", async () => {
    const controller = new AbortController();
    const { canvas, track } = videoEnvironment({ onStop: () => controller.abort() });
    await expect(recordVideoClip({
      canvas, count: 2, fps: 500, mime: "video/webm", bitsPerSecond: 1, maxBytes: 100,
      signal: controller.signal, onProgress: () => {}, render: () => {},
    })).rejects.toMatchObject({ reason: "cancelled" });
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("is unsupported without canvas capture, and cancellable mid-recording", async () => {
    const plain = {} as HTMLCanvasElement;
    await expect(recordVideoClip({ canvas: plain, count: 2, fps: 30, mime: "video/webm", bitsPerSecond: 1, maxBytes: 1,
      signal: new AbortController().signal, onProgress: () => {}, render: () => {} })).rejects.toMatchObject({ reason: "unsupported" });
    const { canvas, track } = videoEnvironment();
    const controller = new AbortController();
    await expect(recordVideoClip({ canvas, count: 100, fps: 200, mime: "video/webm", bitsPerSecond: 1, maxBytes: 1e6,
      signal: controller.signal, onProgress: (done) => { if (done === 3) controller.abort(); }, render: () => {} }))
      .rejects.toMatchObject({ reason: "cancelled" });
    expect(track.stop).toHaveBeenCalled();
  });
});
