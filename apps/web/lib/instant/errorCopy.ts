/**
 * Friendly copy for every Instant Analysis `ErrorKind`, plus a grouped
 * failure summary for progress and import-summary views.
 *
 * Wording reuses the desktop importer's `ERROR_CODE_COPY`
 * (`components/imports/useImportStatus.ts`) where the codes overlap, so a
 * replay that fails in the browser reads the same as one the agent skipped.
 * Copy never names a file or a player: views show counts per kind only.
 *
 * Example:
 *   errorCopy("ai_game"); // -> { title: "Games vs the AI", hint: "Skipped — game vs the AI." }
 *   summarizeFailures(failed); // -> [{ kind: "ai_game", count: 2, skipped: true, copy }]
 */
import type { ErrorKind, FailedParse } from "./types";

/** Short title + one-sentence hint for one error kind. */
export interface ErrorCopy {
  title: string;
  hint: string;
}

/** One row of a grouped failure summary. */
export interface FailureGroup {
  kind: ErrorKind;
  count: number;
  /** True when the file was deliberately skipped rather than failing. */
  skipped: boolean;
  copy: ErrorCopy;
}

const RELOAD_HINT = "Reload the page and try again.";

const ERROR_COPY: Record<ErrorKind, ErrorCopy> = {
  unsupported_version: {
    title: "Replay from a newer patch",
    hint:
      "This replay may be from a newer StarCraft II patch than the analyzer supports yet. " +
      "Try again after the next update, or import it with the desktop agent.",
  },
  corrupt_file: {
    title: "Corrupt or cut-off file",
    hint: "File looks corrupt, cut off, or from an unsupported SC2 version.",
  },
  not_a_replay: {
    title: "Not a replay",
    hint: "This file is not a StarCraft II replay.",
  },
  ai_game: {
    title: "Games vs the AI",
    hint: "Skipped — game vs the AI.",
  },
  player_unresolved: {
    title: "Couldn't tell which player is you",
    hint:
      "Couldn't tell which player is you — you may not have played in this replay. " +
      "Importing from your Accounts folder identifies you exactly.",
  },
  player_ambiguous: {
    title: "More than one matching player",
    hint: "Two players in this replay match your name, so we couldn't tell which one is you.",
  },
  no_result: {
    title: "No result recorded",
    hint: "The replay has no recorded result (left during loading?).",
  },
  parse_failed: {
    title: "Couldn't read the replay",
    hint: "File looks corrupt, cut off, or from an unsupported SC2 version.",
  },
  analysis_failed: {
    title: "Analysis failed",
    hint: "The analyzer hit an unexpected error on this replay. The desktop agent may still import it.",
  },
  playback_budget_exceeded: {
    title: "Replay too long to analyse here",
    hint: "This game is too long to analyse inside the browser's memory budget. The desktop agent can import it.",
  },
  engine_unavailable: {
    title: "Analyzer was updated",
    hint: `A newer version of the analyzer is available. ${RELOAD_HINT}`,
  },
  timeout: {
    title: "Took too long",
    hint: "The analyzer stopped this replay after a minute. Close other tabs and try again.",
  },
  out_of_memory: {
    title: "Ran out of memory",
    hint: "Your browser ran out of memory on this replay. Close other tabs or try fewer replays at once.",
  },
  not_1v1: {
    title: "Not a 1v1 game",
    hint: "Skipped — only 1v1 games are analysed.",
  },
  resumed_replay: {
    title: "Resumed from a replay",
    hint: "Skipped — a replay-resume session is not a new ladder result.",
  },
  outside_date_range: {
    title: "Outside the date range",
    hint: "Skipped — outside your import date range.",
  },
  too_large: {
    title: "File too large",
    hint: "This file is much larger than any ladder replay, so it was not opened.",
  },
  cancelled: {
    title: "Cancelled",
    hint: "Stopped before this replay was analysed.",
  },
  integrity_failed: {
    title: "Download check failed",
    hint: `The analyzer download didn't match its checksum (a proxy or extension may have changed it). ${RELOAD_HINT}`,
  },
  engine_boot_failed: {
    title: "Analyzer couldn't start",
    hint: `The analyzer couldn't start in this browser. ${RELOAD_HINT} If it keeps failing, try an up-to-date Chrome, Edge, Firefox or Safari.`,
  },
  worker_crashed: {
    title: "Analyzer crashed",
    hint: "The analyzer crashed on this replay and was restarted for the rest.",
  },
};

/** Kinds that mean "deliberately not imported", not "something broke". */
const SKIP_KINDS: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  "ai_game",
  "not_1v1",
  "resumed_replay",
  "outside_date_range",
  "cancelled",
]);

/**
 * Title + hint for an error kind.
 *
 * Example:
 *   errorCopy("unsupported_version").title; // -> "Replay from a newer patch"
 */
export function errorCopy(kind: ErrorKind): ErrorCopy {
  return ERROR_COPY[kind];
}

/**
 * True when the kind is a deliberate skip (vs the AI, not 1v1, resumed,
 * outside the date window, cancelled) rather than a failure.
 *
 * Example:
 *   isSkipKind("ai_game"); // -> true
 *   isSkipKind("corrupt_file"); // -> false
 */
export function isSkipKind(kind: ErrorKind): boolean {
  return SKIP_KINDS.has(kind);
}

/**
 * Count failures per kind, most frequent first (ties keep first-seen
 * order). Failures come before skips so real problems are read first.
 *
 * Example:
 *   summarizeFailures([{ errorKind: "ai_game", ... }, { errorKind: "ai_game", ... }]);
 *   // -> [{ kind: "ai_game", count: 2, skipped: true, copy: {...} }]
 */
export function summarizeFailures(failed: ReadonlyArray<Pick<FailedParse, "errorKind">>): FailureGroup[] {
  const counts = new Map<ErrorKind, number>();
  for (const failure of failed) counts.set(failure.errorKind, (counts.get(failure.errorKind) ?? 0) + 1);
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count, skipped: isSkipKind(kind), copy: errorCopy(kind) }))
    .sort((a, b) => Number(a.skipped) - Number(b.skipped) || b.count - a.count);
}
