/**
 * Folder Sync: read the visitor's StarCraft II replay folders in place.
 *
 * Uses the File System Access API (`showDirectoryPicker`, Chromium) with
 * a persisted, read-only directory handle, and falls back to
 * `<input webkitdirectory>` file lists elsewhere. Both paths produce the
 * same `FolderReplay` entries restricted to
 * `<account>/<toon>/Replays/Multiplayer/*.SC2Replay`, with paths relative
 * to the picked folder INCLUDING its own name, so a toon folder segment
 * (`1-S2-1-267727`) is kept whenever the visitor picked it or anything
 * above it — that segment identifies the player exactly.
 *
 * The File System Access types are not in TypeScript's DOM lib, so this
 * module declares the minimal structural interfaces it relies on and
 * validates handles at runtime.
 *
 * Example:
 *   const root = await pickReplaysFolder();
 *   if (root) {
 *     const replays = await walkMultiplayerReplays(root, { signal });
 *   }
 */
import { isReplayFileName } from "./fileIntake";
import { TOON_HANDLE_RE, isMultiplayerReplayPath } from "./toonPath";

const MS_PER_MINUTE = 60 * 1000;
/** Minutes between automatic re-scans (quoted in the Folder Sync copy). */
export const AUTO_SCAN_INTERVAL_MINUTES = 10;
/** Do not re-scan automatically more often than this. */
export const MIN_AUTO_SCAN_INTERVAL_MS = AUTO_SCAN_INTERVAL_MINUTES * MS_PER_MINUTE;
/** Yield to the event loop after this many directory entries... */
export const YIELD_EVERY_ENTRIES = 32;
/** ...or after this much continuous work, whichever comes first. */
export const YIELD_BUDGET_MS = 16;
/**
 * Deepest directory visited below the picked root. `Documents/StarCraft
 * II/Accounts/<acct>/<toon>/Replays/Multiplayer` is depth 6.
 */
export const MAX_WALK_DEPTH = 6;
/** Picker id so the browser reopens in the same place next time. */
export const DIRECTORY_PICKER_ID = "sc2-accounts";

export type ReadPermission = "granted" | "prompt" | "denied";

interface PermissionDescriptorLike {
  mode: "read";
}

/** Structural subset of `FileSystemFileHandle`. */
export interface FileHandleLike {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
}

/** Structural subset of `FileSystemDirectoryHandle`. */
export interface DirectoryHandleLike {
  readonly kind: "directory";
  readonly name: string;
  values(): AsyncIterable<FileHandleLike | DirectoryHandleLike>;
  queryPermission?(descriptor: PermissionDescriptorLike): Promise<PermissionState>;
  requestPermission?(descriptor: PermissionDescriptorLike): Promise<PermissionState>;
}

/** One replay found by a walk or a directory input. */
export interface FolderReplay {
  /** Reads the file fresh (it may have changed since the walk). */
  getFile(): Promise<File>;
  name: string;
  /** `/`-separated, starts with the picked folder's name. */
  relativePath: string;
  size: number;
  lastModified: number;
}

export interface WalkProgress {
  scanned: number;
  found: number;
}

export interface WalkOptions {
  signal?: AbortSignal;
  onEntry?: (progress: WalkProgress) => void;
  /** Injected for tests; defaults to a `setTimeout(0)` macrotask. */
  yieldToEventLoop?: () => Promise<void>;
  /** Injected for tests; defaults to `performance.now`/`Date.now`. */
  now?: () => number;
}

/**
 * True when `value` looks like a directory handle (runtime check for
 * handles read back from IndexedDB or returned by the picker).
 *
 * Example:
 *   isDirectoryHandle(await loadFolderHandle()); // -> true | false
 */
export function isDirectoryHandle(value: unknown): value is DirectoryHandleLike {
  if (!value || typeof value !== "object") return false;
  return (
    "kind" in value &&
    value.kind === "directory" &&
    "name" in value &&
    typeof value.name === "string" &&
    "values" in value &&
    typeof value.values === "function"
  );
}

/**
 * True when this browser can open a persistent folder picker.
 *
 * Example:
 *   if (supportsDirectoryPicker()) showFolderSyncButton();
 */
export function supportsDirectoryPicker(host: object = globalThis): boolean {
  return typeof Reflect.get(host, "showDirectoryPicker") === "function";
}

/**
 * Ask the visitor for their replays folder (read-only). Resolves null
 * when the picker is unsupported or the visitor cancels. Must run from
 * a user gesture.
 *
 * Example:
 *   const root = await pickReplaysFolder();
 */
export async function pickReplaysFolder(
  host: object = globalThis,
): Promise<DirectoryHandleLike | null> {
  const picker: unknown = Reflect.get(host, "showDirectoryPicker");
  if (typeof picker !== "function") return null;
  try {
    const handle: unknown = await Reflect.apply(picker, host, [
      { id: DIRECTORY_PICKER_ID, mode: "read" },
    ]);
    return isDirectoryHandle(handle) ? handle : null;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    throw error;
  }
}

/**
 * True when a picker or permission error means the visitor (or a browser
 * policy) refused access, as opposed to the picker failing to open.
 *
 * Example:
 *   isPermissionDenied(new DOMException("blocked", "NotAllowedError")); // -> true
 */
export function isPermissionDenied(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError");
}

function toReadPermission(state: PermissionState): ReadPermission {
  return state === "granted" || state === "denied" ? state : "prompt";
}

/**
 * Current read permission for a persisted handle, without prompting.
 * Handles from browsers without the permission API count as granted.
 *
 * Example:
 *   if ((await queryReadPermission(root)) === "granted") startScan();
 */
export async function queryReadPermission(handle: DirectoryHandleLike): Promise<ReadPermission> {
  if (typeof handle.queryPermission !== "function") return "granted";
  try {
    return toReadPermission(await handle.queryPermission({ mode: "read" }));
  } catch {
    // A stale handle (folder moved/deleted) can throw; the visitor must
    // re-grant or re-pick, which is what "prompt" leads the UI to offer.
    return "prompt";
  }
}

/**
 * Ask for read permission again (needs a user gesture, e.g. a
 * "Resume Folder Sync" button click).
 *
 * Example:
 *   button.onclick = async () => setState(await requestReadPermission(root));
 */
export async function requestReadPermission(
  handle: DirectoryHandleLike,
): Promise<ReadPermission> {
  if (typeof handle.requestPermission !== "function") return "granted";
  try {
    return toReadPermission(await handle.requestPermission({ mode: "read" }));
  } catch {
    // Thrown without transient user activation; the button stays offered.
    return "prompt";
  }
}

/**
 * Whether a background re-scan is due (debounced to 10 minutes).
 *
 * Example:
 *   if (shouldAutoScan(lastScanAt, Date.now())) void scan();
 */
export function shouldAutoScan(
  lastScanAt: number | null | undefined,
  now: number,
  minIntervalMs: number = MIN_AUTO_SCAN_INTERVAL_MS,
): boolean {
  if (typeof lastScanAt !== "number" || !Number.isFinite(lastScanAt)) return true;
  // A scan time in the future means the clock moved; do not stall forever.
  if (lastScanAt > now) return true;
  return now - lastScanAt >= minIntervalMs;
}

const STARCRAFT_DIR_RE = /^starcraft ii$/i;
const ACCOUNTS_DIR_RE = /^accounts$/i;
const REPLAYS_DIR_RE = /^replays$/i;
const MULTIPLAYER_DIR_RE = /^multiplayer$/i;

/**
 * Which child folders of `dirName` can lead to Multiplayer replays.
 * Known StarCraft II folders are pruned to the one relevant child;
 * unknown folders (Accounts/<id>, Documents, ...) are walked generically.
 */
function childDirAllowed(dirName: string, childName: string): boolean {
  if (MULTIPLAYER_DIR_RE.test(dirName)) return false;
  if (REPLAYS_DIR_RE.test(dirName)) return MULTIPLAYER_DIR_RE.test(childName);
  if (TOON_HANDLE_RE.test(dirName)) return REPLAYS_DIR_RE.test(childName);
  if (STARCRAFT_DIR_RE.test(dirName)) return ACCOUNTS_DIR_RE.test(childName);
  return !childName.startsWith(".");
}

function defaultYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function defaultNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

interface WalkState {
  options: WalkOptions;
  results: FolderReplay[];
  scanned: number;
  sinceYield: number;
  lastYieldAt: number;
  yieldFn: () => Promise<void>;
  nowFn: () => number;
}

/**
 * Walk a picked folder for Multiplayer replays, yielding to the event
 * loop regularly so the page stays responsive. Accepts the
 * `StarCraft II` folder, `Accounts`, one account, one toon folder,
 * `Replays` or `Multiplayer` itself (and a parent like `Documents`,
 * within `MAX_WALK_DEPTH`).
 *
 * Example:
 *   const replays = await walkMultiplayerReplays(root, {
 *     signal, onEntry: ({ found }) => setFound(found),
 *   });
 */
export async function walkMultiplayerReplays(
  root: DirectoryHandleLike,
  options: WalkOptions = {},
): Promise<FolderReplay[]> {
  const nowFn = options.now ?? defaultNow;
  const state: WalkState = {
    options,
    results: [],
    scanned: 0,
    sinceYield: 0,
    lastYieldAt: nowFn(),
    yieldFn: options.yieldToEventLoop ?? defaultYield,
    nowFn,
  };
  await walkDirectory(root, root.name, 0, state);
  return state.results;
}

async function walkDirectory(
  dir: DirectoryHandleLike,
  path: string,
  depth: number,
  state: WalkState,
): Promise<void> {
  for await (const entry of dir.values()) {
    state.options.signal?.throwIfAborted();
    state.scanned += 1;
    const childPath = `${path}/${entry.name}`;
    if (entry.kind === "file") {
      await skipUnreadable(() => collectFile(entry, childPath, state), state);
    } else if (depth < MAX_WALK_DEPTH && childDirAllowed(dir.name, entry.name)) {
      await skipUnreadable(() => walkDirectory(entry, childPath, depth + 1, state), state);
    }
    await maybeYield(state);
  }
}

/**
 * One unreadable child (deleted mid-walk, locked, permission revoked on
 * a subfolder) must not end the whole scan; cancellation still does.
 */
async function skipUnreadable(work: () => Promise<void>, state: WalkState): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (state.options.signal?.aborted) throw error;
    if (error instanceof DOMException && error.name === "AbortError") throw error;
  }
}

async function collectFile(
  entry: FileHandleLike,
  relativePath: string,
  state: WalkState,
): Promise<void> {
  if (!isReplayFileName(entry.name) || !isMultiplayerReplayPath(relativePath)) return;
  const file = await entry.getFile();
  state.results.push({
    getFile: () => entry.getFile(),
    name: entry.name,
    relativePath,
    size: file.size,
    lastModified: file.lastModified,
  });
}

async function maybeYield(state: WalkState): Promise<void> {
  state.sinceYield += 1;
  const elapsed = state.nowFn() - state.lastYieldAt;
  if (state.sinceYield < YIELD_EVERY_ENTRIES && elapsed < YIELD_BUDGET_MS) return;
  state.options.onEntry?.({ scanned: state.scanned, found: state.results.length });
  await state.yieldFn();
  state.sinceYield = 0;
  state.lastYieldAt = state.nowFn();
  state.options.signal?.throwIfAborted();
}

/**
 * Same result shape from an `<input webkitdirectory>` selection (uses
 * each file's `webkitRelativePath`, which starts with the picked folder).
 *
 * Example:
 *   const replays = filesFromDirectoryInput(input.files ?? []);
 */
export function filesFromDirectoryInput(files: Iterable<File> | ArrayLike<File>): FolderReplay[] {
  const out: FolderReplay[] = [];
  for (const file of Array.from(files)) {
    const relativePath = (file.webkitRelativePath || file.name).replace(/\\/g, "/");
    if (!isReplayFileName(file.name) || !isMultiplayerReplayPath(relativePath)) continue;
    out.push({
      getFile: () => Promise.resolve(file),
      name: file.name,
      relativePath,
      size: file.size,
      lastModified: file.lastModified,
    });
  }
  return out;
}
