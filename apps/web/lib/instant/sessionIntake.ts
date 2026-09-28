/**
 * Intake step of `useInstantSession`: sort a raw browser selection into
 * replays, .zip archives and rejects, and unpack archives through the
 * engine (Python `zipfile` inside the worker, zip-bomb guarded).
 *
 * Files that are neither `*.SC2Replay` nor `*.zip` are ignored silently
 * (a picked folder is full of banks and screenshots); replays over
 * `MAX_REPLAY_BYTES` are rejected as `too_large` without being read.
 *
 * Example:
 *   const selection = sortSelection(Array.from(input.files), "picker");
 *   const unpacked = await expandArchives(engine, selection.zips, { signal });
 */
import { EngineError, safeDetail } from "./engineErrors";
import { failedParse } from "./engineOutcome";
import { MAX_REPLAY_BYTES, isReplayFileName, isZipFileName, makeIntakeFile } from "./fileIntake";
import type { EngineClient, ErrorKind, FailedParse, IntakeFile, IntakeSource, ParseOptions } from "./types";

/** A browser selection split by what we will do with each file. */
export interface IntakeSelection {
  replays: IntakeFile[];
  zips: IntakeFile[];
  rejected: FailedParse[];
  /** Neither a replay nor an archive; ignored without a message. */
  ignoredCount: number;
}

/** What unpacking a list of archives produced. */
export interface ExpandResult {
  replays: IntakeFile[];
  rejected: FailedParse[];
  /** Set when the engine itself could not start; the caller stops. */
  fatal: EngineError | null;
}

/** Kinds that mean the engine cannot run at all (not this one archive). */
const ENGINE_START_KINDS: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  "engine_boot_failed",
  "integrity_failed",
  "engine_unavailable",
]);
const UNZIP_FAILED = "the archive could not be unpacked";

/**
 * True when an engine error means the analyzer cannot start in this tab.
 *
 * Example:
 *   isEngineStartFailure("integrity_failed"); // -> true
 */
export function isEngineStartFailure(kind: ErrorKind): boolean {
  return ENGINE_START_KINDS.has(kind);
}

/**
 * A `FailedParse` for a file that never reached the parser.
 *
 * Example:
 *   intakeFailure(file, "too_large").errorKind; // -> "too_large"
 */
export function intakeFailure(
  file: Pick<IntakeFile, "name" | "relativePath">,
  kind: ErrorKind,
  detail?: string,
): FailedParse {
  return failedParse({ fileName: file.name, relativePath: file.relativePath, ms: 0 }, kind, detail);
}

/**
 * Keep replays within the size guard; reject the rest as `too_large`.
 *
 * Example:
 *   acceptReplays([small, huge]); // -> { replays: [small], rejected: [too_large for huge] }
 */
export function acceptReplays(files: ReadonlyArray<IntakeFile>): { replays: IntakeFile[]; rejected: FailedParse[] } {
  const replays: IntakeFile[] = [];
  const rejected: FailedParse[] = [];
  for (const file of files) {
    if (!isReplayFileName(file.name)) continue;
    if (file.size > MAX_REPLAY_BYTES) rejected.push(intakeFailure(file, "too_large"));
    else replays.push(file);
  }
  return { replays, rejected };
}

/**
 * Split a browser selection into replays, archives and rejects.
 *
 * Example:
 *   sortSelection([replay, zip, png], "drop"); // -> { replays: [replay], zips: [zip], rejected: [], ignoredCount: 1 }
 */
export function sortSelection(files: ReadonlyArray<File>, source: IntakeSource): IntakeSelection {
  const candidates: IntakeFile[] = [];
  const zips: IntakeFile[] = [];
  let ignoredCount = 0;
  for (const file of files) {
    if (isReplayFileName(file.name)) candidates.push(makeIntakeFile(file, source));
    else if (isZipFileName(file.name)) zips.push(makeIntakeFile(file, source));
    else ignoredCount += 1;
  }
  const { replays, rejected } = acceptReplays(candidates);
  return { replays, zips, rejected, ignoredCount };
}

/**
 * GA4 source for a selection: a selection that contained an archive
 * counts as `zip`.
 *
 * Example:
 *   selectionSource("drop", true); // -> "zip"
 */
export function selectionSource(source: IntakeSource, hadZip: boolean): IntakeSource {
  return hadZip ? "zip" : source;
}

/**
 * Unpack archives one at a time through the engine. A broken or oversized
 * archive is rejected on its own; an engine that cannot start stops the
 * whole step (`fatal`). Cancellation returns what was unpacked so far.
 *
 * Example:
 *   const { replays, rejected, fatal } = await expandArchives(engine, zips, { signal });
 */
export async function expandArchives(
  engine: EngineClient,
  zips: ReadonlyArray<IntakeFile>,
  options: ParseOptions,
): Promise<ExpandResult> {
  const result: ExpandResult = { replays: [], rejected: [], fatal: null };
  for (const zip of zips) {
    if (options.signal?.aborted) break;
    try {
      const accepted = acceptReplays(await engine.expandZip(zip, options));
      result.replays.push(...accepted.replays);
      result.rejected.push(...accepted.rejected);
    } catch (error) {
      const failure = error instanceof EngineError ? error : new EngineError("corrupt_file", safeDetail(error, UNZIP_FAILED));
      if (failure.kind === "cancelled") break;
      if (isEngineStartFailure(failure.kind)) return { ...result, fatal: failure };
      result.rejected.push(intakeFailure(zip, failure.kind, failure.detail));
    }
  }
  return result;
}
