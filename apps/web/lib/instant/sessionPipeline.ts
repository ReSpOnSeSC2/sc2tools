/**
 * Pure decisions of an Instant Analysis run (no engine, no React):
 * which queued replays are scanned, which scanned replays are parsed and
 * for which player, and which parsed games are kept.
 *
 * Rules, in order:
 *   1. `lastModified` pre-filter against the date window (7-day slack).
 *   2. Header scan: unreadable → its error kind; replay date outside the
 *      window → `outside_date_range`; vs the AI → `ai_game`;
 *      `onlyOneVsOne` and not a 1v1 → `not_1v1`. These are decided BEFORE
 *      "which player is me?", so team games and AI games never sway it.
 *   3. Player: `detection.selectorFor(key, chosenToon)`; null →
 *      `player_unresolved` without calling the engine.
 *   4. After parsing (authoritative): replay date outside the window →
 *      `outside_date_range`; `onlyOneVsOne` and resumed from a replay →
 *      `resumed_replay`.
 *
 * Example:
 *   const rules = { dateWindow: { kind: "days90" }, now: Date.now(), onlyOneVsOne: true };
 *   const { eligible, failed } = triageScans(files, scans, rules);
 */
import { failedParse } from "./engineOutcome";
import { isInDateWindow, preFilterByDate, type DateWindow } from "./fileIntake";
import type { MeDetection, MeScan } from "./meDetection";
import type { ParsedWithFile } from "./sessionState";
import { intakeFailure } from "./sessionIntake";
import type { ErrorKind, FailedParse, IntakeFile, ParseOutcome, ParseRequest, ParsedGame, PlayersResult } from "./types";

/** Filters that apply to one run. */
export interface RunRules {
  dateWindow: DateWindow;
  /** Epoch ms the run started (one clock for the whole run). */
  now: number;
  onlyOneVsOne: boolean;
}

/** A scanned replay that may be parsed. */
export interface EligibleFile {
  file: IntakeFile;
  scan: MeScan;
}

type OkPlayers = Extract<PlayersResult, { ok: true }>;

/**
 * Cheap `lastModified` pre-filter; the rest are skipped as
 * `outside_date_range` without being read.
 *
 * Example:
 *   splitByDate(files, rules); // -> { inWindow: [...], skipped: [...] }
 */
export function splitByDate(
  files: ReadonlyArray<IntakeFile>,
  rules: RunRules,
): { inWindow: IntakeFile[]; skipped: FailedParse[] } {
  const inWindow = preFilterByDate(files, rules.dateWindow, rules.now);
  const kept = new Set(inWindow.map((file) => file.key));
  const skipped = files.filter((file) => !kept.has(file.key)).map((file) => intakeFailure(file, "outside_date_range"));
  return { inWindow, skipped };
}

function scanSkipKind(scan: OkPlayers, rules: RunRules): ErrorKind | null {
  if (!isInDateWindow(scan.date, rules.dateWindow, rules.now)) return "outside_date_range";
  if (scan.isAiGame) return "ai_game";
  if (rules.onlyOneVsOne && scan.matchFormat !== "1v1") return "not_1v1";
  return null;
}

/**
 * Apply the header-scan rules (step 2 of the module comment).
 * `scans[i]` must belong to `files[i]` (engine order).
 *
 * Example:
 *   triageScans([file], [{ ok: true, isAiGame: true, ... }], rules).failed[0].errorKind; // -> "ai_game"
 */
export function triageScans(
  files: ReadonlyArray<IntakeFile>,
  scans: ReadonlyArray<PlayersResult>,
  rules: RunRules,
): { eligible: EligibleFile[]; failed: FailedParse[] } {
  const eligible: EligibleFile[] = [];
  const failed: FailedParse[] = [];
  files.forEach((file, index) => {
    const scan = scans[index];
    if (!scan) {
      failed.push(intakeFailure(file, "worker_crashed"));
    } else if (!scan.ok) {
      failed.push(intakeFailure(file, scan.errorKind, scan.detail));
    } else {
      const skip = scanSkipKind(scan, rules);
      if (skip) failed.push(intakeFailure(file, skip));
      else eligible.push({ file, scan: { key: file.key, players: scan.players, toonFromPath: scan.toonFromPath } });
    }
  });
  return { eligible, failed };
}

/**
 * One parse request per eligible replay the chosen player took part in.
 *
 * Example:
 *   buildRequests(eligible, detectMe(scans), "1-S2-1-267727", false);
 */
export function buildRequests(
  eligible: ReadonlyArray<EligibleFile>,
  detection: MeDetection,
  chosenToon: string | null,
  wantDigests: boolean,
): { requests: ParseRequest[]; failed: FailedParse[] } {
  const requests: ParseRequest[] = [];
  const failed: FailedParse[] = [];
  for (const { file } of eligible) {
    const player = detection.selectorFor(file.key, chosenToon);
    if (!player) failed.push(intakeFailure(file, "player_unresolved"));
    else requests.push(wantDigests ? { file, player, wantDigests } : { file, player });
  }
  return { requests, failed };
}

function parsedSkipKind(game: ParsedGame, rules: RunRules): ErrorKind | null {
  if (!isInDateWindow(game.date, rules.dateWindow, rules.now)) return "outside_date_range";
  if (rules.onlyOneVsOne && game.isResumedFromReplay) return "resumed_replay";
  return null;
}

/**
 * Apply the post-parse rules (step 4) and pair each kept game with its
 * file. `outcomes[i]` must answer `requests[i]` (engine order).
 *
 * Example:
 *   finalizeOutcomes(requests, outcomes, rules); // -> { parsed: [{ game, file }], failed: [...] }
 */
export function finalizeOutcomes(
  requests: ReadonlyArray<ParseRequest>,
  outcomes: ReadonlyArray<ParseOutcome>,
  rules: RunRules,
): { parsed: ParsedWithFile[]; failed: FailedParse[] } {
  const parsed: ParsedWithFile[] = [];
  const failed: FailedParse[] = [];
  requests.forEach((request, index) => {
    const outcome = outcomes[index];
    if (!outcome) {
      failed.push(intakeFailure(request.file, "worker_crashed"));
      return;
    }
    if (!outcome.ok) {
      failed.push(outcome);
      return;
    }
    const skip = parsedSkipKind(outcome, rules);
    if (skip) failed.push(failedParse({ fileName: outcome.fileName, relativePath: outcome.relativePath, ms: outcome.ms }, skip));
    else parsed.push({ game: outcome, file: request.file });
  });
  return { parsed, failed };
}
