/**
 * Promise façade over the engine worker (`EngineClient` in `types.ts`).
 *
 * - Lazy: the worker is created and booted on first use; concurrent boots
 *   share one promise.
 * - Strictly sequential: calls queue behind each other and files go to the
 *   worker one at a time, read with `blob.arrayBuffer()` just before sending
 *   and transferred (bounded memory, no copies on the main thread).
 * - Resilient: a file that exceeds `perFileTimeoutMs`, crashes the worker or
 *   runs it out of memory fails alone (`timeout` / `worker_crashed` /
 *   `out_of_memory`); the worker is replaced and the batch continues.
 * - Bounded heap: the worker is recycled after every `recycleEvery` parses;
 *   `lastHeapBytes()` reports the heap size from the latest boot or parse.
 * - Cancellable: `cancel()` or an aborted `signal` terminates the worker;
 *   in-flight and queued files resolve as `cancelled`.
 *
 * Boot failures: a call rejects with `EngineError` when the engine cannot
 * boot before its first file; if a RE-boot fails later in a batch, the
 * remaining files fail with that kind instead so finished outcomes are kept.
 * `expandZip` rejects with `EngineError` on any failure.
 *
 * Example:
 *   const engine = createEngineClient();
 *   const outcomes = await engine.parseFiles(requests, { onProgress: setProgress });
 */
import { ENGINE_POINTER_URL } from "./engineVersion";
import { EngineError, isFatalKind, safeDetail } from "./engineErrors";
import { failedParse, zipEntryFile } from "./engineOutcome";
import { EngineSession, type FileRequestMessage, type ResponseEvent } from "./engineSession";
import type { WorkerLike } from "./protocol";
import type {
  EngineClient,
  EngineInfo,
  EnginePhase,
  EngineProgress,
  ErrorKind,
  IntakeFile,
  ParseOptions,
  ParseOutcome,
  ParseRequest,
  PlayersResult,
} from "./types";

export interface EngineClientOptions {
  /** Worker constructor (tests inject a mock). */
  workerFactory?: () => WorkerLike;
  /** Per-file budget before the worker is killed. Default 60 s. */
  perFileTimeoutMs?: number;
  /** Recycle the worker after this many parses. Default 150. */
  recycleEvery?: number;
  /** Pointer URL, absolute or same-origin path. Default `/engine/current.json`. */
  pointerUrl?: string;
  /** Budget for downloading + starting the engine. Default 120 s. */
  bootTimeoutMs?: number;
}

export const DEFAULT_PER_FILE_TIMEOUT_MS = 60_000;
export const DEFAULT_RECYCLE_EVERY = 150;
export const DEFAULT_BOOT_TIMEOUT_MS = 120_000;

const CANCELLED = "cancelled";
const RECYCLED = "recycled to bound the WebAssembly heap";
const UNREADABLE = "the file could not be read";
const UNEXPECTED = "unexpected engine response";
const NO_WORKER = "the engine worker could not be created";
const FALLBACK_ORIGIN = "http://localhost/";

interface Job {
  generation: number;
  signal?: AbortSignal;
  onProgress?: (event: EngineProgress) => void;
}

/** How one kind of file request is sent and how its answer is mapped. */
interface FileStep<I, R> {
  phase: Exclude<EnginePhase, "boot">;
  file(item: I): IntakeFile;
  message(item: I, base: Omit<FileRequestMessage, "type">): FileRequestMessage;
  fromResponse(item: I, event: ResponseEvent, ms: number): R;
  failure(item: I, kind: ErrorKind, detail: string | undefined, ms: number): R;
}

type UnzipResult = { ok: true; files: IntakeFile[] } | { ok: false; errorKind: ErrorKind; detail?: string };

/**
 * The only place that knows the worker path. Next.js' webpack bundles the
 * worker from this exact expression; without `output.module` it emits a
 * classic worker (`type: undefined`), which `engineBoot.ts` supports
 * (`withImportScriptsHidden`). Other bundlers keep the module worker.
 */
function defaultWorkerFactory(): WorkerLike {
  return new Worker(new URL("./engineWorker.ts", import.meta.url), { type: "module" });
}

function absoluteUrl(url: string): string {
  return new URL(url, globalThis.location?.href ?? FALLBACK_ORIGIN).href;
}

function asEngineError(error: unknown): EngineError {
  return error instanceof EngineError ? error : new EngineError("worker_crashed", safeDetail(error, UNEXPECTED));
}

function metaOf(file: IntakeFile, ms: number) {
  return { fileName: file.name, relativePath: file.relativePath, ms };
}

const parseStep: FileStep<ParseRequest, ParseOutcome> = {
  phase: "parse",
  file: (request) => request.file,
  message: (request, base) => ({
    ...base,
    type: "parse",
    playerToon: request.player.toon,
    playerHandle: request.player.handle,
    wantDigests: request.wantDigests === true,
  }),
  fromResponse: (request, event, ms) => {
    if (event.type === "parsed") return event.outcome;
    const meta = metaOf(request.file, ms);
    return event.type === "request-error"
      ? failedParse(meta, event.errorKind, event.detail)
      : failedParse(meta, "worker_crashed", UNEXPECTED);
  },
  failure: (request, kind, detail, ms) => failedParse(metaOf(request.file, ms), kind, detail),
};

const playersStep: FileStep<IntakeFile, PlayersResult> = {
  phase: "players",
  file: (file) => file,
  message: (_file, base) => ({ ...base, type: "players" }),
  fromResponse: (_file, event) => {
    if (event.type === "players") return event.result;
    return event.type === "request-error"
      ? { ok: false, errorKind: event.errorKind, detail: event.detail }
      : { ok: false, errorKind: "worker_crashed", detail: UNEXPECTED };
  },
  failure: (_file, kind, detail) => (detail ? { ok: false, errorKind: kind, detail } : { ok: false, errorKind: kind }),
};

const unzipStep: FileStep<IntakeFile, UnzipResult> = {
  phase: "unzip",
  file: (file) => file,
  message: (_file, base) => ({ ...base, type: "unzip" }),
  fromResponse: (zip, event) => {
    if (event.type === "unzipped") {
      return { ok: true, files: event.entries.map((entry) => zipEntryFile(zip, entry.name, entry.bytes, entry.lastModified)) };
    }
    return event.type === "request-error"
      ? { ok: false, errorKind: event.errorKind, detail: event.detail }
      : { ok: false, errorKind: "worker_crashed", detail: UNEXPECTED };
  },
  failure: (_zip, kind, detail) => ({ ok: false, errorKind: kind, detail }),
};

type FilePosition = { index: number; total: number; fileName: string };

/** Report one file's failure to the job's progress listener. */
function emitFailure(job: Job, phase: EnginePhase, base: FilePosition, ms: number, errorKind: ErrorKind): void {
  job.onProgress?.({ phase, ...base, ms, ok: false, errorKind });
}

class QueuedEngineClient implements EngineClient {
  private session: EngineSession | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private disposed = false;
  private nextId = 1;
  private running: Job | null = null;
  /** Heap reported by the latest `ready` / `parsed` event (see EngineSession). */
  private heapBytes: number | null = null;
  private readonly bootListeners = new Set<(event: EngineProgress) => void>();

  /** `config.pointerUrl` must already be absolute (see `createEngineClient`). */
  constructor(private readonly config: Required<EngineClientOptions>) {}

  boot(options: ParseOptions = {}): Promise<EngineInfo> {
    if (this.disposed) return Promise.reject(new EngineError("cancelled", "the engine client was disposed"));
    const booted = this.readySession(this.makeJob(options)).then((session) => {
      if (!session.info) throw new EngineError("engine_boot_failed", "the engine reported no version info");
      return session.info;
    });
    return withAbort(booted, options.signal);
  }

  listPlayers(files: IntakeFile[], options?: ParseOptions): Promise<PlayersResult[]> {
    return this.enqueue(options, (job) => this.runFiles(job, files, playersStep));
  }

  parseFiles(requests: ParseRequest[], options?: ParseOptions): Promise<ParseOutcome[]> {
    return this.enqueue(options, (job) => this.runFiles(job, requests, parseStep));
  }

  expandZip(file: IntakeFile, options?: ParseOptions): Promise<IntakeFile[]> {
    return this.enqueue(options, async (job) => {
      const [result] = await this.runFiles(job, [file], unzipStep);
      if (!result.ok) throw new EngineError(result.errorKind, result.detail ?? result.errorKind);
      return result.files;
    });
  }

  cancel(): void {
    this.generation += 1;
    this.killSession(new EngineError("cancelled", CANCELLED));
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
  }

  lastHeapBytes(): number | null {
    return this.heapBytes;
  }

  private makeJob(options: ParseOptions = {}): Job {
    return { generation: this.generation, signal: options.signal, onProgress: options.onProgress };
  }

  private stopped(job: Job): boolean {
    return this.disposed || job.generation !== this.generation || job.signal?.aborted === true;
  }

  private enqueue<T>(options: ParseOptions | undefined, run: (job: Job) => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new EngineError("cancelled", "the engine client was disposed"));
    const job = this.makeJob(options);
    const result = this.tail.then(() => this.runJob(job, run));
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async runJob<T>(job: Job, run: (job: Job) => Promise<T>): Promise<T> {
    this.running = job;
    const onAbort = (): void => {
      if (this.running === job) this.killSession(new EngineError("cancelled", CANCELLED));
    };
    job.signal?.addEventListener("abort", onAbort);
    try {
      return await run(job);
    } finally {
      job.signal?.removeEventListener("abort", onAbort);
      this.running = null;
    }
  }

  private forwardProgress(event: EngineProgress): void {
    if (event.phase === "boot") this.bootListeners.forEach((listener) => listener(event));
    else this.running?.onProgress?.(event);
  }

  private spawnSession(): EngineSession {
    try {
      return new EngineSession({
        factory: this.config.workerFactory,
        pointerUrl: this.config.pointerUrl,
        onProgress: (event) => this.forwardProgress(event),
      });
    } catch (error) {
      // `new Worker` throws synchronously (CSP, unsupported module workers).
      throw new EngineError("engine_boot_failed", safeDetail(error, NO_WORKER));
    }
  }

  private async readySession(job: Job): Promise<EngineSession> {
    if (!this.session || this.session.dead) this.session = this.spawnSession();
    const session = this.session;
    const listener = job.onProgress;
    if (listener) this.bootListeners.add(listener);
    try {
      await session.boot(this.config.bootTimeoutMs);
    } finally {
      if (listener) this.bootListeners.delete(listener);
    }
    this.heapBytes = session.heapBytes;
    return session;
  }

  private killSession(reason: EngineError): void {
    this.session?.terminate(reason);
    this.session = null;
  }

  private retire(session: EngineSession): void {
    session.terminate(new EngineError("cancelled", RECYCLED));
    if (this.session === session) this.session = null;
  }

  private async runFiles<I, R>(job: Job, items: I[], step: FileStep<I, R>): Promise<R[]> {
    const results: R[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (this.stopped(job)) {
        results.push(step.failure(item, "cancelled", undefined, 0));
        continue;
      }
      let session: EngineSession;
      try {
        session = await this.readySession(job);
      } catch (error) {
        if (this.stopped(job)) {
          results.push(step.failure(item, "cancelled", undefined, 0));
          continue;
        }
        const failure = asEngineError(error);
        if (index === 0) throw failure;
        items.slice(index).forEach((rest) => results.push(step.failure(rest, failure.kind, failure.detail, 0)));
        break;
      }
      results.push(await this.runOnSession(job, session, step, item, { index, total: items.length }));
    }
    return results;
  }

  private async runOnSession<I, R>(
    job: Job,
    session: EngineSession,
    step: FileStep<I, R>,
    item: I,
    position: { index: number; total: number },
  ): Promise<R> {
    const file = step.file(item);
    const base = { ...position, fileName: file.name };
    const started = performance.now();
    const elapsed = (): number => Math.round(performance.now() - started);
    let bytes: ArrayBuffer;
    try {
      bytes = await file.blob.arrayBuffer();
    } catch (error) {
      emitFailure(job, step.phase, base, elapsed(), "parse_failed");
      return step.failure(item, "parse_failed", safeDetail(error, UNREADABLE), elapsed());
    }
    if (this.stopped(job)) return step.failure(item, "cancelled", undefined, elapsed());
    const message = step.message(item, { ...base, id: this.nextId++, relativePath: file.relativePath, bytes });
    try {
      const event = await session.request(message, this.config.perFileTimeoutMs);
      this.afterResponse(session, step, event);
      return step.fromResponse(item, event, elapsed());
    } catch (error) {
      const failure = asEngineError(error);
      // Normally the session is already dead (timeout, crash, cancel). If
      // the request failed without killing it (e.g. postMessage threw), kill
      // it now so no worker is left running with a stale pending request.
      session.terminate(failure);
      if (this.session === session) this.session = null;
      const kind: ErrorKind = this.stopped(job) ? "cancelled" : failure.kind;
      emitFailure(job, step.phase, base, elapsed(), kind);
      return step.failure(item, kind, kind === "cancelled" ? undefined : failure.detail, elapsed());
    }
  }

  private afterResponse<I, R>(session: EngineSession, step: FileStep<I, R>, event: ResponseEvent): void {
    if (event.type === "request-error" && isFatalKind(event.errorKind)) {
      this.retire(session);
      return;
    }
    if (step.phase !== "parse") return;
    if (event.type === "parsed") this.heapBytes = session.heapBytes;
    session.parsedCount += 1;
    if (session.parsedCount >= this.config.recycleEvery) this.retire(session);
  }
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new EngineError("cancelled", CANCELLED));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new EngineError("cancelled", CANCELLED));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Create the engine client. The worker is not created until first use.
 *
 * Example:
 *   const engine = createEngineClient({ perFileTimeoutMs: 90_000 });
 *   const [players] = await engine.listPlayers([file]);
 */
export function createEngineClient(options: EngineClientOptions = {}): EngineClient {
  return new QueuedEngineClient({
    workerFactory: options.workerFactory ?? defaultWorkerFactory,
    perFileTimeoutMs: options.perFileTimeoutMs ?? DEFAULT_PER_FILE_TIMEOUT_MS,
    recycleEvery: options.recycleEvery ?? DEFAULT_RECYCLE_EVERY,
    pointerUrl: absoluteUrl(options.pointerUrl ?? ENGINE_POINTER_URL),
    bootTimeoutMs: options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS,
  });
}
