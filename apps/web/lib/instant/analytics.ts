/**
 * Typed GA4 events for Instant Analysis (wrappers over `gaEvent`).
 *
 * Parameters are counts, durations and fixed enums ONLY — never file
 * names, player names, toon handles, map names or game ids. `gaEvent`
 * is a no-op until the visitor consents to analytics.
 *
 * Example:
 *   trackInstantFilesSelected({ count: files.length, source: "drop" });
 *   trackInstantParseDone({ ok: 9, failed: 1, medianMs: medianMs(durations) });
 */
import { gaEvent } from "@/lib/analytics/gtag";
import type { ErrorKind, IntakeSource } from "./types";
import type { UploadStopReason } from "./uploader";

/** Error kinds reported by `instant_error` (engine + client flow). */
export type InstantErrorEventKind =
  | ErrorKind
  | `upload_${UploadStopReason}`
  | "storage_unavailable"
  | "folder_permission_denied";

function count(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

/**
 * Median of durations in ms (rounded), or null for an empty list.
 *
 * Example:
 *   medianMs([30, 10, 20]); // -> 20
 */
export function medianMs(values: ReadonlyArray<number>): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(median);
}

/**
 * The /try page (or importer) was opened.
 *
 * Example:
 *   useEffect(() => trackInstantOpen(), []);
 */
export function trackInstantOpen(): void {
  gaEvent("instant_open");
}

/**
 * Replays were handed to the importer.
 *
 * Example:
 *   trackInstantFilesSelected({ count: 12, source: "picker" });
 */
export function trackInstantFilesSelected(params: { count: number; source: IntakeSource }): void {
  gaEvent("instant_files_selected", { count: count(params.count), source: params.source });
}

/**
 * A parse run finished.
 *
 * Example:
 *   trackInstantParseDone({ ok: 9, failed: 1, medianMs: 1400 });
 */
export function trackInstantParseDone(params: {
  ok: number;
  failed: number;
  medianMs: number | null;
}): void {
  gaEvent("instant_parse_done", {
    ok: count(params.ok),
    failed: count(params.failed),
    median_ms: params.medianMs === null ? 0 : count(params.medianMs),
  });
}

/**
 * The instant report became visible.
 *
 * Example:
 *   trackInstantReportView();
 */
export function trackInstantReportView(): void {
  gaEvent("instant_report_view");
}

/**
 * The visitor clicked "sign up to keep these games".
 *
 * Example:
 *   trackInstantSignupClick();
 */
export function trackInstantSignupClick(): void {
  gaEvent("instant_signup_click");
}

/**
 * Games were uploaded to the signed-in account.
 *
 * Example:
 *   trackInstantUploadDone({ games: summary.accepted.length });
 */
export function trackInstantUploadDone(params: { games: number }): void {
  gaEvent("instant_upload_done", { games: count(params.games) });
}

/**
 * Folder Sync resumed on a persisted folder.
 *
 * Example:
 *   trackInstantFolderSyncResume();
 */
export function trackInstantFolderSyncResume(): void {
  gaEvent("instant_folder_sync_resume");
}

/**
 * Something failed; `kind` is a fixed code, never a message.
 *
 * Example:
 *   trackInstantError({ kind: "engine_boot_failed" });
 */
export function trackInstantError(params: { kind: InstantErrorEventKind }): void {
  gaEvent("instant_error", { kind: params.kind });
}
