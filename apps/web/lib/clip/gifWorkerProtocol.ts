/**
 * The message contract between the clip recorder and its GIF worker.
 * Kept separate from the worker glue so it can be exercised directly,
 * without a real Worker:
 *
 *   main → worker  { type: "start", width, height, fps, maxBytes }
 *                  { type: "frame", index, rgba }          (rgba transferred)
 *                  { type: "finish" }
 *   worker → main  { type: "frame-done", index, bytes }
 *                  { type: "done", gif }                   (gif transferred)
 *                  { type: "error", reason }
 *
 * Frames must arrive in order; the size cap is enforced here so a
 * runaway clip stops in the worker rather than after it.
 */

import { GifWriter } from "./gifEncoder";

export type GifWorkerInput =
  | { type: "start"; width: number; height: number; fps: number; maxBytes: number }
  | { type: "frame"; index: number; rgba: ArrayBuffer }
  | { type: "finish" };

export type GifWorkerOutput =
  | { type: "frame-done"; index: number; bytes: number }
  | { type: "done"; gif: ArrayBuffer }
  | { type: "error"; reason: "too_large" | "bad_message" | "failed" };

export function createGifWorkerProtocol(post: (message: GifWorkerOutput, transfer: Transferable[]) => void) {
  let writer: GifWriter | null = null;
  let maxBytes = Infinity;
  let expected = 0;
  let failed = false;
  const fail = (reason: "too_large" | "bad_message" | "failed") => {
    if (failed) return;
    failed = true;
    writer = null;
    post({ type: "error", reason }, []);
  };
  return {
    receive(raw: unknown): void {
      if (failed) return;
      const message = raw as GifWorkerInput | null;
      try {
        if (message?.type === "start" && !writer) {
          writer = new GifWriter(message.width, message.height, message.fps);
          maxBytes = message.maxBytes > 0 ? message.maxBytes : Infinity;
          expected = 0;
          return;
        }
        if (message?.type === "frame" && writer && message.index === expected && message.rgba instanceof ArrayBuffer) {
          writer.addFrame(new Uint8Array(message.rgba));
          expected += 1;
          // Leave space for the GIF trailer added by finish().
          if (writer.byteLength + 1 > maxBytes) { fail("too_large"); return; }
          post({ type: "frame-done", index: message.index, bytes: writer.byteLength }, []);
          return;
        }
        if (message?.type === "finish" && writer && expected > 0) {
          const bytes = writer.finish();
          writer = null;
          post({ type: "done", gif: bytes.buffer as ArrayBuffer }, [bytes.buffer as ArrayBuffer]);
          return;
        }
        fail("bad_message");
      } catch {
        fail("failed");
      }
    },
  };
}
