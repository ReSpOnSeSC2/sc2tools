"use client";

/**
 * `useInstantSession` — the React state machine behind every Instant
 * Analysis surface (/try, the signed-in browser import, Folder Sync):
 *
 *   addFiles → (ready) → start → booting → scanning → [choosing → choose] → parsing → done
 *
 * The engine worker is created lazily by the first action that needs it
 * (`start()`, or adding a .zip) — never on mount — and disposed on unmount.
 * Files are read one at a time by the engine client, and progress reaches
 * React at most every 100 ms, so the main thread never blocks.
 *
 * The run logic lives in `sessionController.ts` / `sessionRun.ts` /
 * `sessionPipeline.ts`; the state shape in `sessionState.ts`.
 *
 * Example:
 *   const session = useInstantSession({ maxFiles: MAX_TRY_FILES, onlyOneVsOne: true });
 *   <ReplayIntake onFiles={session.addFiles} fileCount={session.files.length} ... />
 *   <Button onClick={() => void session.start()} disabled={session.phase !== "ready"}>Analyse</Button>
 *   {session.phase === "choosing" && <PlayerChooser candidates={session.candidates} onChoose={session.choose} onCancel={session.cancel} />}
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { estimateParseSeconds, preFilterByDate, type DateWindow, type ParseEstimate } from "./fileIntake";
import type { MeCandidate, MeDetectionMode } from "./meDetection";
import { createSessionController, type SessionActions, type SessionControllerOptions } from "./sessionController";
import {
  createSessionStore,
  initialSessionState,
  isRunningPhase,
  type InstantSessionPhase,
  type IntakeSummary,
  type ParsedWithFile,
  type SessionProgress,
} from "./sessionState";
import type { EngineInfo, ErrorKind, FailedParse, IntakeFile, ParsedGame } from "./types";

export type { InstantSessionPhase, IntakeSummary, ParsedWithFile, SessionProgress } from "./sessionState";

/** Default import window: the last 90 days. */
export const DEFAULT_DATE_WINDOW: DateWindow = { kind: "days90" };

export interface UseInstantSessionOptions extends SessionControllerOptions {
  /** Starting date window; "Last 90 days" when omitted. */
  initialDateWindow?: DateWindow;
}

/** Everything a view needs: read-only state plus actions. */
export interface InstantSession extends SessionActions {
  phase: InstantSessionPhase;
  /** Queued replays (filtered, zip-expanded, deduped, capped at `maxFiles`). */
  files: IntakeFile[];
  /** Unique replays left out because of `maxFiles` (newest are kept). */
  truncatedCount: number;
  /** True while a .zip is being unpacked. */
  expanding: boolean;
  /** What the latest selection contained (e.g. "no replays found"). */
  lastIntake: IntakeSummary | null;
  /** True while intake and the date window are locked. */
  busy: boolean;
  dateWindow: DateWindow;
  /** Rough time for the queued replays in the window; null when none. */
  estimate: ParseEstimate | null;
  progress: SessionProgress | null;
  candidates: MeCandidate[];
  meMode: MeDetectionMode | null;
  chosenToon: string | null;
  parsed: ParsedGame[];
  /** Parsed games with their original file (upload + replay backup). */
  parsedWithFiles: ParsedWithFile[];
  /** Intake rejects first, then this run's skips and failures. */
  failed: FailedParse[];
  error: ErrorKind | null;
  engineInfo: EngineInfo | null;
}

function estimateFor(
  files: ReadonlyArray<IntakeFile>,
  dateWindow: DateWindow,
  engineInfo: EngineInfo | null,
): ParseEstimate | null {
  const count = preFilterByDate(files, dateWindow, Date.now()).length;
  return count > 0 ? estimateParseSeconds(count, { warm: engineInfo !== null }) : null;
}

/**
 * Drive one Instant Analysis session (see module comment).
 *
 * Example:
 *   const session = useInstantSession({ profileToons, wantDigests: true });
 *   await session.addFiles(event.target.files ?? [], "picker");
 *   await session.start();
 */
export function useInstantSession(options: UseInstantSessionOptions = {}): InstantSession {
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });
  const [store] = useState(() =>
    createSessionStore(initialSessionState(options.initialDateWindow ?? DEFAULT_DATE_WINDOW)),
  );
  const [controller] = useState(() => createSessionController(store, () => optionsRef.current));
  useEffect(() => {
    controller.activate();
    return () => controller.dispose();
  }, [controller]);
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const { files, dateWindow, engineInfo } = state;
  const estimate = useMemo(() => estimateFor(files, dateWindow, engineInfo), [files, dateWindow, engineInfo]);
  const parsed = useMemo(() => state.parsedWithFiles.map((entry) => entry.game), [state.parsedWithFiles]);
  const failed = useMemo(() => [...state.intakeFailed, ...state.runFailed], [state.intakeFailed, state.runFailed]);
  // One stable object per state change, so callers can list it in effect deps.
  return useMemo(
    () => ({
      phase: state.phase,
      files,
      truncatedCount: state.truncatedCount,
      expanding: state.expanding,
      lastIntake: state.lastIntake,
      busy: isRunningPhase(state.phase) || state.expanding,
      dateWindow,
      estimate,
      progress: state.progress,
      candidates: state.candidates,
      meMode: state.meMode,
      chosenToon: state.chosenToon,
      parsed,
      parsedWithFiles: state.parsedWithFiles,
      failed,
      error: state.error,
      engineInfo,
      addFiles: controller.addFiles,
      setDateWindow: controller.setDateWindow,
      start: controller.start,
      choose: controller.choose,
      cancel: controller.cancel,
      reset: controller.reset,
      lastHeapBytes: controller.lastHeapBytes,
    }),
    [state, files, dateWindow, engineInfo, estimate, parsed, failed, controller],
  );
}
