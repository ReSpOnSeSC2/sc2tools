/**
 * clipRecorder — turns a deterministic sequence of rendered frames into
 * a video or GIF file, entirely in the browser.
 *
 *   video  ``canvas.captureStream(0)`` + ``MediaRecorder``. With a zero
 *          frame rate the stream only takes a frame when the recorder
 *          asks (``requestFrame``), so every planned frame is captured
 *          exactly once. Browsers without requestFrame use a paced
 *          capture stream. MediaRecorder timestamps frames by wall clock,
 *          so frames are paced at the output rate; a hidden tab pauses
 *          the recorder rather than stretching the video.
 *   GIF    pixels go to a worker (``lib/clip/gifWorker``) a few frames
 *          at a time; rendering never runs ahead of encoding by more
 *          than ``GIF_IN_FLIGHT`` frames, which bounds memory.
 *
 * Both stop on the AbortSignal (Cancel), on the byte cap and on any
 * recorder or worker error, and release every stream, track and worker.
 */

import type { GifWorkerOutput } from "@/lib/clip/gifWorkerProtocol";
import { createGifWorker } from "@/lib/clip/gifWorkerFactory";

export type ClipFailure = "cancelled" | "too_large" | "unsupported" | "failed";

export class ClipError extends Error {
  constructor(readonly reason: ClipFailure) {
    super(`clip_${reason}`);
  }
}

interface ClipRun {
  count: number;
  fps: number;
  signal: AbortSignal;
  onProgress: (done: number, total: number) => void;
  maxBytes: number;
}

/** Frames rendering ahead of the GIF encoder. */
export const GIF_IN_FLIGHT = 3;

const abortable = (signal: AbortSignal, ms: number) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new ClipError("cancelled")); return; }
  const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, Math.max(0, ms));
  const onAbort = () => { clearTimeout(timer); reject(new ClipError("cancelled")); };
  signal.addEventListener("abort", onAbort, { once: true });
});

const whenVisible = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new ClipError("cancelled")); return; }
  if (!document.hidden) { resolve(); return; }
  const done = () => { document.removeEventListener("visibilitychange", onChange); signal.removeEventListener("abort", onAbort); };
  const onChange = () => { if (!document.hidden) { done(); resolve(); } };
  const onAbort = () => { done(); reject(new ClipError("cancelled")); };
  document.addEventListener("visibilitychange", onChange);
  signal.addEventListener("abort", onAbort, { once: true });
});

type CaptureCanvas = HTMLCanvasElement & { captureStream?: (frameRate?: number) => MediaStream };
type FrameTrack = MediaStreamTrack & { requestFrame?: () => void };

/** Whether this browser can record a canvas at all. */
export function canRecordVideo(canvas: HTMLCanvasElement | null | undefined): boolean {
  return !!canvas && typeof (canvas as CaptureCanvas).captureStream === "function" && typeof MediaRecorder !== "undefined";
}

function finishRecording(recorder: MediaRecorder, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new ClipError("cancelled")); return; }
    const finish = (error?: ClipError) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      recorder.onstop = null;
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => finish(new ClipError("failed")), 5000);
    const onAbort = () => finish(new ClipError("cancelled"));
    recorder.onstop = () => finish();
    signal.addEventListener("abort", onAbort, { once: true });
    try { recorder.stop(); } catch { finish(new ClipError("failed")); }
  });
}

export async function recordVideoClip(run: ClipRun & {
  canvas: HTMLCanvasElement;
  render: (index: number) => void;
  mime: string;
  bitsPerSecond: number;
}): Promise<Blob> {
  const canvas = run.canvas as CaptureCanvas;
  if (!canRecordVideo(canvas)) throw new ClipError("unsupported");
  run.render(0);
  let stream: MediaStream | undefined;
  const release = () => stream?.getTracks().forEach((track) => track.stop());
  let recorder: MediaRecorder;
  let requestFrame: (() => void) | undefined;
  try {
    stream = canvas.captureStream!(0);
    const track = stream.getVideoTracks()[0] as FrameTrack | undefined;
    if (typeof track?.requestFrame === "function") {
      requestFrame = track.requestFrame.bind(track);
    } else {
      release();
      stream = undefined;
      stream = canvas.captureStream!(run.fps);
      if (!stream.getVideoTracks().length) throw new ClipError("unsupported");
    }
    recorder = new MediaRecorder(stream, { mimeType: run.mime, videoBitsPerSecond: run.bitsPerSecond });
  } catch (error) {
    release();
    throw error instanceof ClipError ? error : new ClipError("unsupported");
  }
  const chunks: Blob[] = [];
  let bytes = 0;
  let failure: ClipError | null = null;
  recorder.ondataavailable = (event) => {
    if (!event.data || event.data.size === 0) return;
    chunks.push(event.data);
    bytes += event.data.size;
    if (bytes > run.maxBytes) failure ??= new ClipError("too_large");
  };
  recorder.onerror = () => { failure ??= new ClipError("failed"); };
  const frameMs = 1000 / run.fps;
  try {
    recorder.start(1000);
    let base = performance.now();
    for (let i = 0; i < run.count; i += 1) {
      if (failure) throw failure;
      if (document.hidden && recorder.state === "recording") {
        const pausedAt = performance.now();
        recorder.pause();
        await whenVisible(run.signal);
        recorder.resume();
        base += performance.now() - pausedAt;
      }
      await abortable(run.signal, base + i * frameMs - performance.now());
      if (i > 0) run.render(i);
      requestFrame?.();
      run.onProgress(i + 1, run.count);
    }
    // The last frame needs its own duration before the file closes.
    await abortable(run.signal, frameMs);
    if (failure) throw failure;
    await finishRecording(recorder, run.signal);
    if (failure) throw failure;
    if (!bytes) throw new ClipError("failed");
    return new Blob(chunks, { type: run.mime.split(";")[0] });
  } catch (error) {
    throw error instanceof ClipError ? error : new ClipError("failed");
  } finally {
    recorder.ondataavailable = null;
    recorder.onerror = null;
    try { if (recorder.state !== "inactive") recorder.stop(); } catch { /* release tracks below */ }
    release();
  }
}


export async function recordGifClip(run: ClipRun & {
  width: number;
  height: number;
  /** Render frame ``index`` and return its RGBA pixels (transferred). */
  frame: (index: number) => ArrayBuffer;
  factory?: () => Worker;
}): Promise<Blob> {
  if (typeof Worker === "undefined" && !run.factory) throw new ClipError("unsupported");
  const worker = (run.factory ?? createGifWorker)();
  let inFlight = 0;
  let wake: (() => void) | null = null;
  let failure: ClipError | null = null;
  let settle!: { resolve: (gif: ArrayBuffer) => void; reject: (error: ClipError) => void };
  const done = new Promise<ArrayBuffer>((resolve, reject) => { settle = { resolve, reject }; });
  done.catch(() => {});
  const fail = (reason: ClipFailure) => {
    if (failure) return;
    failure = new ClipError(reason);
    settle.reject(failure);
    wake?.();
  };
  const onAbort = () => fail("cancelled");
  run.signal.addEventListener("abort", onAbort, { once: true });
  worker.onmessage = (event: MessageEvent<GifWorkerOutput>) => {
    const message = event.data;
    if (message?.type === "frame-done") {
      inFlight -= 1;
      run.onProgress(message.index + 1, run.count);
      const resume = wake;
      wake = null;
      resume?.();
    } else if (message?.type === "done") settle.resolve(message.gif);
    else if (message?.type === "error") fail(message.reason === "too_large" ? "too_large" : "failed");
  };
  worker.onerror = (event) => { event.preventDefault?.(); fail("failed"); };
  try {
    if (run.signal.aborted) throw new ClipError("cancelled");
    worker.postMessage({ type: "start", width: run.width, height: run.height, fps: run.fps, maxBytes: run.maxBytes });
    for (let i = 0; i < run.count; i += 1) {
      if (failure) throw failure;
      const pixels = run.frame(i);
      worker.postMessage({ type: "frame", index: i, rgba: pixels }, [pixels]);
      inFlight += 1;
      while (inFlight >= GIF_IN_FLIGHT && !failure) await new Promise<void>((resolve) => { wake = resolve; });
      // Rendering runs on the main thread: let the page breathe.
      await abortable(run.signal, 0);
    }
    if (failure) throw failure;
    worker.postMessage({ type: "finish" });
    const gif = await done;
    return new Blob([gif], { type: "image/gif" });
  } catch (error) {
    throw error instanceof ClipError ? error : failure ?? new ClipError("failed");
  } finally {
    run.signal.removeEventListener("abort", onAbort);
    worker.terminate();
  }
}
