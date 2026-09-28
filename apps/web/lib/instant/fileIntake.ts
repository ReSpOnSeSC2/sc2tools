/**
 * File intake rules for Instant Analysis: which files we accept, how a
 * browser `File` becomes an `IntakeFile`, the date window pre-filter,
 * parse-time estimates and per-OS "where are my replays?" hints.
 *
 * Everything here is pure (no DOM access beyond reading `File`
 * properties), so the /try page, signed-in import and Folder Sync share
 * one definition of "a replay we will look at".
 *
 * Example:
 *   const files = picked.filter((f) => isReplayFileName(f.name))
 *     .map((f) => makeIntakeFile(f, "picker"));
 *   const inWindow = preFilterByDate(files, { kind: "days90" }, Date.now());
 */
import type { IntakeFile, IntakeSource } from "./types";

/** Anonymous /try analyses at most this many replays per run. */
export const MAX_TRY_FILES = 25;

/**
 * Per-file guard before reading bytes into the worker. Real ladder
 * replays are 0.1–5 MB; anything past this is not a replay we can
 * parse inside the browser memory budget.
 */
export const MAX_REPLAY_BYTES = 32 * 1024 * 1024;

/**
 * Largest .zip we read at all. An archive is held in memory twice (the
 * tab's copy, then the WebAssembly heap) BEFORE Python's zip-bomb guards
 * run, so a big one could crash the tab instead of failing cleanly. This
 * leaves room above the 128 MiB of extracted replays Python accepts
 * (`MAX_ZIP_TOTAL_BYTES`) and stays well inside the ~700 MB worker budget.
 * Bigger collections go through folder import, one file at a time.
 */
export const MAX_ZIP_ARCHIVE_BYTES = 256 * 1024 * 1024;

/** `<input accept>` for desktop browsers. */
export const REPLAY_INPUT_ACCEPT = ".SC2Replay,.zip";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rolling window used by the default "last 90 days" import. */
const DAYS90_WINDOW_MS = 90 * DAY_MS;
/**
 * Slack on the cheap `lastModified` pre-check, mirroring the agent's
 * `sync_filter.MTIME_SLACK` (7 days): a skewed clock or a copied file
 * must never hide a replay; the post-parse date check is authoritative.
 */
export const MTIME_SLACK_MS = 7 * DAY_MS;

/** Engine boot on a cold cache (download + WebAssembly compile + imports). */
export const COLD_BOOT_SECONDS = 6;
/** Conservative per-replay parse time on a mid-range laptop. */
export const PER_FILE_PARSE_SECONDS = 1.5;
const SECONDS_PER_MINUTE = 60;
/** Estimates at or above this many seconds are phrased in minutes. */
const MINUTES_LABEL_THRESHOLD_SECONDS = 90;

const REPLAY_NAME_RE = /\.sc2replay$/i;
const ZIP_NAME_RE = /\.zip$/i;
const IOS_DEVICE_RE = /iPhone|iPad|iPod/;
const MAC_RE = /Macintosh|Mac OS X/;
/** iPadOS 13+ reports a desktop Mac UA; only touch support tells them apart. */
const IPADOS_MIN_TOUCH_POINTS = 2;

/** Date window for an import. `days90` = the last 90 days. */
export type DateWindow = { kind: "days90" } | { kind: "all" };

/** Coarse client platform, used for copy and picker behaviour. */
export type ClientPlatform =
  | "windows"
  | "macos"
  | "ios"
  | "android"
  | "linux"
  | "other";

/** Where a platform keeps its StarCraft II accounts folder. */
export interface OsPathHint {
  platform: "windows" | "macos";
  label: string;
  path: string;
}

export interface ParseEstimate {
  seconds: number;
  label: string;
}

/**
 * True for `*.SC2Replay` in any letter case (the agent compares the
 * suffix case-insensitively too).
 *
 * Example:
 *   isReplayFileName("Game.sc2replay"); // -> true
 */
export function isReplayFileName(name: string): boolean {
  return REPLAY_NAME_RE.test(name);
}

/**
 * True for `*.zip` in any letter case.
 *
 * Example:
 *   isZipFileName("replays.ZIP"); // -> true
 */
export function isZipFileName(name: string): boolean {
  return ZIP_NAME_RE.test(name);
}

/**
 * Stable per-session key for a file. Numbers come first so the key is
 * unambiguous even when the path contains `:`.
 *
 * Example:
 *   intakeKey("a/b.SC2Replay", 10, 99); // -> "10:99:a/b.SC2Replay"
 */
export function intakeKey(
  relativePath: string,
  size: number,
  lastModified: number,
): string {
  return `${size}:${lastModified}:${relativePath}`;
}

/**
 * Wrap a browser `File` as an `IntakeFile`. The relative path is, in
 * order: the explicit `relativePath` (Folder Sync walk), the file's
 * `webkitRelativePath` (`<input webkitdirectory>`), then its name.
 * Backslashes are normalised to `/`.
 *
 * Example:
 *   makeIntakeFile(file, "drop").relativePath; // -> "Game.SC2Replay"
 */
export function makeIntakeFile(
  file: File,
  source: IntakeSource,
  relativePath?: string,
): IntakeFile {
  const rawPath = relativePath || file.webkitRelativePath || file.name;
  const path = rawPath.replace(/\\/g, "/");
  return {
    key: intakeKey(path, file.size, file.lastModified),
    name: file.name,
    relativePath: path,
    size: file.size,
    lastModified: file.lastModified,
    source,
    blob: file,
  };
}

/**
 * True on iPhone/iPod and on iPadOS (which pretends to be a Mac but
 * has a touch screen).
 *
 * Example:
 *   isAppleMobile("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"); // -> true
 */
export function isAppleMobile(userAgent: string, maxTouchPoints = 0): boolean {
  if (IOS_DEVICE_RE.test(userAgent)) return true;
  return MAC_RE.test(userAgent) && maxTouchPoints >= IPADOS_MIN_TOUCH_POINTS;
}

/**
 * `accept` attribute for the replay `<input type="file">`. iOS/iPadOS
 * greys out `.SC2Replay` in the Files picker because it has no UTI for
 * the extension, so there we accept anything and check names later.
 *
 * Example:
 *   replayInputAccept(navigator.userAgent, navigator.maxTouchPoints);
 *   // -> ".SC2Replay,.zip" on desktop, undefined on iOS
 */
export function replayInputAccept(
  userAgent: string,
  maxTouchPoints = 0,
): string | undefined {
  return isAppleMobile(userAgent, maxTouchPoints) ? undefined : REPLAY_INPUT_ACCEPT;
}

/**
 * Human label for a date window.
 *
 * Example:
 *   dateWindowLabel({ kind: "days90" }); // -> "Last 90 days"
 */
export function dateWindowLabel(window: DateWindow): string {
  return window.kind === "days90" ? "Last 90 days" : "All time";
}

/** Inclusive lower bound (epoch ms) of a window, or null when unbounded. */
function windowStartMs(window: DateWindow, now: number): number | null {
  return window.kind === "days90" ? now - DAYS90_WINDOW_MS : null;
}

/**
 * Cheap pre-parse filter on `lastModified`, with the agent's 7-day
 * slack. Files with an unusable timestamp are kept (the parser and
 * `isInDateWindow` decide).
 *
 * Example:
 *   preFilterByDate(files, { kind: "days90" }, Date.now());
 */
export function preFilterByDate<T extends Pick<IntakeFile, "lastModified">>(
  files: ReadonlyArray<T>,
  window: DateWindow,
  now: number,
): T[] {
  const start = windowStartMs(window, now);
  if (start === null) return [...files];
  const floor = start - MTIME_SLACK_MS;
  return files.filter((file) => {
    const mtime = file.lastModified;
    if (!Number.isFinite(mtime) || mtime <= 0) return true;
    return mtime >= floor;
  });
}

/**
 * Authoritative post-parse check against the replay's own date. A
 * missing or unparseable date is included, like the agent's
 * `SyncFilter.replay_in_range`.
 *
 * Example:
 *   isInDateWindow("2020-01-01T00:00:00Z", { kind: "days90" }, Date.now()); // -> false
 */
export function isInDateWindow(
  dateIso: string | null | undefined,
  window: DateWindow,
  now: number,
): boolean {
  const start = windowStartMs(window, now);
  if (start === null || !dateIso) return true;
  const t = Date.parse(dateIso);
  if (!Number.isFinite(t)) return true;
  return t >= start;
}

/**
 * Rough, conservative time to analyse `count` replays. `warm` means the
 * engine is already booted (second batch in the same tab).
 *
 * Example:
 *   estimateParseSeconds(10, { warm: false }); // -> { seconds: 21, label: "about 21 seconds" }
 */
export function estimateParseSeconds(
  count: number,
  options: { warm: boolean },
): ParseEstimate {
  const files = Math.max(0, Math.floor(count));
  const boot = options.warm ? 0 : COLD_BOOT_SECONDS;
  const seconds = Math.ceil(boot + files * PER_FILE_PARSE_SECONDS);
  return { seconds, label: estimateLabel(seconds) };
}

function estimateLabel(seconds: number): string {
  if (seconds < MINUTES_LABEL_THRESHOLD_SECONDS) {
    return seconds === 1 ? "about 1 second" : `about ${seconds} seconds`;
  }
  const minutes = Math.round(seconds / SECONDS_PER_MINUTE);
  return `about ${minutes} minutes`;
}

const WINDOWS_HINT: OsPathHint = {
  platform: "windows",
  label: "Windows",
  path: "Documents\\StarCraft II\\Accounts",
};

const MACOS_HINT: OsPathHint = {
  platform: "macos",
  label: "macOS",
  path: "~/Library/Application Support/Blizzard/StarCraft II/Accounts",
};

/**
 * Where to find the Accounts folder, the visitor's platform first.
 *
 * Example:
 *   osPathHints("macos")[0].path; // -> "~/Library/Application Support/Blizzard/StarCraft II/Accounts"
 */
export function osPathHints(platform: ClientPlatform): OsPathHint[] {
  if (platform === "windows") return [WINDOWS_HINT];
  if (platform === "macos") return [MACOS_HINT];
  return [WINDOWS_HINT, MACOS_HINT];
}

/**
 * Coarse platform from the user agent (plus touch points for iPadOS).
 *
 * Example:
 *   detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"); // -> "windows"
 */
export function detectPlatform(
  userAgent: string,
  maxTouchPoints = 0,
): ClientPlatform {
  if (isAppleMobile(userAgent, maxTouchPoints)) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  if (/Windows/i.test(userAgent)) return "windows";
  if (MAC_RE.test(userAgent)) return "macos";
  if (/Linux|X11|CrOS/i.test(userAgent)) return "linux";
  return "other";
}
