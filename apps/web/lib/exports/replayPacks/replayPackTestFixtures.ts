import { ReadableStream } from "node:stream/web";
import { vi } from "vitest";
import { createZipWorkerProtocol, type ZipInput, type ZipOutput } from "./zipWorkerProtocol";

export const testJob = "synthetic-pack-job-01";
export const testNow = Date.parse("2026-11-03T06:00:00.000Z");
export const encode = (text: string) => new TextEncoder().encode(text);
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
export const ticks = async () => { for (let index = 0; index < 24; index++) await Promise.resolve(); };
export function bytesResponse(bytes: Uint8Array = new Uint8Array([1, 2, 3, 4]), status = 200, headers: Record<string, string> = {}) {
  const received = new Uint8Array(bytes.byteLength); received.set(bytes);
  return { status, ok: status >= 200 && status < 300, headers: new Headers(headers), body: new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(received); controller.close(); },
  }) } as unknown as Response;
}
export function readyRow(gameId: string, extra: Record<string, unknown> = {}) {
  return { gameId, status: "available", url: `https://storage.example.test/${gameId}?signature=PRIVATE_SIGNED_SENTINEL`, filename: "ignored.SC2Replay", sizeBytes: 4,
    issuedAt: new Date(testNow).toISOString(), expiresAt: new Date(testNow + 60_000).toISOString(), ...extra };
}
export function envelope(items: Record<string, unknown>[]) {
  return { format: "sc2tools-replay-download-batch", version: 1, items, counts: {
    requested: items.length, available: items.filter(row => row.status === "available").length,
    unavailable: items.filter(row => row.status === "unavailable").length, retryable: items.filter(row => row.status === "retryable").length,
  } };
}
export const jsonResponse = (value: unknown, status = 200) => bytesResponse(encode(JSON.stringify(value)), status, { "content-type": "application/json; charset=utf-8" });
export function outputSink() { return { write: vi.fn(async (_chunk: Uint8Array) => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) }; }
export function heldResponse() {
  const entered = deferred(), read = deferred<ReadableStreamReadResult<Uint8Array>>(), cancelled = deferred();
  const reader = { read: vi.fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>()
    .mockImplementationOnce(() => { entered.resolve(); return read.promise; }).mockResolvedValue({ done: true, value: undefined }),
    cancel: vi.fn(() => cancelled.promise), releaseLock: vi.fn() };
  const response = { status: 200, headers: new Headers(), body: { getReader: () => reader } } as unknown as Response;
  return { response, reader, entered, read, cancelled };
}

function receivingClone(message: ZipInput, transfer: Transferable[]): ZipInput;
function receivingClone(message: ZipOutput, transfer: Transferable[]): ZipOutput;
function receivingClone(message: ZipInput | ZipOutput, transfer: Transferable[]): ZipInput | ZipOutput {
  const copy = structuredClone(message, { transfer });
  if ("bytes" in copy) {
    // Node's clone returns host buffers under JSDOM. Real browser delivery
    // creates buffers in the receiving realm; retain real transfer/detachment.
    const received = new Uint8Array(copy.bytes.byteLength); received.set(new Uint8Array(copy.bytes)); copy.bytes = received.buffer;
  }
  return copy;
}

/** Real D1 protocol; terminate records only a request, never a fictional completion event. */
export class PackTestWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly input: ZipInput[] = [];
  readonly output: ZipOutput[] = [];
  readonly terminate = vi.fn(() => { this.stopped = true; });
  private stopped = false;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  private readonly protocol = createZipWorkerProtocol((message, transfer) => {
    const copy = receivingClone(message, transfer); this.output.push(copy);
    queueMicrotask(() => { if (!this.stopped) this.dispatch("message", { data: copy }); });
  });
  addEventListener(type: string, listener: (event: unknown) => void) {
    let set = this.listeners.get(type); if (!set) { set = new Set(); this.listeners.set(type, set); } set.add(listener);
  }
  removeEventListener(type: string, listener: (event: unknown) => void) { this.listeners.get(type)?.delete(listener); }
  listenerCount() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
  postMessage(message: ZipInput, transfer: Transferable[] = []) {
    if (this.stopped) throw new Error("private retired worker");
    const copy = receivingClone(message, transfer); this.input.push(copy);
    queueMicrotask(() => { if (!this.stopped) void this.protocol.receive(copy).catch(() => this.crash("error")); });
  }
  private dispatch(type: string, event: unknown) {
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
    if (type === "message") this.onmessage?.(event as MessageEvent);
    if (type === "error") this.onerror?.(event as ErrorEvent);
    if (type === "messageerror") this.onmessageerror?.(event as MessageEvent);
  }
  crash(type: "error" | "messageerror") { this.dispatch(type, { message: "PRIVATE_SIGNED_SENTINEL", preventDefault: () => {} }); }
  inject(message: unknown) { this.dispatch("message", { data: message }); }
  factory = () => this as unknown as Worker;
}
