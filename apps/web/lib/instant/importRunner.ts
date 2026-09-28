/**
 * Signed-in browser import, after the replays were parsed in this tab:
 *
 *   1. upload the parsed games (`uploadGames`: exists check, ≤ 50-game
 *      batches, retries, daily cap);
 *   2. remember the player the visitor confirmed as "me" on their profile
 *      (`saveConfirmedToons`, best effort — ingest also records each
 *      game's `myToonHandle`);
 *   3. optionally back up the original .SC2Replay files of the games the
 *      server accepted (`backupReplays`), only when the visitor asked for
 *      it AND the server has a replay store.
 *
 * Every network step is injected (`services`) so the order and the stop
 * rules are unit-tested without a server. Nothing here logs file or
 * player names; analytics get counts and fixed codes only.
 *
 * Example:
 *   const summary = await runBrowserUpload({
 *     parsedWithFiles: session.parsedWithFiles, getToken, apiBase: API_BASE,
 *     engineVersion: INSTANT_ENGINE_VERSION,
 *     backup: { enabled: true, capabilityEnabled: archive.enabled },
 *     confirmedToons: session.chosenToon ? [session.chosenToon] : [],
 *     signal: controller.signal, onProgress: setProgress,
 *   });
 */
import { apiCall } from "@/lib/clientApi";
import { trackInstantError, trackInstantUploadDone } from "./analytics";
import type { TokenGetter } from "./httpRetry";
import { saveConfirmedToons, type ApiCallFn } from "./profileHandles";
import { backupReplays, type BackupDeps, type BackupItem, type BackupSummary } from "./replayBackup";
import type { ParsedWithFile } from "./sessionState";
import type { UploadableGame } from "./types";
import {
  uploadGames,
  type UploadDeps,
  type UploadProgress,
  type UploadStopReason,
  type UploadSummary,
} from "./uploader";

/** Counts every import surface reports (browser import and Folder Sync). */
export interface UploadCounts {
  /** Games the server accepted in this run (new + updated). */
  uploaded: number;
  /** Of `uploaded`, games that were new to the account. */
  created: number;
  /** Games the account already had (not sent again). */
  skippedExisting: number;
  /** Games the server refused (or too large to send). */
  rejected: number;
  /** Games not settled because the run stopped early. */
  pending: number;
  stoppedReason?: UploadStopReason;
  /** Daily cap only: epoch ms when browser uploads resume (from the 429). */
  dailyCapResetAt?: number;
}

/** Why the replay backup did not run (null when it ran). */
export type BackupSkipReason = "disabled" | "unavailable" | "upload_stopped" | "nothing_to_back_up";

export interface BrowserUploadSummary extends UploadCounts {
  /** Result of the original-file backup; null when it did not run. */
  backup: BackupSummary | null;
  backupSkipped: BackupSkipReason | null;
  /** True when the confirmed player was newly saved on the profile. */
  toonsSaved: boolean;
}

export type BrowserUploadProgress =
  | { stage: "uploading"; upload: UploadProgress }
  | { stage: "profile" }
  | { stage: "backup"; done: number; total: number };

/** Network steps, injectable for tests (defaults are the real modules). */
export interface ImportRunnerServices {
  uploadGames: (games: ReadonlyArray<UploadableGame>, deps: UploadDeps) => Promise<UploadSummary>;
  saveConfirmedToons: typeof saveConfirmedToons;
  backupReplays: (items: ReadonlyArray<BackupItem>, deps: BackupDeps) => Promise<BackupSummary>;
  apiCall: ApiCallFn;
}

export interface BrowserUploadInput {
  parsedWithFiles: ReadonlyArray<ParsedWithFile>;
  /** Clerk's `useAuth().getToken`. */
  getToken: TokenGetter;
  apiBase: string;
  engineVersion: string;
  backup: {
    /** The visitor's "also back up original replay files" choice. */
    enabled: boolean;
    /** `GET /v1/me/replay-archive-status` → `.enabled` (server has a store). */
    capabilityEnabled: boolean;
  };
  /** Toon handles the visitor confirmed as themselves ("which player is you?"). */
  confirmedToons: ReadonlyArray<string>;
  signal?: AbortSignal;
  onProgress?: (progress: BrowserUploadProgress) => void;
  services?: Partial<ImportRunnerServices>;
}

/** Upload stops after which the account cannot be reached any more. */
const TERMINAL_STOPS: ReadonlySet<UploadStopReason> = new Set<UploadStopReason>(["auth", "aborted"]);

const DEFAULT_SERVICES: ImportRunnerServices = {
  uploadGames,
  saveConfirmedToons,
  backupReplays,
  apiCall,
};

/**
 * Summarise an upload for the UI (shared with Folder Sync).
 *
 * Example:
 *   uploadCounts(summary).created; // -> 12
 */
export function uploadCounts(summary: UploadSummary): UploadCounts {
  const counts: UploadCounts = {
    uploaded: summary.accepted.length,
    created: summary.accepted.filter((item) => item.created).length,
    skippedExisting: summary.skippedExisting.length,
    rejected: summary.rejected.length + summary.oversized.length,
    pending: summary.pending.length,
  };
  if (summary.stoppedReason) counts.stoppedReason = summary.stoppedReason;
  const resetAt = summary.dailyCap?.resetAt;
  if (summary.stoppedReason === "daily_cap" && typeof resetAt === "number") counts.dailyCapResetAt = resetAt;
  return counts;
}

/**
 * Backup items for the accepted games that still have their original
 * file and its digests (the server's archive marker is passed through,
 * so files it already stores are not sent again).
 *
 * Example:
 *   backupItemsFor(parsedWithFiles, summary.accepted); // -> [{ gameId, file, digests, replayArchive }]
 */
export function backupItemsFor(
  parsedWithFiles: ReadonlyArray<ParsedWithFile>,
  accepted: UploadSummary["accepted"],
): BackupItem[] {
  const byId = new Map(parsedWithFiles.map((entry) => [entry.game.gameId, entry]));
  const items: BackupItem[] = [];
  for (const item of accepted) {
    const entry = byId.get(item.gameId);
    const digests = entry?.game.digests;
    if (!entry || !digests) continue;
    const backupItem: BackupItem = { gameId: item.gameId, file: entry.file, digests };
    if (item.replayArchive) backupItem.replayArchive = item.replayArchive;
    items.push(backupItem);
  }
  return items;
}

function toUploadable(entry: ParsedWithFile): UploadableGame {
  const game: UploadableGame = { gameId: entry.game.gameId, json: entry.game.json, file: entry.file };
  if (entry.game.digests) game.digests = entry.game.digests;
  return game;
}

/** Best effort: a profile hiccup must never fail an import that uploaded fine. */
async function saveToons(input: BrowserUploadInput, services: ImportRunnerServices): Promise<boolean> {
  if (input.confirmedToons.length === 0) return false;
  input.onProgress?.({ stage: "profile" });
  try {
    const result = await services.saveConfirmedToons(input.getToken, input.confirmedToons, services.apiCall);
    return result.changed;
  } catch {
    // Ingest already appends each game's myToonHandle server-side, so the
    // next import still resolves this player; nothing to surface here.
    return false;
  }
}

function backupSkipReason(input: BrowserUploadInput, upload: UploadSummary): BackupSkipReason | null {
  if (!input.backup.enabled) return "disabled";
  if (!input.backup.capabilityEnabled) return "unavailable";
  if (upload.stoppedReason && TERMINAL_STOPS.has(upload.stoppedReason)) return "upload_stopped";
  return null;
}

async function runBackup(
  input: BrowserUploadInput,
  upload: UploadSummary,
  services: ImportRunnerServices,
): Promise<{ backup: BackupSummary | null; backupSkipped: BackupSkipReason | null }> {
  const skipped = backupSkipReason(input, upload);
  if (skipped) return { backup: null, backupSkipped: skipped };
  const items = backupItemsFor(input.parsedWithFiles, upload.accepted);
  if (items.length === 0) return { backup: null, backupSkipped: "nothing_to_back_up" };
  input.onProgress?.({ stage: "backup", done: 0, total: items.length });
  const backup = await services.backupReplays(items, {
    getToken: input.getToken,
    apiBase: input.apiBase,
    signal: input.signal,
    onProgress: ({ done, total }) => input.onProgress?.({ stage: "backup", done, total }),
  });
  return { backup, backupSkipped: null };
}

function trackUpload(upload: UploadSummary): void {
  if (upload.stoppedReason === "aborted") return;
  trackInstantUploadDone({ games: upload.accepted.length });
  if (upload.stoppedReason) trackInstantError({ kind: `upload_${upload.stoppedReason}` });
}

/**
 * Upload → save the confirmed player → optional backup (see module comment).
 * Never throws for HTTP problems; the summary says what happened.
 *
 * Example:
 *   const { uploaded, stoppedReason } = await runBrowserUpload(input);
 */
export async function runBrowserUpload(input: BrowserUploadInput): Promise<BrowserUploadSummary> {
  const services: ImportRunnerServices = { ...DEFAULT_SERVICES, ...input.services };
  const upload = await services.uploadGames(input.parsedWithFiles.map(toUploadable), {
    getToken: input.getToken,
    apiBase: input.apiBase,
    engineVersion: input.engineVersion,
    signal: input.signal,
    onProgress: (progress) => input.onProgress?.({ stage: "uploading", upload: progress }),
  });
  trackUpload(upload);
  const stopped = upload.stoppedReason !== undefined && TERMINAL_STOPS.has(upload.stoppedReason);
  const toonsSaved = stopped ? false : await saveToons(input, services);
  const { backup, backupSkipped } = await runBackup(input, upload, services);
  return { ...uploadCounts(upload), backup, backupSkipped, toonsSaved };
}
