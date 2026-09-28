/**
 * One Folder Sync pass over the visitor's StarCraft II replay folder:
 *
 *   walk Multiplayer replays (or take a `<input webkitdirectory>` list)
 *   → diff against the ledger (settled files are skipped)
 *   → nothing new? record the scan time and stop WITHOUT booting the engine
 *   → otherwise, per chunk of files: header scan → identify "me" exactly
 *     (toon folder in the path, or a toon already on the profile — never a
 *     guess, because a wrong "me" creates duplicate games) → parse (every
 *     format, like the desktop agent; games vs the AI are skipped)
 *     → upload → write ledger entries
 *   → record the scan time.
 *
 * Chunks bound memory: a 5,000-replay folder never holds more than one
 * chunk of parsed payloads, and the engine client reads files one at a
 * time. Ledger rules: uploaded / already stored → `uploaded`; skips and
 * server refusals → `skipped`; parse failures → `failed` with their kind
 * (transient kinds are retried on the next scan); games left pending by
 * an early stop get no entry, so the next scan picks them up.
 *
 * Example:
 *   const summary = await runFolderSync({
 *     source: { handle }, engineFactory: () => createEngineClient(), getToken,
 *     apiBase: API_BASE, engineVersion: INSTANT_ENGINE_VERSION,
 *     profileToons: () => fetchProfileToons(getToken, apiCall),
 *     now: Date.now, signal, onProgress: setProgress,
 *   });
 */
import { isSkipKind } from "./errorCopy";
import { MAX_REPLAY_BYTES, makeIntakeFile, type DateWindow } from "./fileIntake";
import { walkMultiplayerReplays, type DirectoryHandleLike, type FolderReplay, type WalkOptions } from "./folderSync";
import type { TokenGetter } from "./httpRetry";
import { uploadCounts, type UploadCounts } from "./importRunner";
import { diffAgainstLedger, ledgerEntryFor, type LedgerEntry } from "./ledger";
import { instantLocalStore } from "./localStore";
import { detectMe, type MeScan } from "./meDetection";
import { profileToons as toonsFromProfile, type ApiCallFn } from "./profileHandles";
import { intakeFailure } from "./sessionIntake";
import { finalizeOutcomes, triageScans, type RunRules } from "./sessionPipeline";
import type { EngineClient, EngineProgress, FailedParse, IntakeFile, ParseRequest, PlayerSelector, UploadableGame } from "./types";
import { uploadGames, type UploadDeps, type UploadSummary } from "./uploader";

/** Files handled per engine/upload round (bounds parsed payloads in memory). */
export const FOLDER_SYNC_CHUNK_SIZE = 100;
/** Folder Sync mirrors the agent: every date, every format. */
const ALL_TIME: DateWindow = { kind: "all" };
const LOCK_NAME = "sc2tools-instant-folder-sync";

export type FolderSyncSource = { handle: DirectoryHandleLike } | { files: ReadonlyArray<FolderReplay> };

/** Persistence the runner needs (the IndexedDB store by default). */
export interface FolderSyncStore {
  loadLedger(): Promise<LedgerEntry[]>;
  saveLedgerEntries(entries: ReadonlyArray<LedgerEntry>): Promise<void>;
  setLastFolderScanAt(at: number): Promise<void>;
}

export interface FolderSyncProgress {
  /** walking: listing the folder; reading: scan + parse; uploading: sending games. */
  stage: "walking" | "reading" | "uploading";
  /** Replays found so far (walking), else files finished out of `total`. */
  done: number;
  /** New or changed files in this pass (0 while walking). */
  total: number;
}

export interface FolderSyncSummary extends UploadCounts {
  /** Multiplayer replays in the folder. */
  found: number;
  /** Files that were new, changed or due for a retry. */
  newFiles: number;
  /** Of `newFiles`, how many this pass settled or attempted. */
  processed: number;
  /** Skips and failures of this pass (counts per kind in the UI). */
  failed: FailedParse[];
  aborted: boolean;
  /** Whether the analyzer (Pyodide) had to start. */
  engineStarted: boolean;
}

export interface FolderSyncServices {
  uploadGames: (games: ReadonlyArray<UploadableGame>, deps: UploadDeps) => Promise<UploadSummary>;
  walk: (root: DirectoryHandleLike, options: WalkOptions) => Promise<FolderReplay[]>;
}

export interface FolderSyncInput {
  source: FolderSyncSource;
  /** Creates the engine; called only when there is something to parse. */
  engineFactory: () => EngineClient;
  getToken: TokenGetter;
  apiBase: string;
  engineVersion: string;
  /**
   * The signed-in user's saved toon handles, or a loader for them. A
   * loader runs only when the pass has new files, so a scan with nothing
   * new makes no profile request.
   */
  profileToons: ReadonlyArray<string> | (() => Promise<ReadonlyArray<string>>);
  now: () => number;
  signal?: AbortSignal;
  onProgress?: (progress: FolderSyncProgress) => void;
  store?: FolderSyncStore;
  chunkSize?: number;
  services?: Partial<FolderSyncServices>;
}

interface Ctx {
  input: FolderSyncInput;
  store: FolderSyncStore;
  services: FolderSyncServices;
  rules: RunRules;
  /** Resolved `input.profileToons` (set before the first chunk). */
  toons: ReadonlyArray<string>;
  engine: EngineClient | null;
  summary: FolderSyncSummary;
  total: number;
}

function emptySummary(): FolderSyncSummary {
  return {
    found: 0, newFiles: 0, processed: 0, failed: [], aborted: false, engineStarted: false,
    uploaded: 0, created: 0, skippedExisting: 0, rejected: 0, pending: 0,
  };
}

function getEngine(ctx: Ctx): EngineClient {
  if (!ctx.engine) {
    ctx.engine = ctx.input.engineFactory();
    ctx.summary.engineStarted = true;
  }
  return ctx.engine;
}

function report(ctx: Ctx, stage: FolderSyncProgress["stage"], done: number): void {
  ctx.input.onProgress?.({ stage, done, total: ctx.total });
}

async function listReplays(ctx: Ctx): Promise<ReadonlyArray<FolderReplay>> {
  const { source } = ctx.input;
  if (!("handle" in source)) return source.files;
  return ctx.services.walk(source.handle, {
    signal: ctx.input.signal,
    onEntry: ({ found }) => report(ctx, "walking", found),
  });
}

/**
 * "Me" for one replay without guessing: its toon folder, else a toon the
 * profile already knows. A single loose replay never resolves by majority.
 */
function exactSelector(scan: MeScan, profileToons: ReadonlyArray<string>): PlayerSelector | null {
  return detectMe([scan], { profileToons }).selectorFor(scan.key);
}

interface ReadChunk {
  /** Every file that could be opened (ledger keys). */
  all: IntakeFile[];
  /** Of `all`, the ones small enough to parse. */
  files: IntakeFile[];
  failed: FailedParse[];
}

/** Fresh `File`s for a chunk; vanished files are dropped (the next walk forgets them). */
async function readChunk(chunk: ReadonlyArray<FolderReplay>): Promise<ReadChunk> {
  const read: ReadChunk = { all: [], files: [], failed: [] };
  for (const replay of chunk) {
    let file: File;
    try {
      file = await replay.getFile();
    } catch {
      continue; // deleted or moved since the walk
    }
    const intake = makeIntakeFile(file, "folder", replay.relativePath);
    read.all.push(intake);
    if (intake.size > MAX_REPLAY_BYTES) read.failed.push(intakeFailure(intake, "too_large"));
    else read.files.push(intake);
  }
  return read;
}

const NOTHING_UPLOADED: UploadSummary = {
  accepted: [],
  rejected: [],
  skippedExisting: [],
  oversized: [],
  pending: [],
};

function progressFor(ctx: Ctx, offset: number): (event: EngineProgress) => void {
  return (event) => {
    if (event.phase === "parse" && event.ok !== undefined) report(ctx, "reading", offset + event.index + 1);
  };
}

/** Header scan + parse of one chunk; returns games to upload and every failure. */
async function parseChunk(
  ctx: Ctx,
  files: IntakeFile[],
  offset: number,
): Promise<{ games: UploadableGame[]; failed: FailedParse[] }> {
  const engine = getEngine(ctx);
  const options = { signal: ctx.input.signal };
  const scans = await engine.listPlayers(files, options);
  const triaged = triageScans(files, scans, ctx.rules);
  const failed = [...triaged.failed];
  const requests: ParseRequest[] = [];
  for (const { file, scan } of triaged.eligible) {
    const player = exactSelector(scan, ctx.toons);
    if (player) requests.push({ file, player });
    else failed.push(intakeFailure(file, "player_unresolved"));
  }
  if (requests.length === 0) return { games: [], failed };
  const outcomes = await engine.parseFiles(requests, { ...options, onProgress: progressFor(ctx, offset) });
  const finalized = finalizeOutcomes(requests, outcomes, ctx.rules);
  const games = finalized.parsed.map(({ game, file }) => ({ gameId: game.gameId, json: game.json, file }));
  return { games, failed: [...failed, ...finalized.failed] };
}

/** Ledger rows for one chunk (see module comment for the rules). */
function ledgerEntries(
  files: ReadonlyArray<IntakeFile>,
  games: ReadonlyArray<UploadableGame>,
  failed: ReadonlyArray<FailedParse>,
  upload: UploadSummary,
  now: number,
): LedgerEntry[] {
  const byPath = new Map(files.map((file) => [file.relativePath, file]));
  const stored = new Set([...upload.accepted.map((item) => item.gameId), ...upload.skippedExisting]);
  const refused = new Set([...upload.rejected.map((item) => item.gameId), ...upload.oversized]);
  const entries: LedgerEntry[] = [];
  for (const game of games) {
    if (!game.file) continue;
    if (stored.has(game.gameId)) entries.push(ledgerEntryFor(game.file, "uploaded", now, { gameId: game.gameId }));
    else if (refused.has(game.gameId)) entries.push(ledgerEntryFor(game.file, "skipped", now, { gameId: game.gameId }));
  }
  for (const failure of failed) {
    const file = byPath.get(failure.relativePath);
    if (!file || failure.errorKind === "cancelled") continue;
    const status = isSkipKind(failure.errorKind) ? "skipped" : "failed";
    entries.push(ledgerEntryFor(file, status, now, { errorKind: failure.errorKind }));
  }
  return entries;
}

function addUpload(summary: FolderSyncSummary, upload: UploadSummary): void {
  const counts = uploadCounts(upload);
  summary.uploaded += counts.uploaded;
  summary.created += counts.created;
  summary.skippedExisting += counts.skippedExisting;
  summary.rejected += counts.rejected;
  summary.pending += counts.pending;
  if (counts.stoppedReason) summary.stoppedReason = counts.stoppedReason;
}

function uploadChunk(ctx: Ctx, games: ReadonlyArray<UploadableGame>): Promise<UploadSummary> {
  if (games.length === 0) return Promise.resolve(NOTHING_UPLOADED);
  const { input } = ctx;
  return ctx.services.uploadGames(games, {
    getToken: input.getToken,
    apiBase: input.apiBase,
    engineVersion: input.engineVersion,
    signal: input.signal,
  });
}

/** One chunk end to end; returns false when the pass must stop. */
async function processChunk(ctx: Ctx, chunk: ReadonlyArray<FolderReplay>, offset: number): Promise<boolean> {
  const { input } = ctx;
  report(ctx, "reading", offset);
  const read = await readChunk(chunk);
  const parsed = read.files.length > 0 ? await parseChunk(ctx, read.files, offset) : { games: [], failed: [] };
  if (input.signal?.aborted) return false;
  report(ctx, "uploading", offset + chunk.length);
  const upload = await uploadChunk(ctx, parsed.games);
  const failed = [...read.failed, ...parsed.failed];
  const entries = ledgerEntries(read.all, parsed.games, failed, upload, input.now());
  // After a cancel ("Stop syncing" clears the ledger) nothing more is written.
  if (entries.length > 0 && !input.signal?.aborted) await ctx.store.saveLedgerEntries(entries);
  addUpload(ctx.summary, upload);
  ctx.summary.failed.push(...failed.filter((failure) => failure.errorKind !== "cancelled"));
  ctx.summary.processed += chunk.length;
  return upload.stoppedReason === undefined;
}

async function processAll(ctx: Ctx, toProcess: ReadonlyArray<FolderReplay>): Promise<void> {
  const { profileToons } = ctx.input;
  ctx.toons = typeof profileToons === "function" ? await profileToons() : profileToons;
  const size = Math.max(1, ctx.input.chunkSize ?? FOLDER_SYNC_CHUNK_SIZE);
  for (let offset = 0; offset < toProcess.length; offset += size) {
    const proceed = await processChunk(ctx, toProcess.slice(offset, offset + size), offset);
    if (!proceed) return;
  }
}

function createContext(input: FolderSyncInput): Ctx {
  return {
    input,
    store: input.store ?? instantLocalStore(),
    services: { uploadGames, walk: walkMultiplayerReplays, ...input.services },
    rules: { dateWindow: ALL_TIME, now: input.now(), onlyOneVsOne: false },
    toons: [],
    engine: null,
    summary: emptySummary(),
    total: 0,
  };
}

/**
 * Run one Folder Sync pass (see module comment). Rejects with the
 * engine's `EngineError` when the analyzer cannot start (the scan time is
 * still recorded, so auto-sync waits before trying again); an abort
 * resolves with `aborted: true` and leaves the scan time untouched.
 *
 * Example:
 *   const { uploaded, engineStarted } = await runFolderSync(input);
 */
export async function runFolderSync(input: FolderSyncInput): Promise<FolderSyncSummary> {
  const ctx = createContext(input);
  try {
    const replays = await listReplays(ctx);
    const { toProcess } = diffAgainstLedger(replays, await ctx.store.loadLedger());
    ctx.summary.found = replays.length;
    ctx.summary.newFiles = toProcess.length;
    ctx.total = toProcess.length;
    if (toProcess.length > 0) await processAll(ctx, toProcess);
    if (input.signal?.aborted) ctx.summary.aborted = true;
    else await ctx.store.setLastFolderScanAt(input.now());
    return ctx.summary;
  } catch (error) {
    if (input.signal?.aborted) return { ...ctx.summary, aborted: true };
    // Keep the 10-minute rule even when the analyzer cannot start, so a
    // broken engine is not retried on every focus of the tab.
    await ctx.store.setLastFolderScanAt(input.now()).catch(() => undefined);
    throw error;
  } finally {
    ctx.engine?.dispose();
  }
}

let runningInThisTab = false;

function lockManager(): LockManager | null {
  if (typeof navigator === "undefined" || !("locks" in navigator)) return null;
  return navigator.locks ?? null;
}

/**
 * `runFolderSync`, but at most one pass at a time: resolves null when a
 * pass is already running in this tab or (via the Web Locks API, where
 * available) in another tab of this site.
 *
 * Example:
 *   const summary = await runFolderSyncExclusive(input);
 *   if (summary === null) return; // someone else is syncing
 */
export async function runFolderSyncExclusive(input: FolderSyncInput): Promise<FolderSyncSummary | null> {
  if (runningInThisTab) return null;
  runningInThisTab = true;
  try {
    const locks = lockManager();
    if (!locks) return await runFolderSync(input);
    return await locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => (lock ? runFolderSync(input) : null));
  } finally {
    runningInThisTab = false;
  }
}

/**
 * True while a Folder Sync pass runs in this tab.
 *
 * Example:
 *   if (!isFolderSyncRunning()) void scan();
 */
export function isFolderSyncRunning(): boolean {
  return runningInThisTab;
}

/**
 * The signed-in user's saved toon handles, or none when the profile
 * cannot be read (Folder Sync then relies on toon folders alone).
 *
 * Example:
 *   const toons = await fetchProfileToons(getToken, apiCall);
 */
export async function fetchProfileToons(
  getToken: () => Promise<string | null>,
  apiCallImpl: ApiCallFn,
): Promise<string[]> {
  try {
    return toonsFromProfile(await apiCallImpl<unknown>(getToken, "/v1/me/profile"));
  } catch {
    // Best effort: without profile toons only replays inside a toon
    // folder are identified, which is still exact.
    return [];
  }
}

/**
 * Replays this device has synced from the folder (ledger `uploaded` rows).
 *
 * Example:
 *   setSyncedCount(await syncedReplayCount());
 */
export async function syncedReplayCount(
  store: Pick<FolderSyncStore, "loadLedger"> = instantLocalStore(),
): Promise<number> {
  const entries = await store.loadLedger();
  return entries.filter((entry) => entry.status === "uploaded").length;
}
