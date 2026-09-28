/**
 * One Folder Sync pass over the visitor's StarCraft II replay folder:
 *
 *   stored Folder Sync state bound to another account? stop (`notOwner`)
 *   → walk Multiplayer replays (or take a `<input webkitdirectory>` list)
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
 * (transient kinds are retried on later scans, at most
 * `MAX_RETRYABLE_ATTEMPTS` times; an unidentified player is re-checked
 * once the profile knows one of the replay's toons); games left pending
 * by an early stop get no entry, so the next scan picks them up.
 *
 * When the browser refuses storage (private window), the pass still runs
 * with an empty ledger and remembers nothing.
 *
 * Example:
 *   const summary = await runFolderSync({
 *     source: { handle }, engineFactory: () => createEngineClient(), getToken,
 *     apiBase: API_BASE, engineVersion: INSTANT_ENGINE_VERSION,
 *     profileToons: () => fetchProfileToons(getToken, apiCall),
 *     ownerUserId: userId, now: Date.now, signal, onProgress: setProgress,
 *   });
 */
import { isSkipKind } from "./errorCopy";
import { MAX_REPLAY_BYTES, makeIntakeFile, type DateWindow } from "./fileIntake";
import { walkMultiplayerReplays, type DirectoryHandleLike, type FolderReplay, type WalkOptions } from "./folderSync";
import type { TokenGetter } from "./httpRetry";
import { InstantDbUnavailableError } from "./idb";
import { uploadCounts, type UploadCounts } from "./importRunner";
import { diffAgainstLedger, isRetryableKind, ledgerEntryFor, needsProfileToons, type LedgerEntry } from "./ledger";
import { instantLocalStore } from "./localStore";
import { detectMe, type MeScan } from "./meDetection";
import { profileToons as toonsFromProfile, type ApiCallFn } from "./profileHandles";
import { intakeFailure } from "./sessionIntake";
import { finalizeOutcomes, triageScans, type EligibleFile, type RunRules } from "./sessionPipeline";
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
  /** The account the stored Folder Sync state belongs to (see `ownerUserId`). */
  getFolderOwner?(): Promise<string | null>;
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
  /** Nothing ran: the stored Folder Sync state belongs to another account. */
  notOwner?: boolean;
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
   * loader runs only when the pass has new files or the ledger holds
   * unidentified players the profile might know by now, so a quiet scan
   * makes no profile request.
   */
  profileToons: ReadonlyArray<string> | (() => Promise<ReadonlyArray<string>>);
  /**
   * The signed-in account (Clerk user id). When set, a pass whose stored
   * Folder Sync state is bound to another account stops before walking.
   */
  ownerUserId?: string;
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
  /** Resolved `input.profileToons` (null until first needed). */
  toons: ReadonlyArray<string> | null;
  /** The ledger as loaded at the start of the pass, by path. */
  previous: Map<string, LedgerEntry>;
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

async function resolveToons(ctx: Ctx): Promise<ReadonlyArray<string>> {
  if (ctx.toons === null) {
    const { profileToons } = ctx.input;
    ctx.toons = typeof profileToons === "function" ? await profileToons() : profileToons;
  }
  return ctx.toons;
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

/**
 * Toons that could identify an unresolved replay later: the ones that
 * played but are not on the profile yet. A toon folder decides alone
 * (like the agent), so a replay inside one never becomes resolvable.
 */
function unknownToons(scan: MeScan, profileToons: ReadonlyArray<string>): string[] {
  if (scan.toonFromPath) return [];
  const toons = scan.players.flatMap((player) => (player.toon ? [player.toon] : []));
  return [...new Set(toons)].filter((toon) => !profileToons.includes(toon));
}

interface Selection {
  requests: ParseRequest[];
  failed: FailedParse[];
  /** `player_unresolved` files → toons that could resolve them later. */
  unresolved: Map<string, string[]>;
}

function selectPlayers(eligible: ReadonlyArray<EligibleFile>, profileToons: ReadonlyArray<string>): Selection {
  const selection: Selection = { requests: [], failed: [], unresolved: new Map() };
  for (const { file, scan } of eligible) {
    const player = exactSelector(scan, profileToons);
    if (player) {
      selection.requests.push({ file, player });
      continue;
    }
    selection.failed.push(intakeFailure(file, "player_unresolved"));
    selection.unresolved.set(file.relativePath, unknownToons(scan, profileToons));
  }
  return selection;
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

const NOTHING_PARSED: ParsedChunk = { games: [], failed: [], unresolved: new Map() };

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

interface ParsedChunk {
  games: UploadableGame[];
  failed: FailedParse[];
  unresolved: Map<string, string[]>;
}

/** Header scan + parse of one chunk; returns games to upload and every failure. */
async function parseChunk(ctx: Ctx, files: IntakeFile[], offset: number): Promise<ParsedChunk> {
  const engine = getEngine(ctx);
  const options = { signal: ctx.input.signal };
  const scans = await engine.listPlayers(files, options);
  const triaged = triageScans(files, scans, ctx.rules);
  const { requests, failed, unresolved } = selectPlayers(triaged.eligible, await resolveToons(ctx));
  const skipped = [...triaged.failed, ...failed];
  if (requests.length === 0) return { games: [], failed: skipped, unresolved };
  const outcomes = await engine.parseFiles(requests, { ...options, onProgress: progressFor(ctx, offset) });
  const finalized = finalizeOutcomes(requests, outcomes, ctx.rules);
  const games = finalized.parsed.map(({ game, file }) => ({ gameId: game.gameId, json: game.json, file }));
  return { games, failed: [...skipped, ...finalized.failed], unresolved };
}

interface ChunkResult extends ParsedChunk {
  /** Every file of the chunk that could be opened. */
  files: ReadonlyArray<IntakeFile>;
  upload: UploadSummary;
}

/** Retryable failures of this exact file version so far, plus this one. */
function nextAttempts(ctx: Ctx, file: IntakeFile): number {
  const previous = ctx.previous.get(file.relativePath);
  const same = previous && previous.size === file.size && previous.lastModified === file.lastModified;
  return (same ? previous.attempts ?? 0 : 0) + 1;
}

function failureEntry(ctx: Ctx, file: IntakeFile, failure: FailedParse, chunk: ChunkResult): LedgerEntry {
  const now = ctx.input.now();
  const kind = failure.errorKind;
  if (isSkipKind(kind)) return ledgerEntryFor(file, "skipped", now, { errorKind: kind });
  if (isRetryableKind(kind)) return ledgerEntryFor(file, "failed", now, { errorKind: kind, attempts: nextAttempts(ctx, file) });
  return ledgerEntryFor(file, "failed", now, { errorKind: kind, toons: chunk.unresolved.get(file.relativePath) });
}

/** Ledger rows for one chunk (see module comment for the rules). */
function ledgerEntries(ctx: Ctx, chunk: ChunkResult): LedgerEntry[] {
  const now = ctx.input.now();
  const byPath = new Map(chunk.files.map((file) => [file.relativePath, file]));
  const { upload } = chunk;
  const stored = new Set([...upload.accepted.map((item) => item.gameId), ...upload.skippedExisting]);
  const refused = new Set([...upload.rejected.map((item) => item.gameId), ...upload.oversized]);
  const entries: LedgerEntry[] = [];
  for (const game of chunk.games) {
    if (!game.file) continue;
    if (stored.has(game.gameId)) entries.push(ledgerEntryFor(game.file, "uploaded", now, { gameId: game.gameId }));
    else if (refused.has(game.gameId)) entries.push(ledgerEntryFor(game.file, "skipped", now, { gameId: game.gameId }));
  }
  for (const failure of chunk.failed) {
    const file = byPath.get(failure.relativePath);
    if (file && failure.errorKind !== "cancelled") entries.push(failureEntry(ctx, file, failure, chunk));
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
  if (counts.dailyCapResetAt !== undefined) summary.dailyCapResetAt = counts.dailyCapResetAt;
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
  const parsed = read.files.length > 0 ? await parseChunk(ctx, read.files, offset) : NOTHING_PARSED;
  if (input.signal?.aborted) return false;
  report(ctx, "uploading", offset + chunk.length);
  const upload = await uploadChunk(ctx, parsed.games);
  const failed = [...read.failed, ...parsed.failed];
  const entries = ledgerEntries(ctx, { ...parsed, failed, files: read.all, upload });
  // After a cancel ("Stop syncing" clears the ledger) nothing more is written.
  if (entries.length > 0 && !input.signal?.aborted) await ctx.store.saveLedgerEntries(entries);
  addUpload(ctx.summary, upload);
  ctx.summary.failed.push(...failed.filter((failure) => failure.errorKind !== "cancelled"));
  ctx.summary.processed += chunk.length;
  return upload.stoppedReason === undefined;
}

async function processAll(ctx: Ctx, toProcess: ReadonlyArray<FolderReplay>): Promise<void> {
  await resolveToons(ctx);
  const size = Math.max(1, ctx.input.chunkSize ?? FOLDER_SYNC_CHUNK_SIZE);
  for (let offset = 0; offset < toProcess.length; offset += size) {
    const proceed = await processChunk(ctx, toProcess.slice(offset, offset + size), offset);
    if (!proceed) return;
  }
}

/** Resolve with `fallback` when the browser refuses storage; rethrow anything else. */
function orWithoutStorage<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return promise.catch((error: unknown) => {
    if (error instanceof InstantDbUnavailableError) return fallback;
    throw error;
  });
}

/**
 * The store with a refused IndexedDB softened: the pass still runs with
 * an empty ledger and remembers nothing ("each sync starts fresh").
 */
function resilientStore(store: FolderSyncStore): FolderSyncStore {
  const resilient: FolderSyncStore = {
    loadLedger: () => orWithoutStorage(store.loadLedger(), []),
    saveLedgerEntries: (entries) => orWithoutStorage(store.saveLedgerEntries(entries), undefined),
    setLastFolderScanAt: (at) => orWithoutStorage(store.setLastFolderScanAt(at), undefined),
  };
  // Passed through as is: `belongsToAnotherAccount` decides what a refusal means.
  const getOwner = store.getFolderOwner?.bind(store);
  if (getOwner) resilient.getFolderOwner = getOwner;
  return resilient;
}

/**
 * True when the stored Folder Sync state is bound to another account.
 * Without storage nothing persisted can belong to anyone, so no mismatch.
 */
async function belongsToAnotherAccount(ctx: Ctx): Promise<boolean> {
  const { ownerUserId } = ctx.input;
  if (!ownerUserId || !ctx.store.getFolderOwner) return false;
  const owner = await orWithoutStorage(ctx.store.getFolderOwner(), ownerUserId);
  return owner !== ownerUserId;
}

function createContext(input: FolderSyncInput): Ctx {
  return {
    input,
    store: resilientStore(input.store ?? instantLocalStore()),
    services: { uploadGames, walk: walkMultiplayerReplays, ...input.services },
    rules: { dateWindow: ALL_TIME, now: input.now(), onlyOneVsOne: false },
    toons: null,
    previous: new Map(),
    engine: null,
    summary: emptySummary(),
    total: 0,
  };
}

/** Load the ledger and split the replays; profile toons only when they could matter. */
async function diffReplays(ctx: Ctx, replays: ReadonlyArray<FolderReplay>): Promise<FolderReplay[]> {
  const ledger = await ctx.store.loadLedger();
  ctx.previous = new Map(ledger.map((entry) => [entry.path, entry]));
  const profileToons = needsProfileToons(ledger) ? await resolveToons(ctx) : undefined;
  return diffAgainstLedger(replays, ledger, { profileToons }).toProcess;
}

/**
 * Run one Folder Sync pass (see module comment). Rejects with the
 * engine's `EngineError` when the analyzer cannot start (the scan time is
 * still recorded, so auto-sync waits before trying again); an abort
 * resolves with `aborted: true` and leaves the scan time untouched; a
 * pass for another account's stored state resolves with `notOwner: true`
 * without reading the folder.
 *
 * Example:
 *   const { uploaded, engineStarted } = await runFolderSync(input);
 */
export async function runFolderSync(input: FolderSyncInput): Promise<FolderSyncSummary> {
  const ctx = createContext(input);
  if (await belongsToAnotherAccount(ctx)) return { ...ctx.summary, notOwner: true };
  try {
    const replays = await listReplays(ctx);
    const toProcess = await diffReplays(ctx, replays);
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

/** What this device's Folder Sync ledger holds. */
export interface FolderLedgerCounts {
  /** Replays uploaded (or already in the account) from the folder. */
  synced: number;
  /** Every remembered file, including skips and failures. */
  total: number;
}

/**
 * Count the ledger rows (drives "N replays synced" and whether there is
 * import history to forget).
 *
 * Example:
 *   const { synced, total } = await folderLedgerCounts();
 */
export async function folderLedgerCounts(
  store: Pick<FolderSyncStore, "loadLedger"> = instantLocalStore(),
): Promise<FolderLedgerCounts> {
  const entries = await store.loadLedger();
  return { synced: entries.filter((entry) => entry.status === "uploaded").length, total: entries.length };
}
