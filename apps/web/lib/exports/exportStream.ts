import { ExportDownloadError } from "./exportErrors";
import { ExportNdjson, type ExportFormat } from "./exportNdjson";
export { ExportDownloadError } from "./exportErrors";

export type ExportSink = {
  write: (chunk: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
  abort: () => Promise<void>;
};

export type ExportStreamOptions = {
  signal: AbortSignal;
  assertCurrent: () => void;
  contentType: "application/x-ndjson" | "text/csv" | "application/json";
  onProgress?: (bytes: number) => void;
  ndjson?: ExportFormat;
};

/** The caller owns admission until this promise settles, including abort cleanup. */
export async function writeExportStream(response: Response, sink: ExportSink, options: ExportStreamOptions): Promise<number> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelRead: Promise<void> | undefined, abortSink: Promise<void> | undefined;
  const parser = options.ndjson ? new ExportNdjson(options.ndjson) : null;
  const assertCurrent = () => { options.signal.throwIfAborted(); options.assertCurrent(); };
  const stop = () => {
    if (reader && !cancelRead) cancelRead = Promise.resolve().then(() => reader?.cancel()).then(() => {}, () => {});
    if (!abortSink) abortSink = Promise.resolve().then(() => sink.abort()).then(() => {}, () => {});
  };
  options.signal.addEventListener("abort", stop, { once: true });
  try {
    assertCurrent();
    if (!response.body) throw new ExportDownloadError("incomplete");
    reader = response.body.getReader();
    if (!response.ok) throw new ExportDownloadError("failed");
    if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== options.contentType) {
      throw new ExportDownloadError("invalid");
    }
    let bytes = 0;
    while (true) {
      assertCurrent();
      const item = await reader.read();
      assertCurrent();
      if (item.done) break;
      parser?.push(item.value);
      await sink.write(item.value);
      assertCurrent(); bytes += item.value.byteLength;
      options.onProgress?.(bytes);
    }
    parser?.finish(); assertCurrent();
    await sink.close(); assertCurrent();
    return bytes;
  } catch (error) {
    stop();
    await Promise.allSettled([cancelRead, abortSink]);
    if (options.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw new ExportDownloadError("cancelled");
    throw error instanceof ExportDownloadError ? error : new ExportDownloadError("failed");
  } finally {
    options.signal.removeEventListener("abort", stop);
    try { reader?.releaseLock(); } catch { /* Cleanup cannot replace a fixed public failure with an adapter exception. */ }
  }
}

/** Blob fallback retains a fixed maximum; no artifact is available before close. */
export function boundedBlobSink(contentType: string, maxBytes = 128 * 1024 * 1024): ExportSink & { blob: () => Blob } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 128 * 1024 * 1024) throw new ExportDownloadError("invalid");
  const chunks: ArrayBuffer[] = [];
  let bytes = 0, state: "writing" | "closed" | "aborted" = "writing";
  return {
    async write(chunk) {
      if (state !== "writing") throw new ExportDownloadError("cancelled");
      if (bytes + chunk.byteLength > maxBytes) throw new ExportDownloadError("too_large");
      chunks.push(chunk.slice().buffer as ArrayBuffer); bytes += chunk.byteLength;
    },
    async close() { if (state !== "writing") throw new ExportDownloadError("cancelled"); state = "closed"; },
    async abort() { chunks.length = 0; bytes = 0; state = "aborted"; },
    blob() {
      if (state !== "closed") throw new ExportDownloadError("incomplete");
      return new Blob(chunks, { type: contentType });
    },
  };
}
