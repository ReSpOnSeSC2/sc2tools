import { ExportDownloadError } from "../exportErrors";
import type { ExportSink } from "../exportStream";
import { MAX_ZIP_BYTES, validZipJob, type ZipInput } from "./zipWorkerProtocol";
import { REPLAY_BYTES, ZIP_CHUNK_BYTES, type ZipEntryKind } from "./zipStore";
import { MANIFEST_BYTES, README_BYTES } from "./packMetadata";
import { validReplayFilename } from "./packNames";

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };
type Scope = { signal: AbortSignal; assertCurrent: () => void };
type Options = { factory?: () => Worker; job?: string };
export type ReplayZip = { entry: (name: string, bytes: Uint8Array, kind?: ZipEntryKind) => Promise<void>; finish: () => Promise<void>; abort: () => Promise<void> };
function deferred(): Deferred {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const factory = () => new Worker(new URL("./zipWorker.ts", import.meta.url), { type: "module" });

/** Created only after an explicit admitted pack action; constructor/startup failures join sink abort before rejecting. */
export async function openReplayZip(sink: ExportSink, scope: Scope, options: Options = {}): Promise<ReplayZip> {
  const client = new ReplayZipWriter(sink, scope);
  client.start(options);
  await client.ready.promise;
  return client;
}

class ReplayZipWriter {
  readonly ready = deferred();
  private readonly terminal = deferred();
  private readonly io = new Set<Promise<void>>();
  private worker: Worker | null = null;
  private workerReady = false;
  private job = "";
  private pending: { id: number; type: "entry" | "finish"; result: Deferred } | null = null;
  private nextId = 1;
  private nextSeq = 1;
  private activeChunk: number | null = null;
  private written = 0;
  private error: ExportDownloadError | null = null;
  private cleanup: Promise<void> | null = null;
  private aborting: Promise<void> | null = null;
  private terminated = false;
  private completed = false;
  private readonly cancelled = () => { void this.fail("cancelled"); };
  constructor(private readonly sink: ExportSink, private readonly scope: Scope) {
    scope.signal.addEventListener("abort", this.cancelled, { once: true });
  }

  start(options: Options) {
    try {
      this.current(); this.job = options.job || crypto.randomUUID();
      if (!validZipJob(this.job)) throw new Error("invalid_zip_job");
      this.worker = (options.factory || factory)();
      this.current();
      this.worker.onmessage = event => this.receive(event.data);
      this.worker.onerror = event => { event.preventDefault(); void this.fail("failed", true); };
      this.worker.onmessageerror = () => { void this.fail("failed", true); };
      this.send({ job: this.job, type: "start" });
    } catch { void this.fail(this.scope.signal.aborted ? "cancelled" : "failed", true); }
  }

  async entry(name: string, bytes: Uint8Array, kind: ZipEntryKind = "replay"): Promise<void> {
    const cap = kind === "replay" ? REPLAY_BYTES : kind === "manifest" ? MANIFEST_BYTES : README_BYTES;
    const validName = kind === "replay" ? validReplayFilename(name) : name === (kind === "manifest" ? "manifest.csv" : "README.txt");
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > cap || !validName || !["replay", "manifest", "readme"].includes(kind)) { await this.fail("failed"); throw this.error!; }
    // Copy into a private exact-sized buffer before transfer; a view/slab can contain unrelated bytes.
    const snapshot = new Uint8Array(bytes.byteLength); snapshot.set(bytes);
    return this.command("entry", { name, kind, bytes: snapshot.buffer }, [snapshot.buffer]);
  }

  finish(): Promise<void> { return this.command("finish"); }
  abort(): Promise<void> { return this.completed ? Promise.resolve() : this.fail("cancelled"); }
  private current() { this.scope.signal.throwIfAborted(); this.scope.assertCurrent(); if (this.error || this.completed) throw this.error || new ExportDownloadError("failed"); }
  private send(message: ZipInput, transfer: Transferable[] = []) { this.worker!.postMessage(message, transfer); }

  private async command(type: "entry" | "finish", fields: { name?: string; kind?: ZipEntryKind; bytes?: ArrayBuffer } = {}, transfer: Transferable[] = []): Promise<void> {
    try { this.current(); if (this.pending || !this.worker) throw new Error("zip_busy"); }
    catch { await this.fail(this.scope.signal.aborted ? "cancelled" : "failed"); throw this.error!; }
    const result = deferred(), id = this.nextId++;
    this.pending = { id, type, result };
    try { this.send({ job: this.job, type, id, ...fields } as ZipInput, transfer); }
    catch { void this.fail("failed", true); }
    return result.promise;
  }

  private receive(raw: unknown) {
    if (!raw || typeof raw !== "object") { void this.fail("failed", true); return; }
    const message = raw as Record<string, unknown>;
    if (message.job !== this.job || this.completed) return;
    if (message.type === "settled") { this.settled(message.status); return; }
    if (this.error) return;
    if (message.type === "ready" && !this.workerReady && this.nextId === 1 && !this.pending) { this.workerReady = true; this.ready.resolve(); return; }
    if (message.type === "chunk") { this.chunk(message.seq, message.bytes); return; }
    if (message.type === "entry-done" && this.pending?.type === "entry" && message.id === this.pending.id && this.activeChunk === null) {
      const pending = this.pending; this.pending = null; pending.result.resolve(); return;
    }
    void this.fail("failed", true);
  }

  private chunk(seq: unknown, bytes: unknown) {
    if (seq !== this.nextSeq || this.activeChunk !== null || !this.pending || !(bytes instanceof ArrayBuffer)
      || bytes.byteLength < 1 || bytes.byteLength > ZIP_CHUNK_BYTES || this.written + bytes.byteLength > MAX_ZIP_BYTES) {
      void this.fail("failed", true); return;
    }
    const sequence = this.nextSeq++, length = bytes.byteLength;
    this.activeChunk = sequence;
    void this.track(async () => { this.current(); await this.sink.write(new Uint8Array(bytes)); this.current(); }).then(() => {
      this.activeChunk = null;
      if (this.error) return;
      this.written += length;
      try { this.send({ job: this.job, type: "ack", seq: sequence }); }
      catch { void this.fail("failed", true); }
    }, () => {
      this.activeChunk = null;
      try { this.send({ job: this.job, type: "nack", seq: sequence }); }
      catch { void this.fail("failed", true); return; }
      void this.fail(this.scope.signal.aborted ? "cancelled" : "failed");
    });
  }

  private settled(status: unknown) {
    if (status !== "complete" && status !== "failed" && status !== "aborted") { void this.fail("failed", true); return; }
    this.terminal.resolve();
    if (this.error) return;
    if (status !== "complete" || this.pending?.type !== "finish" || this.activeChunk !== null) { void this.fail(status === "aborted" ? "cancelled" : "failed"); return; }
    void this.track(async () => { this.current(); await this.sink.close(); this.current(); }).then(() => {
      if (this.error) return;
      this.completed = true; this.detachAndTerminate();
      const pending = this.pending; this.pending = null; pending?.result.resolve();
    }, () => { void this.fail(this.scope.signal.aborted ? "cancelled" : "failed"); });
  }

  private track(operation: () => Promise<void>): Promise<void> {
    const promise = Promise.resolve().then(operation); this.io.add(promise);
    void promise.then(() => this.io.delete(promise), () => this.io.delete(promise));
    return promise;
  }

  private fail(code: "failed" | "cancelled", fatal = false): Promise<void> {
    if (this.completed) return Promise.resolve();
    this.error ||= new ExportDownloadError(code);
    // Before ready, open has admitted no entry/output. A worker whose script
    // never starts cannot ACK abort; request owned termination and join the sink.
    const terminateBeforeAcknowledgment = fatal || !this.worker || !this.workerReady;
    if (terminateBeforeAcknowledgment) { this.requestTermination(); this.terminal.resolve(); }
    if (this.cleanup) return this.cleanup;
    if (this.worker && !terminateBeforeAcknowledgment) {
      try { this.send({ job: this.job, type: "abort" }); }
      catch { this.requestTermination(); this.terminal.resolve(); }
    }
    this.aborting ||= Promise.resolve().then(() => this.sink.abort());
    this.cleanup = Promise.allSettled([this.terminal.promise, this.aborting, ...this.io]).then(() => {
      this.detachAndTerminate(); this.ready.reject(this.error!);
      const pending = this.pending; this.pending = null; pending?.result.reject(this.error!);
    });
    return this.cleanup;
  }

  private requestTermination() {
    if (!this.worker || this.terminated) return;
    this.terminated = true;
    try { this.worker.terminate(); } catch { /* Request only: the Worker API exposes no termination-complete promise. */ }
  }
  private detachAndTerminate() {
    this.scope.signal.removeEventListener("abort", this.cancelled);
    if (this.worker) { this.worker.onmessage = null; this.worker.onerror = null; this.worker.onmessageerror = null; }
    this.requestTermination();
  }
}
