/**
 * Message protocol between the main thread (`engineClient.ts`) and the
 * module worker (`engineWorker.ts`). Replay bytes always travel as
 * transferable `ArrayBuffer`s so the main thread never copies them.
 *
 * Example:
 *   worker.postMessage({ type: "parse", id: 7, ... , bytes }, [bytes]);
 *   // -> { type: "progress", phase: "parse", index: 3, total: 10, ... }
 *   // -> { type: "parsed", id: 7, outcome: {...} }
 */
import type {
  EngineInfo,
  EngineProgress,
  ErrorKind,
  ParseOutcome,
  PlayersResult,
} from "./types";

export interface BootRequest {
  type: "boot";
  /** Absolute same-origin URL of `/engine/current.json`. */
  pointerUrl: string;
}

interface FileEnvelope {
  id: number;
  index: number;
  total: number;
  fileName: string;
  relativePath: string;
  bytes: ArrayBuffer;
}

export interface PlayersRequest extends FileEnvelope {
  type: "players";
}

export interface ParseWorkerRequest extends FileEnvelope {
  type: "parse";
  playerToon: string | null;
  playerHandle: string | null;
  wantDigests: boolean;
}

export interface UnzipRequest extends FileEnvelope {
  type: "unzip";
}

export type WorkerRequest =
  | BootRequest
  | PlayersRequest
  | ParseWorkerRequest
  | UnzipRequest;

export interface ReadyEvent {
  type: "ready";
  info: EngineInfo;
  /** Emscripten heap size after boot, for the memory budget. */
  heapBytes: number;
}

export interface BootErrorEvent {
  type: "boot-error";
  errorKind: Extract<
    ErrorKind,
    "integrity_failed" | "engine_boot_failed" | "engine_unavailable" | "out_of_memory"
  >;
  detail: string;
}

export interface ProgressEvent {
  type: "progress";
  progress: EngineProgress;
}

export interface PlayersEvent {
  type: "players";
  id: number;
  result: PlayersResult;
}

export interface ParsedEvent {
  type: "parsed";
  id: number;
  outcome: ParseOutcome;
  /** Emscripten heap size after the parse (and `gc.collect()`). */
  heapBytes: number;
}

export interface UnzippedEntry {
  /** Path inside the archive, `/`-separated. */
  name: string;
  bytes: ArrayBuffer;
}

export interface UnzippedEvent {
  type: "unzipped";
  id: number;
  entries: UnzippedEntry[];
}

export interface RequestErrorEvent {
  type: "request-error";
  id: number;
  errorKind: ErrorKind;
  detail: string;
}

export type WorkerEvent =
  | ReadyEvent
  | BootErrorEvent
  | ProgressEvent
  | PlayersEvent
  | ParsedEvent
  | UnzippedEvent
  | RequestErrorEvent;

/** Minimal Worker surface the client depends on (mockable in tests). */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<WorkerEvent>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror?: ((event: MessageEvent) => void) | null;
}
