/**
 * State shape and reducer for `useInstantSession` (Instant Analysis).
 *
 * Kept free of React and of the engine so every transition is a plain,
 * testable function. The reducer only ever receives coarse updates
 * (a whole batch of files, one throttled progress sample, a finished run),
 * never one action per replay byte, so the main thread stays responsive.
 *
 * Phases:
 *   idle → ready (files queued) → booting → scanning → [choosing] → parsing → done
 *   any running phase → error (the engine could not start) or back to ready (cancel)
 *
 * Example:
 *   let state = initialSessionState({ kind: "days90" });
 *   state = sessionReducer(state, { type: "files-added", incoming, failed: [], maxFiles: 25 });
 *   state.phase; // -> "ready"
 */
import type { DateWindow } from "./fileIntake";
import type { MeCandidate, MeDetectionMode } from "./meDetection";
import type { EngineInfo, EnginePhase, ErrorKind, FailedParse, IntakeFile, ParsedGame } from "./types";

/** Where the session is in the idle → done flow (see module comment). */
export type InstantSessionPhase =
  | "idle"
  | "ready"
  | "booting"
  | "scanning"
  | "choosing"
  | "parsing"
  | "done"
  | "error";

/** One throttled progress sample for the current engine step. */
export interface SessionProgress {
  phase: EnginePhase;
  /** 0-based index of the file being worked on. */
  index: number;
  total: number;
  /** Files finished in this step (drives the determinate progress bar). */
  done: number;
  /** Display only; never logged or sent to analytics. */
  fileName: string;
}

/** What the latest `addFiles` call found (for "no replays in that selection" copy). */
export interface IntakeSummary {
  /** Replays found, zip entries included, before dedupe and `maxFiles`. */
  found: number;
  /** Replays that were new to the queue (before the `maxFiles` cap). */
  added: number;
  /** Files that were neither replays nor .zip archives. */
  ignored: number;
  /** Replays or archives rejected (too large, unreadable .zip). */
  rejected: number;
}

/** A parsed game together with the file it came from (backup needs both). */
export interface ParsedWithFile {
  game: ParsedGame;
  file: IntakeFile;
}

export interface InstantSessionState {
  phase: InstantSessionPhase;
  /** Queued replays (after filtering, zip expansion, dedupe and `maxFiles`). */
  files: IntakeFile[];
  /** Unique replays left out because the queue reached `maxFiles`. */
  truncatedCount: number;
  /** Every unique key ever accepted since the last reset (dedupe). */
  seenKeys: ReadonlySet<string>;
  /** True while dropped/picked .zip archives are being unpacked. */
  expanding: boolean;
  /** Summary of the latest selection; null before the first one. */
  lastIntake: IntakeSummary | null;
  dateWindow: DateWindow;
  progress: SessionProgress | null;
  /** "Which player are you?" options while `phase === "choosing"`. */
  candidates: MeCandidate[];
  /** How "me" was resolved for the current run, once scanned. */
  meMode: MeDetectionMode | null;
  chosenToon: string | null;
  parsedWithFiles: ParsedWithFile[];
  /** Files rejected at intake (too large, unreadable .zip). */
  intakeFailed: FailedParse[];
  /** Files that failed or were skipped during the current run. */
  runFailed: FailedParse[];
  error: ErrorKind | null;
  engineInfo: EngineInfo | null;
}

export type SessionAction =
  | { type: "files-added"; incoming: IntakeFile[]; failed: FailedParse[]; ignored?: number; maxFiles?: number }
  | { type: "expanding"; value: boolean }
  | { type: "date-window"; window: DateWindow }
  | { type: "stage"; phase: "booting" | "scanning" | "parsing" }
  | { type: "progress"; progress: SessionProgress | null }
  | { type: "engine-info"; info: EngineInfo }
  | { type: "run-failed"; failed: FailedParse[] }
  | { type: "choosing"; candidates: MeCandidate[]; meMode: MeDetectionMode }
  | { type: "scanned"; meMode: MeDetectionMode }
  | { type: "chosen"; toon: string }
  | { type: "done"; parsedWithFiles: ParsedWithFile[] }
  | { type: "error"; kind: ErrorKind }
  | { type: "cancelled" }
  | { type: "reset" };

/** Phases in which a run owns the engine and intake is locked. */
const RUNNING_PHASES: ReadonlySet<InstantSessionPhase> = new Set<InstantSessionPhase>([
  "booting",
  "scanning",
  "choosing",
  "parsing",
]);

/**
 * True while a run is in progress (intake and date window are locked).
 *
 * Example:
 *   isRunningPhase("parsing"); // -> true
 */
export function isRunningPhase(phase: InstantSessionPhase): boolean {
  return RUNNING_PHASES.has(phase);
}

/**
 * A fresh session.
 *
 * Example:
 *   initialSessionState({ kind: "all" }).phase; // -> "idle"
 */
export function initialSessionState(dateWindow: DateWindow, engineInfo: EngineInfo | null = null): InstantSessionState {
  return {
    phase: "idle",
    files: [],
    truncatedCount: 0,
    seenKeys: new Set<string>(),
    expanding: false,
    lastIntake: null,
    dateWindow,
    progress: null,
    candidates: [],
    meMode: null,
    chosenToon: null,
    parsedWithFiles: [],
    intakeFailed: [],
    runFailed: [],
    error: null,
    engineInfo,
  };
}

/**
 * Keep the newest `maxFiles` files by `lastModified` (ties keep queue
 * order), preserving queue order among the kept ones.
 *
 * Example:
 *   capQueue([old, recent], 1); // -> [recent]
 */
export function capQueue(files: ReadonlyArray<IntakeFile>, maxFiles?: number): IntakeFile[] {
  if (maxFiles === undefined || files.length <= maxFiles) return [...files];
  const limit = Math.max(0, Math.floor(maxFiles));
  const newest = [...files].sort((a, b) => b.lastModified - a.lastModified).slice(0, limit);
  const kept = new Set(newest.map((file) => file.key));
  return files.filter((file) => kept.has(file.key));
}

/** Append unseen files to the queue (dedupe by `IntakeFile.key`). */
function enqueue(
  base: InstantSessionState,
  incoming: ReadonlyArray<IntakeFile>,
): { queue: IntakeFile[]; seenKeys: Set<string> } {
  const seenKeys = new Set(base.seenKeys);
  const queue = [...base.files];
  for (const file of incoming) {
    if (seenKeys.has(file.key)) continue;
    seenKeys.add(file.key);
    queue.push(file);
  }
  return { queue, seenKeys };
}

function addFiles(
  state: InstantSessionState,
  action: Extract<SessionAction, { type: "files-added" }>,
): InstantSessionState {
  if (isRunningPhase(state.phase)) return state;
  const finished = state.phase === "done" || state.phase === "error";
  const summary: IntakeSummary = {
    found: action.incoming.length,
    added: 0,
    ignored: action.ignored ?? 0,
    rejected: action.failed.length,
  };
  // A selection without replays never discards a finished run's results.
  if (finished && action.incoming.length === 0) return { ...state, lastIntake: summary };
  const base = finished ? initialSessionState(state.dateWindow, state.engineInfo) : state;
  const { queue, seenKeys } = enqueue(base, action.incoming);
  const files = capQueue(queue, action.maxFiles);
  return {
    ...base,
    phase: files.length > 0 ? "ready" : "idle",
    files,
    seenKeys,
    truncatedCount: seenKeys.size - files.length,
    lastIntake: { ...summary, added: queue.length - base.files.length },
    intakeFailed: [...base.intakeFailed, ...action.failed],
  };
}

/** Run results cleared when a new run starts or is cancelled. */
const NO_RUN_RESULTS = {
  progress: null,
  candidates: [],
  meMode: null,
  chosenToon: null,
  parsedWithFiles: [],
  runFailed: [],
  error: null,
} satisfies Partial<InstantSessionState>;

/** Back to the queue after a cancel: run results are discarded. */
function cancelled(state: InstantSessionState): InstantSessionState {
  return { ...state, ...NO_RUN_RESULTS, phase: state.files.length > 0 ? "ready" : "idle", expanding: false };
}

function startStage(state: InstantSessionState, phase: "booting" | "scanning" | "parsing"): InstantSessionState {
  if (phase === "booting") return { ...state, ...NO_RUN_RESULTS, phase };
  return { ...state, phase, progress: null, error: null };
}

type RunAction = Exclude<
  SessionAction,
  { type: "files-added" | "expanding" | "date-window" | "cancelled" | "reset" }
>;
type PassAction = Extract<RunAction, { type: "stage" | "progress" | "engine-info" | "run-failed" }>;
type OutcomeAction = Exclude<RunAction, PassAction>;

/** Progress within an engine pass (stage changes, samples, failures so far). */
function passReducer(state: InstantSessionState, action: PassAction): InstantSessionState {
  switch (action.type) {
    case "stage":
      return startStage(state, action.phase);
    case "progress":
      return isRunningPhase(state.phase) || state.expanding ? { ...state, progress: action.progress } : state;
    case "engine-info":
      return { ...state, engineInfo: action.info };
    case "run-failed":
      return { ...state, runFailed: [...state.runFailed, ...action.failed] };
  }
}

/** How a pass ended: the player question, the answer, results or an error. */
function outcomeReducer(state: InstantSessionState, action: OutcomeAction): InstantSessionState {
  switch (action.type) {
    case "choosing":
      return { ...state, phase: "choosing", progress: null, candidates: action.candidates, meMode: action.meMode };
    case "scanned":
      return { ...state, meMode: action.meMode };
    case "chosen":
      return { ...state, chosenToon: action.toon, candidates: [] };
    case "done":
      return { ...state, phase: "done", progress: null, parsedWithFiles: action.parsedWithFiles };
    case "error":
      return { ...state, phase: "error", expanding: false, progress: null, error: action.kind };
  }
}

const PASS_ACTIONS: ReadonlySet<SessionAction["type"]> = new Set<SessionAction["type"]>([
  "stage",
  "progress",
  "engine-info",
  "run-failed",
]);

function isPassAction(action: RunAction): action is PassAction {
  return PASS_ACTIONS.has(action.type);
}

/** Transitions driven by a running engine pass (boot → scan → parse). */
function runReducer(state: InstantSessionState, action: RunAction): InstantSessionState {
  return isPassAction(action) ? passReducer(state, action) : outcomeReducer(state, action);
}

/**
 * Pure transition function for the session.
 *
 * Example:
 *   sessionReducer(state, { type: "cancelled" }).phase; // -> "ready" (files kept)
 */
export function sessionReducer(state: InstantSessionState, action: SessionAction): InstantSessionState {
  switch (action.type) {
    case "files-added":
      return addFiles(state, action);
    case "expanding":
      return { ...state, expanding: action.value, progress: action.value ? state.progress : null };
    case "date-window":
      return { ...state, dateWindow: action.window };
    case "cancelled":
      return cancelled(state);
    case "reset":
      return initialSessionState(state.dateWindow, state.engineInfo);
    default:
      return runReducer(state, action);
  }
}

/** Tiny external store so async actions always read the latest state. */
export interface SessionStore {
  getState(): InstantSessionState;
  dispatch(action: SessionAction): void;
  subscribe(listener: () => void): () => void;
}

/**
 * A store for `useSyncExternalStore`: `dispatch` applies the reducer
 * synchronously, so `getState()` is current even before React re-renders
 * (e.g. `await session.addFiles(...)` followed by `session.start()`).
 *
 * Example:
 *   const store = createSessionStore(initialSessionState({ kind: "days90" }));
 *   store.dispatch({ type: "reset" });
 */
export function createSessionStore(initial: InstantSessionState): SessionStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(action: SessionAction): void {
      const next = sessionReducer(state, action);
      if (next === state) return;
      state = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
