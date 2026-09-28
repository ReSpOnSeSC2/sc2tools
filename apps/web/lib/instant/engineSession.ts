/**
 * One engine worker's lifetime, seen from the main thread: spawn, boot once,
 * answer ONE file request at a time with a timeout, and die exactly once.
 *
 * A session never recovers: a timeout, a crash (`onerror`), a failed boot,
 * cancellation or recycling terminates the worker and rejects whatever was
 * waiting with an `EngineError`. `engineClient.ts` then spawns a fresh
 * session for the next file. Pyodide cannot be interrupted without
 * SharedArrayBuffer (COOP/COEP), so terminate + respawn is the only way to
 * stop a runaway parse.
 *
 * Example:
 *   const session = new EngineSession({ factory, pointerUrl, onProgress });
 *   const info = await session.boot(120_000);
 *   const event = await session.request(parseMessage, 60_000);
 */
import { EngineError, isOutOfMemory } from "./engineErrors";
import type {
  ParseWorkerRequest,
  ParsedEvent,
  PlayersEvent,
  PlayersRequest,
  ReadyEvent,
  RequestErrorEvent,
  UnzipRequest,
  UnzippedEvent,
  WorkerEvent,
  WorkerLike,
} from "./protocol";
import type { EngineInfo, EngineProgress } from "./types";

export type FileRequestMessage = PlayersRequest | ParseWorkerRequest | UnzipRequest;
export type ResponseEvent = PlayersEvent | ParsedEvent | UnzippedEvent | RequestErrorEvent;

export interface SessionOptions {
  factory: () => WorkerLike;
  /** Absolute URL of `/engine/current.json`. */
  pointerUrl: string;
  onProgress: (progress: EngineProgress) => void;
}

interface Waiter<T> {
  resolve(value: T): void;
  reject(error: EngineError): void;
  timer: ReturnType<typeof setTimeout>;
}

const CRASHED = "the engine worker crashed";
const BOOT_CRASHED = "the engine worker crashed while starting";
const OUT_OF_MEMORY = "the engine ran out of memory";
const MS_PER_SECOND = 1000;

/**
 * One worker, booted once, one request at a time; see the module comment.
 *
 * Example:
 *   const session = new EngineSession({ factory, pointerUrl, onProgress });
 *   if (!session.dead) await session.request(message, 60_000);
 */
export class EngineSession {
  /** Parse requests answered by this worker (drives recycling). */
  parsedCount = 0;
  /** Emscripten heap after the last boot/parse, in bytes. */
  heapBytes = 0;
  info: EngineInfo | null = null;

  private readonly worker: WorkerLike;
  private bootPromise: Promise<EngineInfo> | null = null;
  private bootWaiter: Waiter<EngineInfo> | null = null;
  private pending: (Waiter<ResponseEvent> & { id: number }) | null = null;
  private deadReason: EngineError | null = null;

  /**
   * Spawns the worker immediately.
   *
   * Example:
   *   new EngineSession({ factory: () => new Worker(url, { type: "module" }), pointerUrl, onProgress });
   */
  constructor(private readonly options: SessionOptions) {
    this.worker = options.factory();
    this.worker.onmessage = (event) => this.handleEvent(event.data);
    this.worker.onerror = (event) => this.handleCrash(event.message);
    this.worker.onmessageerror = () => this.handleCrash("");
  }

  /** True once the worker was terminated for any reason. */
  get dead(): boolean {
    return this.deadReason !== null;
  }

  /**
   * Boot the engine once; later calls share the same promise.
   *
   * Example:
   *   const info = await session.boot(120_000);
   */
  boot(timeoutMs: number): Promise<EngineInfo> {
    if (this.deadReason) return Promise.reject(this.deadReason);
    this.bootPromise ??= new Promise<EngineInfo>((resolve, reject) => {
      const timer = setTimeout(
        () => this.terminate(new EngineError("engine_boot_failed", `the engine did not start within ${timeoutMs} ms`)),
        timeoutMs,
      );
      this.bootWaiter = { resolve, reject, timer };
      this.worker.postMessage({ type: "boot", pointerUrl: this.options.pointerUrl });
    });
    return this.bootPromise;
  }

  /**
   * Send one file request (its bytes are transferred) and wait for the
   * matching response, terminating the worker after `timeoutMs`.
   *
   * Example:
   *   const event = await session.request({ type: "players", id: 1, index: 0, total: 1, fileName, relativePath, bytes }, 60_000);
   */
  request(message: FileRequestMessage, timeoutMs: number): Promise<ResponseEvent> {
    if (this.deadReason) return Promise.reject(this.deadReason);
    if (this.pending) return Promise.reject(new EngineError("worker_crashed", "overlapping engine requests"));
    return new Promise<ResponseEvent>((resolve, reject) => {
      const timer = setTimeout(
        () => this.terminate(new EngineError("timeout", `no answer within ${Math.round(timeoutMs / MS_PER_SECOND)} s`)),
        timeoutMs,
      );
      this.pending = { id: message.id, resolve, reject, timer };
      this.worker.postMessage(message, [message.bytes]);
    });
  }

  /**
   * Terminate the worker and reject everything waiting with `reason`.
   * Idempotent: only the first reason counts.
   *
   * Example:
   *   session.terminate(new EngineError("cancelled", "cancelled by the user"));
   */
  terminate(reason: EngineError): void {
    if (this.deadReason) return;
    this.deadReason = reason;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    this.worker.terminate();
    const { bootWaiter, pending } = this;
    this.bootWaiter = null;
    this.pending = null;
    if (bootWaiter) {
      clearTimeout(bootWaiter.timer);
      bootWaiter.reject(reason);
    }
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
  }

  /**
   * `onerror` / `onmessageerror`. Before `ready` the engine never started
   * (worker script failed to load or threw during boot), so the kind is
   * `engine_boot_failed`; afterwards the running worker died.
   */
  private handleCrash(message: string): void {
    if (isOutOfMemory(message)) {
      this.terminate(new EngineError("out_of_memory", OUT_OF_MEMORY));
      return;
    }
    const booted = this.info !== null;
    this.terminate(new EngineError(booted ? "worker_crashed" : "engine_boot_failed", booted ? CRASHED : BOOT_CRASHED));
  }

  private handleReady(event: ReadyEvent): void {
    this.info = event.info;
    this.heapBytes = event.heapBytes;
    const waiter = this.bootWaiter;
    this.bootWaiter = null;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waiter.resolve(event.info);
  }

  private handleResponse(event: ResponseEvent): void {
    const pending = this.pending;
    if (!pending || pending.id !== event.id) return;
    this.pending = null;
    clearTimeout(pending.timer);
    if (event.type === "parsed") this.heapBytes = event.heapBytes;
    pending.resolve(event);
  }

  private handleEvent(event: WorkerEvent): void {
    if (event.type === "progress") this.options.onProgress(event.progress);
    else if (event.type === "ready") this.handleReady(event);
    else if (event.type === "boot-error") this.terminate(new EngineError(event.errorKind, event.detail));
    else this.handleResponse(event);
  }
}
