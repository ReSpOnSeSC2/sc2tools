import { boundedBlobSink, type ExportSink } from "../exportStream";
import { ExportDownloadError, type ExportFailure } from "../exportErrors";
import type { PackWorkScope } from "./packReaders";

type FileWriter = { write: (chunk: Uint8Array) => Promise<void>; close: () => Promise<void>; abort: () => Promise<void> };
export type PackFileHandle = { createWritable: () => Promise<FileWriter> };
export type PackPicker = (options: { suggestedName: string }) => Promise<PackFileHandle>;
export type PackDestinationEnvironment = { picker?: PackPicker; saveBlob: (blob: Blob, filename: string) => void };
export type PackDestination = { sink: ExportSink; publish: () => void };

function protectSink(inner: ExportSink, scope: PackWorkScope, failed: (code: ExportFailure) => void, written: (bytes: number) => void): ExportSink {
  let aborted: Promise<void> | undefined;
  const run = async (operation: () => Promise<void>) => {
    try { scope.assertCurrent(); await operation(); scope.assertCurrent(); }
    catch (error) { const code = error instanceof ExportDownloadError && error.code === "too_large" ? "too_large" : "failed"; failed(code); throw new ExportDownloadError(code); }
  };
  return { write: chunk => run(async () => { await inner.write(chunk); written(chunk.byteLength); }), close: () => run(() => inner.close()),
    abort: () => aborted ??= Promise.resolve().then(() => inner.abort()) };
}

/** The picker call happens synchronously, before the first await or any JWT/network work. */
export async function startPackDestination(filename: string, environment: PackDestinationEnvironment, scope: PackWorkScope,
  failed: (code: ExportFailure) => void, written: (bytes: number) => void): Promise<PackDestination> {
  let sink: ExportSink | undefined;
  try {
    scope.assertCurrent();
    const picked = environment.picker?.({ suggestedName: filename });
    let blob: ReturnType<typeof boundedBlobSink> | undefined;
    if (picked) {
      const handle = await picked; scope.assertCurrent();
      const writer = await handle.createWritable();
      sink = protectSink({ write: chunk => writer.write(chunk), close: () => writer.close(), abort: () => writer.abort() }, scope, failed, written);
      scope.assertCurrent();
    } else { blob = boundedBlobSink("application/zip"); sink = protectSink(blob, scope, failed, written); }
    return { sink, publish: () => { scope.assertCurrent(); if (blob) environment.saveBlob(blob.blob(), filename); scope.assertCurrent(); } };
  } catch (error) {
    await Promise.allSettled([sink?.abort()]);
    if (scope.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw new ExportDownloadError("cancelled");
    throw error instanceof ExportDownloadError ? error : new ExportDownloadError("failed");
  }
}
