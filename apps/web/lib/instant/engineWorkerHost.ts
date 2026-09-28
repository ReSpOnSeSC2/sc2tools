/**
 * Request handling inside the engine worker, independent of the worker
 * global so it can be unit-tested with a fake runtime.
 *
 * - `boot` runs once (concurrent/duplicate boots share one promise; a failed
 *   boot can be retried).
 * - `players` / `parse` / `unzip` run strictly one at a time and emit a
 *   progress event before and after each file.
 * - Python exceptions keep the interpreter usable; other errors (a dead
 *   Pyodide, an out-of-memory heap) are reported with a fatal kind so the
 *   client recycles this worker.
 * - Never logs; file and player names only travel back to the page.
 *
 * Example:
 *   const handle = createEngineWorkerHost({ post }, { boot: bootWorkerEngine });
 *   self.onmessage = (event) => void handle(event.data);
 */
import { describeBootError } from "./engineBoot";
import { requestErrorKind, safeDetail } from "./engineErrors";
import { toDigests, toParseOutcome, toPlayersResult } from "./engineOutcome";
import type { EngineRuntime } from "./enginePyGlue";
import type {
  BootRequest,
  ParseWorkerRequest,
  PlayersRequest,
  UnzipRequest,
  WorkerEvent,
  WorkerRequest,
} from "./protocol";
import type { EngineInfo, EngineProgress, ErrorKind } from "./types";

/** Where events go (the worker's `postMessage`). */
export interface WorkerPort {
  post(event: WorkerEvent, transfer?: Transferable[]): void;
}

export interface BootedRuntime {
  runtime: EngineRuntime;
  info: EngineInfo;
}

export interface EngineHostDeps {
  boot(pointerUrl: string): Promise<BootedRuntime>;
  now?: () => number;
}

type FileRequest = PlayersRequest | ParseWorkerRequest | UnzipRequest;

interface StepResult {
  event: WorkerEvent;
  transfer?: Transferable[];
  ok: boolean;
  errorKind?: ErrorKind;
}

const FILE_FAILED = "the engine failed on this file";
const NOT_BOOTED = "the engine is not booted";
const TOO_LARGE_ZIP_CODES = new Set(["zip_too_many_entries", "zip_entry_too_large", "zip_too_large"]);

/** Fallback kind for a Python exception escaping the glue, per request type. */
const FALLBACK_KIND: Record<FileRequest["type"], ErrorKind> = {
  players: "parse_failed",
  parse: "analysis_failed",
  unzip: "corrupt_file",
};

/**
 * Error kind for an `expand_replay_zip` guard code.
 *
 * Example:
 *   zipErrorKind("zip_too_large"); // -> "too_large"
 */
export function zipErrorKind(code: string): ErrorKind {
  return TOO_LARGE_ZIP_CODES.has(code) ? "too_large" : "corrupt_file";
}

function unknownObject(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === "object" && parsed !== null ? { ...parsed } : {};
}

function runPlayers(runtime: EngineRuntime, request: PlayersRequest): StepResult {
  const raw = runtime.players(new Uint8Array(request.bytes), request.relativePath || request.fileName);
  const result = toPlayersResult(JSON.parse(raw));
  const event: WorkerEvent = { type: "players", id: request.id, result };
  return result.ok ? { event, ok: true } : { event, ok: false, errorKind: result.errorKind };
}

function runParse(runtime: EngineRuntime, request: ParseWorkerRequest, started: number, now: () => number): StepResult {
  const raw = runtime.parse(
    new Uint8Array(request.bytes),
    request.relativePath || request.fileName,
    request.playerToon ?? "",
    request.playerHandle ?? "",
    request.wantDigests,
  );
  const { envelope, digests } = unknownObject(raw);
  const meta = { fileName: request.fileName, relativePath: request.relativePath, ms: Math.round(now() - started) };
  const outcome = toParseOutcome(envelope, meta, request.wantDigests ? toDigests(digests) : undefined);
  const event: WorkerEvent = { type: "parsed", id: request.id, outcome, heapBytes: runtime.heapBytes() };
  return outcome.ok ? { event, ok: true } : { event, ok: false, errorKind: outcome.errorKind };
}

function runUnzip(runtime: EngineRuntime, request: UnzipRequest): StepResult {
  const result = runtime.unzip(new Uint8Array(request.bytes));
  if (!result.ok) {
    const errorKind = zipErrorKind(result.code);
    return { event: { type: "request-error", id: request.id, errorKind, detail: result.code }, ok: false, errorKind };
  }
  const event: WorkerEvent = { type: "unzipped", id: request.id, entries: result.entries };
  return { event, transfer: result.entries.map((entry) => entry.bytes), ok: true };
}

function runStep(runtime: EngineRuntime, request: FileRequest, started: number, now: () => number): StepResult {
  if (request.type === "players") return runPlayers(runtime, request);
  if (request.type === "parse") return runParse(runtime, request, started, now);
  return runUnzip(runtime, request);
}

function runSafely(runtime: EngineRuntime, request: FileRequest, started: number, now: () => number): StepResult {
  try {
    return runStep(runtime, request, started, now);
  } catch (error) {
    const errorKind = requestErrorKind(error, FALLBACK_KIND[request.type]);
    const detail = safeDetail(error, FILE_FAILED);
    return { event: { type: "request-error", id: request.id, errorKind, detail }, ok: false, errorKind };
  }
}

/** Boots once, then answers file requests; see `createEngineWorkerHost`. */
class EngineWorkerHost {
  private booting: Promise<BootedRuntime> | null = null;
  private readonly now: () => number;

  constructor(
    private readonly port: WorkerPort,
    private readonly deps: EngineHostDeps,
  ) {
    this.now = deps.now ?? (() => performance.now());
  }

  handle(request: WorkerRequest): Promise<void> {
    return request.type === "boot" ? this.handleBoot(request) : this.handleFile(request);
  }

  private progress(event: EngineProgress): void {
    this.port.post({ type: "progress", progress: event });
  }

  private elapsed(started: number): number {
    return Math.round(this.now() - started);
  }

  private async handleBoot(request: BootRequest): Promise<void> {
    const base: EngineProgress = { phase: "boot", index: 0, total: 1, fileName: "" };
    const started = this.now();
    this.progress(base);
    try {
      this.booting ??= this.deps.boot(request.pointerUrl);
      const booted = await this.booting;
      this.progress({ ...base, ms: this.elapsed(started), ok: true });
      this.port.post({ type: "ready", info: booted.info, heapBytes: booted.runtime.heapBytes() });
    } catch (error) {
      this.booting = null;
      const { errorKind, detail } = describeBootError(error);
      this.progress({ ...base, ms: this.elapsed(started), ok: false, errorKind });
      this.port.post({ type: "boot-error", errorKind, detail });
    }
  }

  private async handleFile(request: FileRequest): Promise<void> {
    const booted = this.booting ? await this.booting.catch(() => null) : null;
    if (!booted) {
      this.port.post({ type: "request-error", id: request.id, errorKind: "engine_unavailable", detail: NOT_BOOTED });
      return;
    }
    const base = { phase: request.type, index: request.index, total: request.total, fileName: request.fileName };
    const started = this.now();
    this.progress(base);
    const result = runSafely(booted.runtime, request, started, this.now);
    const done: EngineProgress = { ...base, ms: this.elapsed(started), ok: result.ok };
    if (result.errorKind) done.errorKind = result.errorKind;
    this.progress(done);
    this.port.post(result.event, result.transfer);
  }
}

/**
 * Build the worker's message handler. Returned promise settles when the
 * request (and all earlier ones) have been answered.
 *
 * Example:
 *   await handle({ type: "boot", pointerUrl: "https://sc2tools.app/engine/current.json" });
 */
export function createEngineWorkerHost(port: WorkerPort, deps: EngineHostDeps): (request: WorkerRequest) => Promise<void> {
  const host = new EngineWorkerHost(port, deps);
  let chain: Promise<void> = Promise.resolve();
  return (request) => {
    // A failed post (e.g. a clone error) must not wedge later requests; the
    // client's per-file timeout recovers the one that got no answer.
    chain = chain.then(() => host.handle(request)).catch(() => undefined);
    return chain;
  };
}
