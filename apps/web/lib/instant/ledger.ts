/**
 * Folder Sync ledger: what happened to each replay file last time.
 *
 * The ledger is keyed by relative path (like the agent's
 * `state.uploaded`, which is keyed by absolute path) and remembers the
 * file's size and `lastModified`, so a re-scan only parses files that
 * are new, changed, or failed for a reason that might go away:
 *
 *   - a transient failure (timeout, out of memory, crashed worker, …) is
 *     retried, but at most `MAX_RETRYABLE_ATTEMPTS` times in all, so one
 *     pathological replay cannot boot the analyzer on every scan forever;
 *   - a replay whose player could not be identified is re-checked only
 *     once the profile learns one of the toons that played in it.
 *
 * Example:
 *   const { toProcess, unchanged } = diffAgainstLedger(files, await loadLedger(), { profileToons });
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
  /** Retryable failures so far (see `MAX_RETRYABLE_ATTEMPTS`). */
  attempts?: number;
  /**
   * `player_unresolved` only: toons that played in the replay but were not
   * on the profile yet. Learning one of them makes the file worth a re-check.
   */
  toons?: string[];
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
  /**
   * The signed-in user's toon handles now. A `player_unresolved` entry
   * whose `toons` include one of them is processed again.
   */
  profileToons?: ReadonlyArray<string>;
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
 * A file that failed for a retryable reason this many times is settled:
 * the replay itself is the likely cause (e.g. it times out every time).
 * `retryFailed` still re-processes it.
 */
export const MAX_RETRYABLE_ATTEMPTS = 3;

/**
 * Split files into those that need work and those the ledger already
 * settled. A file is unchanged when its path, size and lastModified
 * match an entry whose status is `uploaded`/`skipped`, or `failed` with
 * a kind that is not retryable (or retried `MAX_RETRYABLE_ATTEMPTS`
 * times), unless it is an unresolved player the profile now knows.
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
  return isFailureSettled(entry, options);
}

function isFailureSettled(entry: LedgerEntry, options: LedgerDiffOptions): boolean {
  if (options.retryFailed || !entry.errorKind) return false;
  if (entry.errorKind === "player_unresolved") return !knowsNewToon(entry, options.profileToons);
  if (!isRetryableKind(entry.errorKind, options.retryableKinds)) return true;
  return (entry.attempts ?? 0) >= MAX_RETRYABLE_ATTEMPTS;
}

function knowsNewToon(entry: LedgerEntry, profileToons: ReadonlyArray<string> = []): boolean {
  return (entry.toons ?? []).some((toon) => profileToons.includes(toon));
}

/**
 * True when some unresolved-player entry could be settled by the profile's
 * toons, i.e. the caller should load them before diffing.
 *
 * Example:
 *   if (needsProfileToons(ledger)) toons = await fetchProfileToons(getToken, apiCall);
 */
export function needsProfileToons(ledger: Iterable<LedgerEntry>): boolean {
  for (const entry of ledger) {
    if (entry.errorKind === "player_unresolved" && (entry.toons?.length ?? 0) > 0) return true;
  }
  return false;
}

/**
 * Build a ledger entry for a file (convenience for callers).
 *
 * Example:
 *   ledgerEntryFor(file, "uploaded", Date.now(), { gameId });
 *   ledgerEntryFor(file, "failed", Date.now(), { errorKind: "timeout", attempts: 2 });
 */
export function ledgerEntryFor(
  file: LedgerCandidate,
  status: LedgerStatus,
  now: number,
  extra: Pick<LedgerEntry, "gameId" | "errorKind" | "attempts" | "toons"> = {},
): LedgerEntry {
  return {
    path: file.relativePath,
    size: file.size,
    lastModified: file.lastModified,
    status,
    ...(extra.gameId ? { gameId: extra.gameId } : {}),
    ...(extra.errorKind ? { errorKind: extra.errorKind } : {}),
    ...(extra.attempts ? { attempts: extra.attempts } : {}),
    ...(extra.toons && extra.toons.length > 0 ? { toons: [...extra.toons] } : {}),
    updatedAt: now,
  };
}

/**
 * Whether a failure kind is retried on a later scan (the attempt cap aside).
 *
 * Example:
 *   isRetryableKind("timeout"); // -> true
 */
export function isRetryableKind(kind: ErrorKind, retryable: ReadonlyArray<ErrorKind> = DEFAULT_RETRYABLE_KINDS): boolean {
  return retryable.includes(kind);
}
