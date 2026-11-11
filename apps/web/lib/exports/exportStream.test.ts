import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadableStream } from "node:stream/web";
import { Blob as NodeBlob } from "node:buffer";
import { TextEncoder } from "node:util";
import { boundedBlobSink, writeExportStream, type ExportSink } from "./exportStream";

const encode = new TextEncoder();
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function response(body: ReadableStream<Uint8Array>, contentType = "text/csv", ok = true): Response {
  return { body, ok, headers: new Headers({ "content-type": contentType }) } as unknown as Response;
}
function memorySink() {
  const chunks: Uint8Array[] = [];
  return { chunks, write: vi.fn(async (chunk: Uint8Array) => { chunks.push(chunk.slice()); }),
    close: vi.fn(async () => {}), abort: vi.fn(async () => { chunks.length = 0; }) } satisfies ExportSink & { chunks: Uint8Array[] };
}
const options = (signal = new AbortController().signal) => ({ signal, assertCurrent: () => {}, contentType: "text/csv" as const });
afterEach(() => vi.unstubAllGlobals());

describe("bounded export output", () => {
  it("waits for output backpressure before pulling another source chunk", async () => {
    const entered = deferred(), written = deferred(); let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      pulls++; controller.enqueue(encode.encode("row\r\n")); if (pulls === 2) controller.close();
    } }, { highWaterMark: 0 });
    const sink = memorySink();
    sink.write.mockImplementationOnce(async () => { entered.resolve(); await written.promise; });
    const work = writeExportStream(response(body), sink, options());
    try {
      await entered.promise; expect(pulls).toBe(1); expect(sink.close).not.toHaveBeenCalled();
      written.resolve(); expect(await work).toBe(10); expect(pulls).toBe(2); expect(sink.close).toHaveBeenCalledOnce();
    } finally { written.resolve(); await work.catch(() => {}); }
  });

  it("retains actual cancellation until held read and sink cleanup both settle", async () => {
    const entered = deferred(), write = deferred(), readCleanup = deferred(), sinkCleanup = deferred();
    const controller = new AbortController(); let settled = false;
    const cancel = vi.fn(() => readCleanup.promise);
    const body = new ReadableStream<Uint8Array>({ pull(source) { source.enqueue(encode.encode("row\n")); }, cancel }, { highWaterMark: 0 });
    const sink = { write: vi.fn(async () => { entered.resolve(); await write.promise; }), close: vi.fn(async () => {}),
      abort: vi.fn(() => sinkCleanup.promise) };
    const work = writeExportStream(response(body), sink, options(controller.signal));
    void work.then(() => { settled = true; }, () => { settled = true; });
    try {
      await entered.promise; controller.abort(); await Promise.resolve(); await Promise.resolve();
      expect(cancel).toHaveBeenCalledOnce(); expect(sink.abort).toHaveBeenCalledOnce();
      write.resolve(); readCleanup.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(settled).toBe(false); expect(sink.close).not.toHaveBeenCalled();
      sinkCleanup.resolve(); await expect(work).rejects.toMatchObject({ code: "cancelled" });
    } finally { write.resolve(); readCleanup.resolve(); sinkCleanup.resolve(); await work.catch(() => {}); }
  });

  it("rejects an old owner ticket after a held read even if the owner name returns", async () => {
    const entered = deferred(), released = deferred(); let retired = false;
    const body = new ReadableStream<Uint8Array>({ async pull(source) {
      entered.resolve(); await released.promise; source.enqueue(encode.encode("private row\n")); source.close();
    } }, { highWaterMark: 0 });
    const sink = memorySink();
    const work = writeExportStream(response(body), sink, { ...options(), assertCurrent: () => {
      if (retired) throw new DOMException("Retired", "AbortError");
    } });
    void work.catch(() => {});
    try {
      await entered.promise; retired = true; released.resolve();
      await expect(work).rejects.toMatchObject({ code: "cancelled" });
      expect(sink.write).not.toHaveBeenCalled(); expect(sink.close).not.toHaveBeenCalled();
    } finally { released.resolve(); await work.catch(() => {}); }
  });

  it("aborts an incomplete NDJSON artifact and never commits it", async () => {
    const body = new ReadableStream<Uint8Array>({ start(source) {
      source.enqueue(encode.encode('{"type":"metadata","format":"sc2tools-account-export","version":1,"userId":"a"}\n'));
      source.close();
    } });
    const sink = memorySink();
    await expect(writeExportStream(response(body, "application/x-ndjson"), sink, { ...options(), contentType: "application/x-ndjson",
      ndjson: { format: "sc2tools-account-export", apiOwner: "a" } })).rejects.toMatchObject({ code: "incomplete" });
    expect(sink.abort).toHaveBeenCalledOnce(); expect(sink.close).not.toHaveBeenCalled(); expect(sink.chunks).toEqual([]);
  });

  it("rejects a wrong media type and never copies private transport exceptions", async () => {
    const wrong = memorySink();
    const html = new ReadableStream<Uint8Array>({ start(source) { source.enqueue(encode.encode("<p>wrong format</p>")); source.close(); } });
    await expect(writeExportStream(response(html, "text/html"), wrong, options())).rejects.toMatchObject({ code: "invalid" });
    expect(wrong.write).not.toHaveBeenCalled();
    const body = new ReadableStream<Uint8Array>({ start(source) { source.error(new Error("Bearer secret/private-url")); } });
    await expect(writeExportStream(response(body), memorySink(), options())).rejects.toMatchObject({ code: "failed", message: "Couldn't complete the export. Please try again." });
  });

  it("caps the fallback, copies retained bytes and hides artifacts until committed", async () => {
    vi.stubGlobal("Blob", NodeBlob);
    const sink = boundedBlobSink("text/csv", 4), source = new Uint8Array([1, 2, 3]);
    expect(() => sink.blob()).toThrow(); await sink.write(source); source.fill(9);
    await sink.close(); expect(new Uint8Array(await sink.blob().arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    const failed = boundedBlobSink("text/csv", 2);
    await expect(failed.write(source)).rejects.toMatchObject({ code: "too_large" });
    await failed.abort(); expect(() => failed.blob()).toThrow();
    expect(() => boundedBlobSink("text/csv", Number.NaN)).toThrow();
  });

  it.each([161, 200, 201])("matches the actual build export game-ID limit at %i characters", async (length) => {
    const rows = [{ type: "metadata", format: "sc2tools-build-order-export", version: 1, games: 1,
      fields: ["gameId", "side", "time", "supply", "name"] },
    { gameId: "g".repeat(length), side: "me", time: 63, supply: 17.5, name: "Marine" },
    { type: "complete", games: 1, events: 1, continuation: null }];
    const body = new ReadableStream<Uint8Array>({ start(source) { source.enqueue(encode.encode(rows.map(row => JSON.stringify(row) + "\n").join(""))); source.close(); } });
    const sink = memorySink();
    const work = writeExportStream(response(body, "application/x-ndjson"), sink, { ...options(), contentType: "application/x-ndjson", ndjson: { format: "sc2tools-build-order-export" } });
    if (length <= 200) { expect(await work).toBeGreaterThan(0); expect(sink.close).toHaveBeenCalledOnce(); }
    else { await expect(work).rejects.toMatchObject({ code: "invalid" }); expect(sink.abort).toHaveBeenCalledOnce(); expect(sink.close).not.toHaveBeenCalled(); }
  });

  it.each([
    { time: 1.5 }, { time: Number.MAX_SAFE_INTEGER + 1 }, { supply: "18" }, { supply: -1 }, { supply: 2001 },
    { side: "opponent", supply: 18 }, { name: "   " }, { name: "private\nrow" },
  ])("rejects malformed version1 build events before commit: %j", async (changed) => {
    const rows = [{ type: "metadata", format: "sc2tools-build-order-export", version: 1, games: 1,
      fields: ["gameId", "side", "time", "supply", "name"] },
    { gameId: "game-a", side: "me", time: 63, supply: null, name: "Marine", ...changed },
    { type: "complete", games: 1, events: 1, continuation: null }];
    const body = new ReadableStream<Uint8Array>({ start(source) { source.enqueue(encode.encode(rows.map(row => JSON.stringify(row) + "\n").join(""))); source.close(); } });
    const sink = memorySink();
    await expect(writeExportStream(response(body, "application/x-ndjson"), sink, { ...options(), contentType: "application/x-ndjson", ndjson: { format: "sc2tools-build-order-export" } })).rejects.toMatchObject({ code: "invalid" });
    expect(sink.close).not.toHaveBeenCalled();
  });
});
