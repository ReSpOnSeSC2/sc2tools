// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createZipWorkerProtocol, type ZipInput, type ZipOutput } from "./zipWorkerProtocol";
import { openReplayZip } from "./zipWorkerClient";
import { boundedBlobSink, type ExportSink } from "../exportStream";
import { withExportAdmission, exportBusy } from "../exportAdmission";
import { replayPackManifest, replayPackReadme } from "./packMetadata";

const job = "synthetic-zip-job-01";
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };
const encode = (value: string) => new TextEncoder().encode(value);

/** Protocol mock only: termination records a request; it does not invent a Worker completion event. */
class MockWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly input: ZipInput[] = [];
  readonly output: ZipOutput[] = [];
  readonly terminate = vi.fn(() => { this.stopped = true; });
  private stopped = false;
  private readonly protocol = createZipWorkerProtocol((message, transfer) => {
    const copy = structuredClone(message, { transfer }); this.output.push(copy);
    queueMicrotask(() => { if (!this.stopped) this.onmessage?.({ data: copy } as MessageEvent); });
  });
  constructor(private readonly start = true) {}
  postMessage(message: ZipInput, transfer: Transferable[] = []) {
    if (this.stopped) throw new Error("mock worker no longer accepts messages");
    const copy = structuredClone(message, { transfer }); this.input.push(copy);
    if (this.start) queueMicrotask(() => { if (!this.stopped) void this.protocol.receive(copy).catch(() => this.crash("error")); });
  }
  crash(kind: "error" | "messageerror") {
    if (kind === "error") this.onerror?.({ preventDefault: vi.fn(), message: "private worker URL/signature" } as unknown as ErrorEvent);
    else this.onmessageerror?.({} as MessageEvent);
  }
  preJobMessageError() { try { this.protocol.fatal(); } catch { this.crash("error"); } }
  inject(message: unknown) { this.onmessage?.({ data: message } as MessageEvent); }
  factory = () => this as unknown as Worker;
}

function sink(overrides: Partial<ExportSink> = {}) {
  return { write: vi.fn(overrides.write || (async () => {})), close: vi.fn(overrides.close || (async () => {})), abort: vi.fn(overrides.abort || (async () => {})) };
}
const scope = (signal = new AbortController().signal) => ({ signal, assertCurrent: () => {} });
afterEach(() => { expect(exportBusy()).toBe(false); });

describe("ZIP worker and actual output settlement", () => {
  it("keeps only one chunk pending behind a held sink, copies exact input views and closes only a complete archive", async () => {
    const worker = new MockWorker(), entered = deferred(), written = deferred(), blob = boundedBlobSink("application/zip");
    let calls = 0;
    const output = sink({ write: async chunk => { calls++; if (calls === 1) { entered.resolve(); await written.promise; } await blob.write(chunk); }, close: () => blob.close(), abort: () => blob.abort() });
    const writer = await openReplayZip(output, scope(), { factory: worker.factory, job });
    const backing = new Uint8Array([99, 1, 2, 3, 4, 99]), view = backing.subarray(1, 5);
    const work = writer.entry("one.SC2Replay", view);
    try {
      await entered.promise; await tick(); expect(worker.output.filter(message => message.type === "chunk")).toHaveLength(1);
      expect(worker.input.filter(message => message.type === "ack")).toHaveLength(0); expect(() => blob.blob()).toThrow();
      written.resolve(); await work;
      const input = worker.input.find(message => message.type === "entry");
      expect(input?.type === "entry" && [...new Uint8Array(input.bytes)]).toEqual([1, 2, 3, 4]); expect(backing.byteLength).toBe(6);
      expect(() => blob.blob()).toThrow(); expect(output.close).not.toHaveBeenCalled();
      await writer.entry("manifest.csv", replayPackManifest([{ gameId: "one", filename: "one.SC2Replay", status: "saved" }]), "manifest");
      await writer.entry("README.txt", replayPackReadme({ requested: 1, saved: 1, failed: 0, cancelled: 0 }), "readme");
      await writer.finish(); expect(blob.blob().size).toBeGreaterThan(4); expect(output.close).toHaveBeenCalledOnce();
      expect(worker.output.at(-1)).toEqual({ job, type: "settled", status: "complete" }); expect(worker.terminate).toHaveBeenCalledOnce();
    } finally { written.resolve(); await work; await writer.abort(); }
  });

  it("sink failure sends NACK and keeps browser admission until actual sink abort settles", async () => {
    const worker = new MockWorker(), aborted = deferred(), output = sink({ write: async () => { throw new Error("private sink token"); }, abort: () => aborted.promise });
    const work = withExportAdmission(async () => { const writer = await openReplayZip(output, scope(), { factory: worker.factory, job }); await writer.entry("one.SC2Replay", encode("data")); });
    const observed = work.then(() => null, error => error);
    try {
      await vi.waitFor(() => expect(output.abort).toHaveBeenCalledOnce()); expect(exportBusy()).toBe(true);
      expect(worker.input.some(message => message.type === "nack")).toBe(true);
      await vi.waitFor(() => expect(worker.output.at(-1)).toEqual({ job, type: "settled", status: "failed" }));
      expect(output.close).not.toHaveBeenCalled();
      aborted.resolve(); const error = await observed;
      expect(error.message).toBe("Couldn't complete the export. Please try again."); expect(exportBusy()).toBe(false);
    } finally { aborted.resolve(); await observed; }
  });

  it("abort joins held sink write and abort independently, with no successful ACK or artifact", async () => {
    const worker = new MockWorker(), entered = deferred(), written = deferred(), aborted = deferred(), controller = new AbortController();
    const output = sink({ write: async () => { entered.resolve(); await written.promise; }, abort: () => aborted.promise });
    let settled = false;
    const work = withExportAdmission(async () => { const writer = await openReplayZip(output, scope(controller.signal), { factory: worker.factory, job }); await writer.entry("one.SC2Replay", encode("data")); });
    const observed = work.then(() => { settled = true; }, error => { settled = true; return error; });
    try {
      await entered.promise; controller.abort(); await tick(); expect(settled).toBe(false); expect(exportBusy()).toBe(true);
      expect(worker.output.at(-1)).toEqual({ job, type: "settled", status: "aborted" });
      written.resolve(); await tick(); expect(settled).toBe(false); expect(exportBusy()).toBe(true);
      await expect(withExportAdmission(async () => {})).rejects.toMatchObject({ code: "busy" });
      aborted.resolve(); expect((await observed).message).toBe("Export cancelled.");
      expect(worker.input.some(message => message.type === "ack")).toBe(false); expect(output.close).not.toHaveBeenCalled();
    } finally { controller.abort(); written.resolve(); aborted.resolve(); await observed; }
  });

  it.each(["error", "messageerror"] as const)("worker %s requests termination and still joins held main-thread write/abort", async kind => {
    const worker = new MockWorker(), entered = deferred(), written = deferred(), aborted = deferred();
    const output = sink({ write: async () => { entered.resolve(); await written.promise; }, abort: () => aborted.promise });
    let settled = false;
    const work = withExportAdmission(async () => { const writer = await openReplayZip(output, scope(), { factory: worker.factory, job }); await writer.entry("one.SC2Replay", encode("data")); });
    const observed = work.then(() => { settled = true; }, error => { settled = true; return error; });
    try {
      await entered.promise; worker.crash(kind); await tick(); expect(worker.terminate).toHaveBeenCalledOnce();
      expect(settled).toBe(false); expect(exportBusy()).toBe(true);
      aborted.resolve(); await tick(); expect(settled).toBe(false);
      written.resolve(); const error = await observed; expect(error.message).not.toContain("private"); expect(exportBusy()).toBe(false);
      expect(output.close).not.toHaveBeenCalled(); expect(worker.output.some(message => message.type === "settled")).toBe(false);
    } finally { written.resolve(); aborted.resolve(); await observed; }
  });

  it.each(["constructor", "error", "messageerror", "worker-start-messageerror"] as const)("%s before ready awaits created-sink cleanup and never writes or closes", async failure => {
    const worker = new MockWorker(false), aborted = deferred(), output = sink({ abort: () => aborted.promise });
    const factory = vi.fn(() => { if (failure === "constructor") throw new Error("private CSP or URL"); return worker.factory(); });
    let settled = false;
    const work = withExportAdmission(() => openReplayZip(output, scope(), { factory, job }));
    const observed = work.then(() => { settled = true; }, error => { settled = true; return error; });
    try {
      if (failure === "worker-start-messageerror") worker.preJobMessageError();
      else if (failure !== "constructor") worker.crash(failure);
      await tick(); expect(output.abort).toHaveBeenCalledOnce(); expect(settled).toBe(false); expect(exportBusy()).toBe(true);
      expect(output.write).not.toHaveBeenCalled(); expect(output.close).not.toHaveBeenCalled();
      aborted.resolve(); const error = await observed;
      expect(error.message).toBe("Couldn't complete the export. Please try again."); expect(factory).toHaveBeenCalledOnce();
    } finally { aborted.resolve(); await observed; }
  });

  it("stale nonce messages are ignored and owner retirement during held output cannot ACK or close", async () => {
    const worker = new MockWorker(), entered = deferred(), written = deferred(), aborted = deferred(); let current = true;
    const output = sink({ write: async () => { entered.resolve(); await written.promise; }, abort: () => aborted.promise });
    const writer = await openReplayZip(output, { signal: new AbortController().signal, assertCurrent: () => { if (!current) throw new Error("private retired owner"); } }, { factory: worker.factory, job });
    worker.inject({ job: "other-zip-job-0002", type: "settled", status: "complete" });
    const observed = writer.entry("one.SC2Replay", encode("data")).then(() => null, error => error);
    try {
      await entered.promise; current = false; written.resolve(); await tick();
      expect(output.abort).toHaveBeenCalledOnce(); expect(output.close).not.toHaveBeenCalled();
      aborted.resolve(); expect((await observed).message).not.toContain("private retired owner");
      expect(worker.input.some(message => message.type === "ack")).toBe(false);
    } finally { written.resolve(); aborted.resolve(); await observed; await writer.abort(); }
  });

  it("owner cancellation during an admitted sink.close joins both close and abort before final completion", async () => {
    const worker = new MockWorker(), closing = deferred(), closed = deferred(), aborted = deferred(), controller = new AbortController();
    const output = sink({ close: async () => { closing.resolve(); await closed.promise; }, abort: () => aborted.promise });
    let published = false, settled = false;
    const work = withExportAdmission(async () => {
      const writer = await openReplayZip(output, scope(controller.signal), { factory: worker.factory, job });
      await writer.entry("one.SC2Replay", encode("data"));
      await writer.entry("manifest.csv", replayPackManifest([{ gameId: "one", filename: "one.SC2Replay", status: "saved" }]), "manifest");
      await writer.entry("README.txt", replayPackReadme({ requested: 1, saved: 1, failed: 0, cancelled: 0 }), "readme");
      await writer.finish(); published = true;
    });
    const observed = work.then(() => { settled = true; }, error => { settled = true; return error; });
    try {
      await closing.promise; controller.abort(); await tick(); expect(settled).toBe(false); expect(exportBusy()).toBe(true);
      aborted.resolve(); await tick(); expect(settled).toBe(false); expect(published).toBe(false);
      closed.resolve(); expect((await observed).message).toBe("Export cancelled.");
      expect(published).toBe(false); expect(output.close).toHaveBeenCalledOnce(); expect(output.abort).toHaveBeenCalledOnce();
    } finally { controller.abort(); closed.resolve(); aborted.resolve(); await observed; }
  });

  it("abort before ready needs no worker event and keeps admission until actual created-sink abort settles", async () => {
    const worker = new MockWorker(false), aborted = deferred(), controller = new AbortController(), output = sink({ abort: () => aborted.promise });
    let settled = false, opened = false;
    const work = withExportAdmission(async () => { await openReplayZip(output, scope(controller.signal), { factory: worker.factory, job }); opened = true; });
    const observed = work.then(() => { settled = true; }, error => { settled = true; return error; });
    try {
      controller.abort(); await tick(); expect(worker.terminate).toHaveBeenCalledOnce(); expect(output.abort).toHaveBeenCalledOnce();
      expect(exportBusy()).toBe(true); expect(settled).toBe(false); expect(opened).toBe(false);
      worker.inject({ job, type: "ready" }); await tick(); expect(opened).toBe(false); expect(settled).toBe(false);
      expect(output.write).not.toHaveBeenCalled(); expect(output.close).not.toHaveBeenCalled();
      aborted.resolve(); expect((await observed).message).toBe("Export cancelled.");
      expect(worker.input.filter(message => message.type === "entry")).toHaveLength(0);
    } finally { controller.abort(); aborted.resolve(); await observed; }
  });
});
