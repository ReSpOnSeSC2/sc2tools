/**
 * Folder Sync ledger: what happened to each replay file last time.
 *
 * The ledger is keyed by relative path (like the agent's
 * `state.uploaded`, which is keyed by absolute path) and remembers the
 * file's size and `lastModified`, so a re-scan only parses files that
 * are new, changed, or failed for a reason that might go away.
 *
 * Example:
 *   const { toProcess, unchanged } = diffAgainstLedger(files, await loadLedger());
 */
import type { ErrorKind } from "./types";

export type LedgerStatus = "uploaded" | "skipped" | "failed";

export interface LedgerEntry {
  /** Relative path from the picked folder (the ledger key). */
  path: string;
  size: number;
  lastModified: number;
  status: LedgerStatus;
  gameId?: string;
  errorKind?: ErrorKind;
  /** Epoch ms of the last status change. */
  updatedAt: number;
}

/** File shape the diff needs (IntakeFile and Folder Sync entries both fit). */
export interface LedgerCandidate {
  relativePath: string;
  size: number;
  lastModified: number;
}

export interface LedgerDiffOptions {
  /** Re-process every failed file regardless of its error kind. */
  retryFailed?: boolean;
  /** Failure kinds that are transient and should be retried on re-scan. */
  retryableKinds?: ReadonlyArray<ErrorKind>;
  /**
   * Skip kinds that depend on the visitor's choices rather than the file
   * (e.g. `outside_date_range` after widening the window to "All time").
   */
  reprocessSkippedKinds?: ReadonlyArray<ErrorKind>;
}

export interface LedgerDiff<T extends LedgerCandidate> {
  toProcess: T[];
  unchanged: T[];
}

/**
 * Every ErrorKind, as a record so the compiler flags a missing entry
 * whenever the union in types.ts grows.
 */
const ERROR_KINDS: Record<ErrorKind, true> = {
  unsupported_version: true,
  corrupt_file: true,
  not_a_replay: true,
  ai_game: true,
  player_unresolved: true,
  player_ambiguous: true,
  no_result: true,
  parse_failed: true,
  analysis_failed: true,
  playback_budget_exceeded: true,
  engine_unavailable: true,
  timeout: true,
  out_of_memory: true,
  not_1v1: true,
  resumed_replay: true,
  outside_date_range: true,
  too_large: true,
  cancelled: true,
  integrity_failed: true,
  engine_boot_failed: true,
  worker_crashed: true,
};

/**
 * Runtime guard for values read back from storage.
 *
 * Example:
 *   isErrorKind("timeout"); // -> true
 *   isErrorKind("nope");    // -> false
 */
export function isErrorKind(value: string): value is ErrorKind {
  return Object.prototype.hasOwnProperty.call(ERROR_KINDS, value);
}

/**
 * Failures caused by the browser session rather than by the replay.
 * A failed entry without an `errorKind` (e.g. an interrupted upload) is
 * always retried.
 */
export const DEFAULT_RETRYABLE_KINDS: ReadonlyArray<ErrorKind> = [
  "timeout",
  "out_of_memory",
  "cancelled",
  "engine_unavailable",
  "engine_boot_failed",
  "integrity_failed",
  "worker_crashed",
];

/**
 * Split files into those that need work and those the ledger already
 * settled. A file is unchanged when its path, size and lastModified
 * match an entry whose status is `uploaded`/`skipped`, or `failed` with
 * a kind that is not retryable.
 *
 * Example:
 *   diffAgainstLedger(files, entries, { retryFailed: true }).toProcess;
 */
export function diffAgainstLedger<T extends LedgerCandidate>(
  files: ReadonlyArray<T>,
  ledger: Iterable<LedgerEntry>,
  options: LedgerDiffOptions = {},
): LedgerDiff<T> {
  const byPath = new Map<string, LedgerEntry>();
  for (const entry of ledger) byPath.set(entry.path, entry);
  const toProcess: T[] = [];
  const unchanged: T[] = [];
  for (const file of files) {
    const entry = byPath.get(file.relativePath);
    if (entry && isSettled(entry, file, options)) unchanged.push(file);
    else toProcess.push(file);
  }
  return { toProcess, unchanged };
}

function isSettled(
  entry: LedgerEntry,
  file: LedgerCandidate,
  options: LedgerDiffOptions,
): boolean {
  if (entry.size !== file.size || entry.lastModified !== file.lastModified) return false;
  if (entry.status === "uploaded") return true;
  if (entry.status === "skipped") {
    const reprocess = options.reprocessSkippedKinds ?? [];
    return !(entry.errorKind && reprocess.includes(entry.errorKind));
  }
  if (options.retryFailed || !entry.errorKind) return false;
  const retryable = options.retryableKinds ?? DEFAULT_RETRYABLE_KINDS;
  return !retryable.includes(entry.errorKind);
}

/**
 * Build a ledger entry for a file (convenience for callers).
 *
 * Example:
 *   ledgerEntryFor(file, "uploaded", Date.now(), { gameId });
 */
export function ledgerEntryFor(
  file: LedgerCandidate,
  status: LedgerStatus,
  now: number,
  extra: { gameId?: string; errorKind?: ErrorKind } = {},
): LedgerEntry {
  return {
    path: file.relativePath,
    size: file.size,
    lastModified: file.lastModified,
    status,
    ...(extra.gameId ? { gameId: extra.gameId } : {}),
    ...(extra.errorKind ? { errorKind: extra.errorKind } : {}),
    updatedAt: now,
  };
}
