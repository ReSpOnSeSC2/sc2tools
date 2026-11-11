import { boundedBlobSink, ExportDownloadError, writeExportStream, type ExportSink } from "./exportStream";
import type { ExportFormat } from "./exportNdjson";

const EXACT_SUPPLY_ACCEPT = "application/x-ndjson; profile=exact-supply";

type FileWriter = { write: (chunk: Uint8Array) => Promise<void>; close: () => Promise<void>; abort: () => Promise<void> };
type FileHandle = { createWritable: () => Promise<FileWriter> };
type SavePicker = (options: { suggestedName: string }) => Promise<FileHandle>;
export type DownloadRequest = {
  url: string;
  filename: string;
  contentType: "application/json" | "application/x-ndjson" | "text/csv";
  ndjson?: ExportFormat;
  paged?: boolean;
};
export type DownloadScope = {
  token: () => Promise<string | null>;
  signal: AbortSignal;
  assertCurrent: () => void;
  onProgress?: (bytes: number) => void;
};
export type DownloadEnvironment = {
  fetch: typeof fetch;
  picker?: SavePicker;
  saveBlob: (blob: Blob, filename: string) => void;
};

function browserEnvironment(): DownloadEnvironment {
  const pickerWindow = window as Window & { showSaveFilePicker?: SavePicker };
  return {
    fetch: window.fetch.bind(window),
    picker: pickerWindow.showSaveFilePicker?.bind(window),
    saveBlob(blob, filename) {
      const url = URL.createObjectURL(blob), anchor = document.createElement("a");
      try {
        anchor.href = url; anchor.download = filename;
        document.body.appendChild(anchor); anchor.click();
      } finally { anchor.remove(); URL.revokeObjectURL(url); }
    },
  };
}

function fileSink(writer: FileWriter): ExportSink {
  let aborted: Promise<void> | undefined;
  return { write: chunk => writer.write(chunk), close: () => writer.close(),
    abort: () => aborted ??= Promise.resolve().then(() => writer.abort()) };
}

/** Called synchronously from the admitted click, before JWT work consumes the save-picker gesture. */
export async function downloadExport(request: DownloadRequest, scope: DownloadScope, environment = browserEnvironment()): Promise<{ bytes: number; continuation: string | null }> {
  const assertCurrent = () => { scope.signal.throwIfAborted(); scope.assertCurrent(); };
  let sink: ExportSink | undefined, response: Response | undefined;
  try {
    assertCurrent();
    const handlePromise = environment.picker?.({ suggestedName: request.filename });
    let blobSink: ReturnType<typeof boundedBlobSink> | undefined;
    if (handlePromise) {
      const handle = await handlePromise; assertCurrent();
      sink = fileSink(await handle.createWritable()); assertCurrent();
    } else { blobSink = boundedBlobSink(request.contentType); sink = blobSink; }
    const token = await scope.token(); assertCurrent();
    if (!token) throw new ExportDownloadError("failed");
    const headers = { authorization: `Bearer ${token}`,
      ...(request.ndjson?.format === "sc2tools-build-order-export" ? { accept: EXACT_SUPPLY_ACCEPT } : {}) };
    response = await environment.fetch(request.url, { headers,
      signal: scope.signal, cache: "no-store", credentials: "omit", redirect: "error" });
    assertCurrent();
    let continuation: string | null = null;
    if (request.paged && response.ok) {
      const more = response.headers.get("x-export-has-more"), cursor = response.headers.get("x-export-continuation-token");
      if ((more !== "true" && more !== "false") || (more === "false" && cursor !== null)
        || (more === "true" && (!cursor || cursor.length > 4096 || /[\u0000-\u001f\u007f]/u.test(cursor)))) {
        throw new ExportDownloadError("invalid");
      }
      continuation = cursor;
    }
    const bytes = await writeExportStream(response, sink, { signal: scope.signal, assertCurrent,
      contentType: request.contentType, ndjson: request.ndjson, onProgress: scope.onProgress });
    assertCurrent();
    if (blobSink) environment.saveBlob(blobSink.blob(), request.filename);
    return { bytes, continuation };
  } catch (error) {
    await Promise.allSettled([sink?.abort(), response?.body && !response.body.locked ? response.body.cancel() : undefined]);
    if (scope.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw new ExportDownloadError("cancelled");
    throw error instanceof ExportDownloadError ? error : new ExportDownloadError("failed");
  }
}
