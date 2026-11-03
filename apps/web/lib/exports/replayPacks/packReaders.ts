import { ExportDownloadError } from "../exportErrors";

export type PackWorkScope = { signal: AbortSignal; assertCurrent: () => void };

/** Reads and cancellation are both actual awaited operations, even when an adapter ignores abort. */
export async function readPackBytes(response: Response, scope: PackWorkScope, limit: number, expected?: number): Promise<Uint8Array> {
  const current = () => { scope.signal.throwIfAborted(); scope.assertCurrent(); };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, cancelling: Promise<void> | undefined;
  const cancel = () => {
    cancelling ||= Promise.resolve().then(() => reader ? reader.cancel() : response.body && !response.body.locked ? response.body.cancel() : undefined).then(() => {}, () => {});
    return cancelling;
  };
  const stop = () => { void cancel(); };
  scope.signal.addEventListener("abort", stop, { once: true });
  try {
    current();
    if (response.status !== 200 || !response.body) throw new ExportDownloadError("failed");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) {
      current();
      const item = await reader.read();
      current();
      if (item.done) break;
      if (!(item.value instanceof Uint8Array) || item.value.byteLength === 0 || length + item.value.byteLength > limit
        || (expected !== undefined && length + item.value.byteLength > expected)) throw new ExportDownloadError("invalid");
      const copy = new Uint8Array(item.value.byteLength); copy.set(item.value); chunks.push(copy); length += copy.byteLength;
    }
    if (expected !== undefined && length !== expected) throw new ExportDownloadError("incomplete");
    current();
    const result = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    chunks.length = 0;
    return result;
  } catch (error) {
    await cancel();
    throw error instanceof ExportDownloadError ? error : new ExportDownloadError(scope.signal.aborted ? "cancelled" : "failed");
  } finally {
    scope.signal.removeEventListener("abort", stop);
    if (cancelling) await cancelling;
    try { reader?.releaseLock(); } catch { /* A release error cannot reveal adapter details. */ }
  }
}
