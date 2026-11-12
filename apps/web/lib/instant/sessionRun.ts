/**
 * Async engine passes of an Instant Analysis run, used by
 * `useInstantSession`: boot + header scan (then "which player is me?"),
 * and parse. Each pass reports coarse state through `dispatch` and returns
 * null when the run was superseded (cancel, reset, unmount) so the caller
 * drops stale results. Engine errors propagate as `EngineError`.
 *
 * The engine is obtained through `getEngine()` only when a pass actually
 * needs it: a run whose files were all filtered out never creates it.
 *
 * Example:
 *   const scanned = await scanFiles(deps, files, rules, profileToons);
 *   if (scanned && !scanned.detection.needsConfirmation) await parseScanned(deps, scanned, null, rules, false);
 */
import { medianMs, trackInstantError, trackInstantParseDone } from "./analytics";
import type { CommanderRow } from "./commanderEvidence";
import { EngineError } from "./engineErrors";
import { detectMe, type MeDetection } from "./meDetection";
import { buildRequests, finalizeOutcomes, splitByDate, triageScans, type EligibleFile, type RunRules } from "./sessionPipeline";
import type { ParsedWithFile, SessionAction } from "./sessionState";
import type { EngineClient, EnginePhase, EngineProgress, ErrorKind, FailedParse, IntakeFile, PlayersResult } from "./types";

/** What a pass needs from the hook. */
export interface RunDeps {
  getEngine(): EngineClient;
  signal: AbortSignal;
  /** False once the run was cancelled, reset or unmounted. */
  isCurrent(): boolean;
  dispatch(action: SessionAction): void;
  /** Progress handler that only forwards events of the given phases. */
  progressFor(...phases: EnginePhase[]): (event: EngineProgress) => void;
}

/** Result of the scan pass; kept while the visitor picks a player. */
export interface ScanOutcome {
  eligible: EligibleFile[];
  detection: MeDetection;
  /** Every file skipped or failed so far in this run. */
  failed: FailedParse[];
}

/** Result of the parse pass. */
export interface RunOutcome {
  parsed: ParsedWithFile[];
  deferredCount: number;
  commanderRows?: CommanderRow[];
  /** Every failure of the run, scan pass included (all already dispatched). */
  failed: FailedParse[];
}

function readHeaders(
  engine: EngineClient,
  deps: RunDeps,
  files: IntakeFile[],
  rules: RunRules,
): Promise<PlayersResult[]> {
  if (rules.maxParsedFiles === undefined) {
    return engine.listPlayers(files, { signal: deps.signal, onProgress: deps.progressFor("players") });
  }
  if (!engine.scanHeaders) throw new EngineError("engine_unavailable", "the browser engine does not support header scans");
  return engine.scanHeaders(files, { signal: deps.signal, onProgress: deps.progressFor("header") });
}

function report(deps: RunDeps, sink: FailedParse[], failed: FailedParse[]): void {
  if (failed.length === 0) return;
  for (const failure of failed) sink.push(failure);
  deps.dispatch({ type: "run-failed", failed });
}

/**
 * Pre-filter by date, boot the engine, scan headers and resolve "me".
 * Returns null when superseded.
 *
 * Example:
 *   const scanned = await scanFiles(deps, state.files, rules, ["1-S2-1-267727"]);
 */
export async function scanFiles(
  deps: RunDeps,
  files: ReadonlyArray<IntakeFile>,
  rules: RunRules,
  profileToons: ReadonlyArray<string>,
): Promise<ScanOutcome | null> {
  const failed: FailedParse[] = [];
  deps.dispatch({ type: "stage", phase: "booting" });
  const { inWindow, skipped } = splitByDate(files, rules);
  report(deps, failed, skipped);
  if (inWindow.length === 0) return { eligible: [], detection: detectMe([]), failed };
  const engine = deps.getEngine();
  const info = await engine.boot({ signal: deps.signal, onProgress: deps.progressFor("boot") });
  if (!deps.isCurrent()) return null;
  deps.dispatch({ type: "engine-info", info });
  deps.dispatch({ type: "stage", phase: "scanning" });
  const scans = await readHeaders(engine, deps, inWindow, rules);
  if (!deps.isCurrent()) return null;
  const triaged = triageScans(inWindow, scans, rules);
  report(deps, failed, triaged.failed);
  const detection = detectMe(
    triaged.eligible.map((entry) => entry.scan),
    { profileToons },
  );
  return { eligible: triaged.eligible, detection, failed };
}

/**
 * Parse eligible replays as `chosenToon` (or the detected player), up to the run cap.
 * Returns null when superseded.
 *
 * Example:
 *   const outcome = await parseScanned(deps, scanned, "1-S2-1-267727", rules, true);
 */
export async function parseScanned(
  deps: RunDeps,
  scanned: ScanOutcome,
  chosenToon: string | null,
  rules: RunRules,
  wantDigests: boolean,
): Promise<RunOutcome | null> {
  const failed: FailedParse[] = [...scanned.failed];
  const { requests, failed: unresolved } = buildRequests(scanned.eligible, scanned.detection, chosenToon, wantDigests);
  report(deps, failed, unresolved);
  const selected = rules.maxParsedFiles === undefined ? requests : requests.slice(0, Math.max(0, rules.maxParsedFiles));
  const deferredCount = requests.length - selected.length;
  if (selected.length === 0) return { parsed: [], failed, deferredCount };
  deps.dispatch({ type: "stage", phase: "parsing" });
  const outcomes = await deps.getEngine().parseFiles(selected, { signal: deps.signal, onProgress: deps.progressFor("parse") });
  if (!deps.isCurrent()) return null;
  const finalized = finalizeOutcomes(selected, outcomes, rules);
  report(deps, failed, finalized.failed);
  const result: RunOutcome = { parsed: finalized.parsed, failed, deferredCount };
  if (scanned.eligible.some(entry => entry.header)) {
    const { commanderHeaderRows } = await import("./commanderEvidence");
    if (!deps.isCurrent()) return null;
    result.commanderRows = commanderHeaderRows(scanned.eligible, scanned.detection, chosenToon, selected, finalized.parsed);
  }
  return result;
}

/**
 * GA4 for a finished run: `instant_parse_done` once, then `instant_error`
 * once per distinct failure kind. Counts and fixed codes only.
 *
 * Example:
 *   trackRunDone(parsed, [...intakeFailed, ...runFailed]);
 */
export function trackRunDone(parsed: ReadonlyArray<ParsedWithFile>, failed: ReadonlyArray<FailedParse>): void {
  trackInstantParseDone({
    ok: parsed.length,
    failed: failed.length,
    medianMs: medianMs(parsed.map((entry) => entry.game.ms)),
  });
  const kinds = new Set<ErrorKind>(failed.map((failure) => failure.errorKind));
  kinds.forEach((kind) => trackInstantError({ kind }));
}
