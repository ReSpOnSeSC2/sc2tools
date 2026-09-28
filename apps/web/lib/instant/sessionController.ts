/**
 * The imperative half of `useInstantSession`: owns the one `EngineClient`,
 * the current run (id + AbortController), the progress throttle and the
 * "which player are you?" pause, and turns user actions into store updates.
 *
 * Lifecycle rules:
 *   - The engine (and so the worker and Pyodide) is created on the first
 *     action that needs it — `prewarm()` on the visitor's first intent,
 *     `start()` or adding a .zip — never on mount (see sessionEngine.ts).
 *   - Every run gets an id; `cancel()`, `reset()` and `dispose()` bump it,
 *     so late engine answers from a superseded run are dropped.
 *   - `lifecycle.dispose()` releases the engine; `lifecycle.activate()`
 *     makes the controller usable again (React StrictMode mounts effects
 *     twice in development).
 *
 * Example:
 *   const store = createSessionStore(initialSessionState({ kind: "days90" }));
 *   const { actions, lifecycle } = createSessionController(store, () => ({ maxFiles: 25 }));
 *   await actions.addFiles(files, "picker");
 *   await actions.start();
 */
import { trackInstantError, trackInstantFilesSelected } from "./analytics";
import { createEngineClient } from "./engineClient";
import { EngineError } from "./engineErrors";
import type { DateWindow } from "./fileIntake";
import { SessionEngine } from "./sessionEngine";
import { expandArchives, selectionSource, sortSelection, type ExpandResult } from "./sessionIntake";
import type { RunRules } from "./sessionPipeline";
import { createThrottle, toSessionProgress, type Throttle } from "./sessionProgress";
import { parseScanned, scanFiles, trackRunDone, type RunDeps, type ScanOutcome } from "./sessionRun";
import {
  isRunningPhase,
  type InstantSessionPhase,
  type SessionAction,
  type SessionProgress,
  type SessionStore,
} from "./sessionState";
import type { EngineClient, EnginePhase, ErrorKind, IntakeFile, IntakeSource } from "./types";

/** Behaviour switches read at the moment each action runs. */
export interface SessionControllerOptions {
  /** Cap on queued replays (newest kept); unlimited when omitted. */
  maxFiles?: number;
  /** Skip team/FFA games and resumed-from-replay sessions. */
  onlyOneVsOne?: boolean;
  /** The signed-in user's saved toon handles ("which player is me?"). */
  profileToons?: ReadonlyArray<string>;
  /** Also hash the original bytes (needed for the replay backup). */
  wantDigests?: boolean;
  /** Engine factory; defaults to `createEngineClient` (tests inject a mock). */
  clientFactory?: () => EngineClient;
}

/** User actions exposed by the session hook (bound: safe to pass as callbacks). */
export interface SessionActions {
  /**
   * Queue replays (non-replays ignored, .zip unpacked, deduped, capped).
   * Ignored while a run is in progress. Fires `instant_files_selected`
   * with the replays found in this selection.
   */
  addFiles(files: File[] | FileList, source: IntakeSource): Promise<void>;
  /** Change the date window (not during a run). */
  setDateWindow(window: DateWindow): void;
  /** Run the queue; also re-runs it from `done` or `error`. */
  start(): Promise<void>;
  /** Answer "which player are you?" and parse. */
  choose(toon: string): Promise<void>;
  /** Stop a run or .zip unpacking; back to `ready` with the queue kept. */
  cancel(): void;
  /** Forget the queue and all results (the warm engine is kept). */
  reset(): void;
  /**
   * Start booting the engine ahead of the first run. Call on the visitor's
   * first intent to add replays, never on mount; idempotent and silent.
   */
  prewarm(): void;
  /** Engine heap after the latest boot/parse (memory budget), or null. */
  lastHeapBytes(): number | null;
}

/** Mount/unmount hooks for the owning component. */
export interface SessionLifecycle {
  activate(): void;
  dispose(): void;
}

export interface SessionController {
  actions: SessionActions;
  lifecycle: SessionLifecycle;
}

interface RunHandle extends RunDeps {
  id: number;
}

interface PendingChoice {
  deps: RunHandle;
  scanned: ScanOutcome;
  rules: RunRules;
}

const NO_ARCHIVES: ExpandResult = { replays: [], rejected: [], fatal: null };
const SUPERSEDED = "the run was cancelled or replaced";
/** `start()` runs from a queued selection, or re-runs it after a finish or an error. */
const STARTABLE_PHASES: ReadonlySet<InstantSessionPhase> = new Set<InstantSessionPhase>(["ready", "done", "error"]);

/** Seven public actions; the engine and its lifecycle live in `SessionEngine`. */
class InstantSessionController {
  private runId = 0;
  private abort: AbortController | null = null;
  private pending: PendingChoice | null = null;
  private readonly throttle: Throttle<SessionProgress>;

  constructor(
    private readonly store: SessionStore,
    private readonly options: () => SessionControllerOptions,
    private readonly engine: SessionEngine,
  ) {
    this.throttle = createThrottle((progress) => this.store.dispatch({ type: "progress", progress }));
    engine.onDispose(() => this.supersede());
  }

  readonly addFiles = async (input: File[] | FileList, source: IntakeSource): Promise<void> => {
    if (this.engine.isDisposed() || this.locked()) return;
    const selection = sortSelection(Array.from(input), source);
    const expanded = selection.zips.length > 0 ? await this.expand(selection.zips) : NO_ARCHIVES;
    if (!expanded) return;
    const replays = [...selection.replays, ...expanded.replays];
    this.store.dispatch({
      type: "files-added",
      incoming: replays,
      failed: [...selection.rejected, ...expanded.rejected],
      ignored: selection.ignoredCount,
      maxFiles: this.options().maxFiles,
    });
    if (replays.length > 0) {
      trackInstantFilesSelected({ count: replays.length, source: selectionSource(source, selection.zips.length > 0) });
    }
  };

  readonly setDateWindow = (window: DateWindow): void => {
    if (!isRunningPhase(this.store.getState().phase)) this.store.dispatch({ type: "date-window", window });
  };

  readonly start = async (): Promise<void> => {
    const state = this.store.getState();
    if (this.engine.isDisposed() || !STARTABLE_PHASES.has(state.phase) || state.expanding || state.files.length === 0) return;
    const deps = this.beginRun();
    const options = this.options();
    const rules: RunRules = { dateWindow: state.dateWindow, now: Date.now(), onlyOneVsOne: options.onlyOneVsOne === true };
    try {
      const scanned = await scanFiles(deps, state.files, rules, options.profileToons ?? []);
      if (!scanned) return;
      if (scanned.detection.needsConfirmation) {
        this.pending = { deps, scanned, rules };
        deps.dispatch({ type: "choosing", candidates: scanned.detection.candidates, meMode: scanned.detection.mode });
        return;
      }
      deps.dispatch({ type: "scanned", meMode: scanned.detection.mode });
      await this.parse(deps, scanned, null, rules);
    } catch (error) {
      this.fail(deps.id, error);
    }
  };

  readonly choose = async (toon: string): Promise<void> => {
    const pending = this.pending;
    if (!pending || !pending.deps.isCurrent() || this.store.getState().phase !== "choosing") return;
    this.pending = null;
    pending.deps.dispatch({ type: "chosen", toon });
    try {
      await this.parse(pending.deps, pending.scanned, toon, pending.rules);
    } catch (error) {
      this.fail(pending.deps.id, error);
    }
  };

  readonly cancel = (): void => {
    if (!this.locked()) return;
    this.supersede();
    this.settle({ type: "cancelled" });
  };

  readonly reset = (): void => {
    this.supersede();
    this.settle({ type: "reset" });
  };

  readonly prewarm = (): void => this.engine.prewarm();

  private locked(): boolean {
    const state = this.store.getState();
    return isRunningPhase(state.phase) || state.expanding;
  }

  private isCurrent(id: number): boolean {
    return !this.engine.isDisposed() && id === this.runId;
  }

  /** Drop the pending progress sample, then apply `action`. */
  private settle(action: SessionAction): void {
    this.throttle.cancel();
    this.store.dispatch(action);
  }

  /** Invalidate the current run (its late answers are ignored) and abort it. */
  private supersede(): void {
    this.runId += 1;
    this.abort?.abort();
    this.abort = null;
    this.pending = null;
    this.throttle.cancel();
  }

  private beginRun(): RunHandle {
    this.supersede();
    const controller = new AbortController();
    this.abort = controller;
    const id = this.runId;
    return {
      id,
      signal: controller.signal,
      getEngine: () => {
        // A superseded run (cancel, reset, unmount) must never spawn a worker.
        if (!this.isCurrent(id)) throw new EngineError("cancelled", SUPERSEDED);
        return this.engine.get();
      },
      isCurrent: () => this.isCurrent(id),
      dispatch: (action) => {
        if (this.isCurrent(id)) this.settle(action);
      },
      progressFor: (...phases: EnginePhase[]) => (event) => {
        if (this.isCurrent(id) && phases.includes(event.phase)) this.throttle.push(toSessionProgress(event));
      },
    };
  }

  private async expand(zips: ReadonlyArray<IntakeFile>): Promise<ExpandResult | null> {
    const deps = this.beginRun();
    deps.dispatch({ type: "expanding", value: true });
    let result: ExpandResult;
    try {
      result = await expandArchives(deps.getEngine(), zips, {
        signal: deps.signal,
        onProgress: deps.progressFor("boot", "unzip"),
      });
    } catch (error) {
      // expandArchives settles every archive itself; only creating the engine
      // can throw. Never leave `expanding` stuck (it locks intake).
      this.fail(deps.id, error);
      return null;
    }
    if (!deps.isCurrent()) return null;
    this.abort = null;
    deps.dispatch({ type: "expanding", value: false });
    if (!result.fatal) return result;
    deps.dispatch({ type: "error", kind: result.fatal.kind });
    trackInstantError({ kind: result.fatal.kind });
    return null;
  }

  private async parse(deps: RunHandle, scanned: ScanOutcome, toon: string | null, rules: RunRules): Promise<void> {
    const outcome = await parseScanned(deps, scanned, toon, rules, this.options().wantDigests === true);
    if (!outcome) return;
    this.abort = null;
    deps.dispatch({ type: "done", parsedWithFiles: outcome.parsed });
    trackRunDone(outcome.parsed, [...this.store.getState().intakeFailed, ...outcome.failed]);
  }

  private fail(id: number, error: unknown): void {
    if (!this.isCurrent(id)) return;
    this.abort = null;
    const kind: ErrorKind = error instanceof EngineError ? error.kind : "worker_crashed";
    if (kind === "cancelled") {
      this.settle({ type: "cancelled" });
      return;
    }
    this.settle({ type: "error", kind });
    trackInstantError({ kind });
  }
}

/**
 * Create the controller behind `useInstantSession`: bound actions for the
 * views and lifecycle hooks for the owning component. `options` is read
 * lazily on every action, so the latest props always apply.
 *
 * Example:
 *   const { actions, lifecycle } = createSessionController(store, () => optionsRef.current);
 *   useEffect(() => { lifecycle.activate(); return lifecycle.dispose; }, []);
 */
export function createSessionController(
  store: SessionStore,
  options: () => SessionControllerOptions,
): SessionController {
  const engine = new SessionEngine(() => (options().clientFactory ?? createEngineClient)());
  const controller = new InstantSessionController(store, options, engine);
  const { addFiles, setDateWindow, start, choose, cancel, reset, prewarm } = controller;
  return {
    actions: { addFiles, setDateWindow, start, choose, cancel, reset, prewarm, lastHeapBytes: () => engine.heapBytes() },
    lifecycle: { activate: () => engine.activate(), dispose: () => engine.dispose() },
  };
}
