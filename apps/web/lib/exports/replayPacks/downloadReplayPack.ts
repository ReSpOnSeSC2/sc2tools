import { withExportAdmission } from "../exportAdmission";
import { ExportDownloadError, type ExportFailure } from "../exportErrors";
import { PACK_TEMPLATES, packText, recordedReplayResult, replayFilenameAllocator, validPackUnicode, type PackNameMetadata, type PackNameTemplate } from "./packNames";
import { replayPackManifest, replayPackReadme, type PackFileStatus, type PackManifestRow } from "./packMetadata";
import { startPackDestination, type PackDestination, type PackDestinationEnvironment, type PackPicker } from "./packDestination";
import { readPackResponse, type SignedReplay, type ReadyReplay } from "./packResponse";
import { readPackBytes, type PackWorkScope } from "./packReaders";
import { packWorkerOwner } from "./packWorkerOwner";
import { openReplayZip, type ReplayZip } from "./zipWorkerClient";
import { validZipJob } from "./zipWorkerProtocol";
import { REPLAY_BYTES } from "./zipStore";

export type ReplayPackRequest = { apiUrl: string; rows: readonly PackNameMetadata[]; template: PackNameTemplate };
export type ReplayPackProgress = { phase: "preparing" | "downloading" | "writing" | "finishing"; total: number; completed: number; downloadedBytes: number; archiveBytes: number };
export type ReplayPackResult = { requested: number; saved: number; failed: number; bytes: number; items: readonly { gameId: string; filename: string; status: PackFileStatus }[] };
export type ReplayPackScope = PackWorkScope & { token: () => Promise<string | null>; onProgress?: (progress: ReplayPackProgress) => void; onStop?: (code: ExportFailure) => void };
export type ReplayPackEnvironment = PackDestinationEnvironment & { fetch: typeof fetch; workerFactory?: () => Worker; now?: () => number; job?: () => string };
type Selected = { metadata: PackNameMetadata; filename: string };
type Outcome = { selected: Selected; status: PackFileStatus; bytes?: Uint8Array };

function snapshot(request: ReplayPackRequest): readonly Selected[] {
  if (!Array.isArray(request.rows) || request.rows.length < 1 || request.rows.length > 100 || !(PACK_TEMPLATES as readonly string[]).includes(request.template)) throw new ExportDownloadError("invalid");
  const allocate = replayFilenameAllocator(), seen = new Set<string>();
  return Object.freeze(request.rows.map(row => {
    const raw = row?.gameId;
    if (typeof raw !== "string" || !raw || raw.length > 200 || !validPackUnicode(raw) || /[\u0000-\u001f\u007f-\u009f]/u.test(raw)) throw new ExportDownloadError("invalid");
    const gameId = raw.trim();
    if (!gameId || seen.has(gameId) || /^[a-z][a-z0-9+.-]*:/iu.test(gameId) || /^[/\\]{2}/u.test(gameId)) throw new ExportDownloadError("invalid");
    seen.add(gameId);
    const metadata = Object.freeze({ gameId, date: packText(row.date, 32), map: packText(row.map, 120), opponent: packText(row.opponent, 100), matchup: packText(row.matchup, 32), result: recordedReplayResult(row.result) });
    return Object.freeze({ metadata, filename: allocate(metadata, request.template) });
  }));
}

function browserEnvironment(): ReplayPackEnvironment {
  const pickerWindow = window as Window & { showSaveFilePicker?: PackPicker };
  return { fetch: window.fetch.bind(window), picker: pickerWindow.showSaveFilePicker?.bind(window), saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob), anchor = document.createElement("a");
    try { anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); }
    finally { anchor.remove(); URL.revokeObjectURL(url); }
  } };
}

class PackJob implements PackWorkScope {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  error: ExportDownloadError | null = null;
  readonly progress: ReplayPackProgress;
  private readonly cancelled = () => this.stop("cancelled");
  constructor(private readonly scope: ReplayPackScope, total: number) {
    this.progress = { phase: "preparing", total, completed: 0, downloadedBytes: 0, archiveBytes: 0 };
    scope.signal.addEventListener("abort", this.cancelled, { once: true });
  }
  stop(code: ExportFailure) {
    if (!this.error) {
      this.error = new ExportDownloadError(code);
      // Publish only the first closed code before abort can reject an outer owner scope.
      try { this.scope.onStop?.(this.error.code); } catch { /* A view observer cannot replace the cause or strand cleanup. */ }
    }
    if (!this.signal.aborted) this.controller.abort(this.error);
  }
  assertCurrent = () => {
    if (this.scope.signal.aborted) this.stop("cancelled");
    try { this.scope.assertCurrent(); } catch { this.stop("cancelled"); }
    if (this.signal.aborted) throw this.error || new ExportDownloadError("cancelled");
  };
  notify() { if (!this.signal.aborted) { try { this.scope.onProgress?.({ ...this.progress }); } catch { /* A view cannot release or strand admission. */ } } }
  dispose() { this.scope.signal.removeEventListener("abort", this.cancelled); }
}

/** Owns the single browser reservation through every actual local operation and cleanup. */
export function downloadReplayPack(request: ReplayPackRequest, scope: ReplayPackScope, environment?: ReplayPackEnvironment): Promise<ReplayPackResult> {
  return withExportAdmission(async () => {
    try { return await executePack(request, scope, environment || browserEnvironment()); }
    catch (error) { throw error instanceof ExportDownloadError ? error : new ExportDownloadError(scope.signal.aborted ? "cancelled" : "failed"); }
  });
}

async function executePack(request: ReplayPackRequest, scope: ReplayPackScope, environment: ReplayPackEnvironment): Promise<ReplayPackResult> {
  const rows = snapshot(request), now = environment.now || Date.now, apiUrl = request.apiUrl;
  const job = new PackJob(scope, rows.length);
  let destination: PackDestination | undefined, zip: ReplayZip | undefined, complete = false;
  let worker: ReturnType<typeof packWorkerOwner> | undefined;
  const manifests: PackManifestRow[] = [], refreshed = new Set<string>();
  try {
    const nonce = environment.job?.() || crypto.randomUUID();
    job.assertCurrent(); if (!validZipJob(nonce) || typeof apiUrl !== "string" || !apiUrl) throw new ExportDownloadError("invalid"); job.notify();
    worker = packWorkerOwner(nonce, () => job.stop("failed"), environment.workerFactory);
    destination = await startPackDestination(`sc2tools-replays-${Date.now()}.zip`, environment, job, code => job.stop(code), bytes => { job.progress.archiveBytes += bytes; job.notify(); });
    job.assertCurrent(); zip = await openReplayZip(destination.sink, job, { job: nonce, factory: worker.factory }); job.assertCurrent();
    for (let offset = 0; offset < rows.length; offset += 4) {
      job.assertCurrent(); job.progress.phase = "downloading"; job.notify();
      const outcomes = await readBatch(rows.slice(offset, offset + 4), apiUrl, scope, environment, job, now, refreshed);
      job.assertCurrent(); job.progress.phase = "writing"; job.notify();
      for (const outcome of outcomes) {
        job.assertCurrent();
        if (outcome.bytes) { await zip.entry(outcome.selected.filename, outcome.bytes); job.assertCurrent(); outcome.bytes = undefined; }
        manifests.push({ ...outcome.selected.metadata, status: outcome.status, filename: outcome.status === "saved" ? outcome.selected.filename : "" });
      }
    }
    const saved = manifests.filter(row => row.status === "saved").length;
    job.progress.phase = "finishing"; job.notify(); job.assertCurrent();
    await zip.entry("manifest.csv", replayPackManifest(manifests), "manifest"); job.assertCurrent();
    await zip.entry("README.txt", replayPackReadme({ requested: rows.length, saved, failed: rows.length - saved, cancelled: 0 }), "readme"); job.assertCurrent();
    await zip.finish(); job.assertCurrent(); destination.publish(); job.assertCurrent(); complete = true;
    return { requested: rows.length, saved, failed: rows.length - saved, bytes: job.progress.archiveBytes,
      items: Object.freeze(manifests.map(row => Object.freeze({ gameId: row.gameId, filename: row.filename, status: row.status }))) };
  } catch (error) {
    job.stop(error instanceof ExportDownloadError ? error.code : job.signal.aborted ? "cancelled" : "failed");
    throw job.error!;
  } finally {
    if (!complete) { job.stop("failed"); await Promise.allSettled([zip?.abort(), destination?.sink.abort()]); }
    worker?.retire(); job.dispose();
  }
}

async function sign(ids: readonly string[], apiUrl: string, scope: ReplayPackScope, environment: ReplayPackEnvironment, job: PackJob): Promise<readonly SignedReplay[]> {
  job.assertCurrent(); const token = await scope.token(); job.assertCurrent();
  if (!token) throw new ExportDownloadError("failed");
  const response = await environment.fetch(apiUrl, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ gameIds: ids }), signal: job.signal, cache: "no-store", credentials: "omit", redirect: "error" });
  return readPackResponse(response, ids, job);
}

async function original(selected: Selected, ready: ReadyReplay, environment: ReplayPackEnvironment, job: PackJob): Promise<Outcome> {
  try {
    job.assertCurrent();
    const response = await environment.fetch(ready.url, { signal: job.signal, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "error" });
    const bytes = await readPackBytes(response, job, REPLAY_BYTES, ready.sizeBytes); job.assertCurrent();
    job.progress.downloadedBytes += bytes.byteLength;
    return { selected, status: "saved", bytes };
  } catch {
    job.assertCurrent();
    return { selected, status: "failed" };
  } finally { job.progress.completed++; job.notify(); }
}

async function readBatch(batch: readonly Selected[], apiUrl: string, scope: ReplayPackScope, environment: ReplayPackEnvironment,
  job: PackJob, now: () => number, refreshed: Set<string>): Promise<Outcome[]> {
  const outcomes: Promise<PromiseSettledResult<Outcome>>[] = new Array(batch.length);
  const admitted: Promise<PromiseSettledResult<Outcome>>[] = [];
  const observe = (index: number, task: Promise<Outcome>) => {
    const observed = task.then(value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason }));
    outcomes[index] = observed; admitted.push(observed);
  };
  const finish = (index: number, row: SignedReplay, mayRefresh: boolean): boolean => {
    const expired = row.status === "available" ? now() >= Date.parse(row.expiresAt) : row.code === "replay_download_expired";
    if (expired && mayRefresh && !refreshed.has(row.gameId)) return false;
    if (row.status === "available" && !expired) observe(index, original(batch[index], row, environment, job));
    else { job.progress.completed++; job.notify(); observe(index, Promise.resolve({ selected: batch[index], status: row.status === "unavailable" ? "unavailable" : "failed" })); }
    return true;
  };
  try {
    const initial = await sign(batch.map(row => row.metadata.gameId), apiUrl, scope, environment, job); job.assertCurrent();
    const refreshIndices: number[] = [];
    initial.forEach((row, index) => { if (!finish(index, row, true)) { refreshed.add(row.gameId); refreshIndices.push(index); } });
    if (refreshIndices.length) {
      const again = await sign(refreshIndices.map(index => batch[index].metadata.gameId), apiUrl, scope, environment, job); job.assertCurrent();
      again.forEach((row, index) => finish(refreshIndices[index], row, false));
    }
    const settled = await Promise.all(outcomes); job.assertCurrent();
    return settled.map(result => { if (result.status === "rejected") throw job.error || new ExportDownloadError("failed"); return result.value; });
  } catch (error) {
    job.stop(error instanceof ExportDownloadError ? error.code : "failed");
    await Promise.all(admitted);
    throw job.error!;
  }
}
