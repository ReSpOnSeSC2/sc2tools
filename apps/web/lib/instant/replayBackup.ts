/**
 * Optional backup of original .SC2Replay files after a browser upload.
 *
 * Same three-step protocol as the desktop agent's archive lane:
 *   1. POST /v1/games/{id}/replay-upload {filename, sizeBytes, sha256, md5}
 *      → a signed R2 PUT (or `alreadyStored`)
 *   2. PUT the original bytes to the signed URL with the returned headers
 *      (minus `content-length`, which browsers forbid and compute)
 *   3. POST /v1/games/{id}/replay-upload/complete {uploadId}
 *
 * Runs strictly one file at a time at the lowest priority, after the
 * game rows exist. Busy/5xx/network errors back off (2 s doubling to
 * 60 s, full jitter, bounded attempts); invalid requests and unknown
 * games are skipped; auth failure, a server without replay storage
 * (`replay_storage_unavailable`) or an abort stops the run.
 *
 * Example:
 *   const summary = await backupReplays(items, { getToken, apiBase: API_BASE });
 */
import {
  FORCE_TOKEN_REFRESH,
  abortableSleep,
  backoffDelayMs,
  isAbortError,
  isRetryableStatus,
  joinUrl,
  parseRetryAfterMs,
  readApiError,
  readJson,
  type Sleep,
  type TokenGetter,
} from "./httpRetry";
import type { IntakeFile, ReplayDigests } from "./types";
import type { ReplayArchiveMarker } from "./uploadResponse";

/** Server cap `REPLAY_FILE_MAX_BYTES` (5 MiB). */
export const REPLAY_BACKUP_MAX_BYTES = 5 * 1024 * 1024;
/** Server minimum (an MPQ header alone is 4 bytes). */
export const REPLAY_BACKUP_MIN_BYTES = 4;
export const BACKUP_BACKOFF_BASE_MS = 2000;
export const BACKUP_BACKOFF_CAP_MS = 60_000;
export const DEFAULT_BACKUP_MAX_ATTEMPTS = 5;
/** Server filename limit. */
export const MAX_BACKUP_FILENAME_LENGTH = 255;

const REPLAY_EXTENSION = ".SC2Replay";
const REPLAY_EXTENSION_RE = /\.sc2replay$/i;
const HTTP_URL_RE = /^https?:\/\//i;
const CONTROL_CHAR_MAX = 0x1f;
const DELETE_CHAR = 0x7f;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_SERVICE_UNAVAILABLE = 503;
/** The API runs without an R2 replay store (`REPLAY_FILES_STORE=disabled`). */
const STORAGE_UNAVAILABLE_CODE = "replay_storage_unavailable";

export interface BackupItem {
  gameId: string;
  file: IntakeFile;
  digests: ReplayDigests;
  replayArchive?: ReplayArchiveMarker;
}

export interface BackupDeps {
  /** Clerk's `getToken` (called per request; `{ skipCache: true }` after a 401). */
  getToken: TokenGetter;
  apiBase: string;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
  random?: () => number;
  now?: () => number;
  signal?: AbortSignal;
  onProgress?: (progress: { done: number; total: number }) => void;
  maxAttempts?: number;
}

/** `unavailable`: the server has no replay store, so no item can succeed. */
export type BackupStopReason = "auth" | "aborted" | "unavailable";

const STOP_REASONS: ReadonlyArray<BackupStopReason> = ["auth", "aborted", "unavailable"];

export interface BackupSummary {
  backedUp: string[];
  alreadyStored: string[];
  skipped: string[];
  failed: string[];
  stoppedReason?: BackupStopReason;
}

type ItemOutcome = "backedUp" | "alreadyStored" | "skipped" | "failed" | BackupStopReason;

type Step<T> =
  | { kind: "ok"; value: T }
  | { kind: "end"; outcome: ItemOutcome }
  | { kind: "retry"; retryAfterMs: number | null }
  | { kind: "auth" };

type Prepared =
  | { kind: "alreadyStored" }
  | { kind: "upload"; url: string; headers: Record<string, string>; uploadId: string };

interface Ctx {
  deps: BackupDeps;
  fetchImpl: typeof fetch;
  sleep: Sleep;
  random: () => number;
  now: () => number;
  maxAttempts: number;
}

/**
 * Server-safe file name: basename only, no control characters, ends in
 * `.SC2Replay`, at most 255 characters.
 *
 * Example:
 *   sanitizeReplayFilename("a/b\\Tourmaline LE.sc2replay"); // -> "Tourmaline LE.SC2Replay"
 */
export function sanitizeReplayFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const printable = Array.from(base)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > CONTROL_CHAR_MAX && code !== DELETE_CHAR;
    })
    .join("")
    .trim();
  const stem = printable.replace(REPLAY_EXTENSION_RE, "").trim() || "replay";
  const room = MAX_BACKUP_FILENAME_LENGTH - REPLAY_EXTENSION.length;
  return `${truncateUtf16(stem, room)}${REPLAY_EXTENSION}`;
}

/**
 * Longest prefix of whole code points within `maxUnits` UTF-16 code
 * units. The server limits `filename.length` (UTF-16 units), so an emoji
 * counts as 2, and a surrogate pair is never cut in half.
 */
function truncateUtf16(text: string, maxUnits: number): string {
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > maxUnits) break;
    out += ch;
  }
  return out;
}

/**
 * True when the server's archive marker proves this exact file is
 * stored (same rule as the agent's `replay_file_matches_archive_marker`).
 *
 * Example:
 *   archiveMatches({ available: true, sizeBytes: 9, sha256: "ab…" }, digests);
 */
export function archiveMatches(
  marker: ReplayArchiveMarker | undefined,
  digests: ReplayDigests,
): boolean {
  if (!marker || marker.available !== true || typeof marker.sha256 !== "string") return false;
  if (marker.sizeBytes !== digests.sizeBytes) return false;
  if (digests.sizeBytes <= 0 || digests.sizeBytes > REPLAY_BACKUP_MAX_BYTES) return false;
  return marker.sha256.trim().toLowerCase() === digests.sha256.trim().toLowerCase();
}

/**
 * Back up original replays one by one (see module comment).
 *
 * Example:
 *   const { backedUp, failed } = await backupReplays(items, deps);
 */
export async function backupReplays(
  items: ReadonlyArray<BackupItem>,
  deps: BackupDeps,
): Promise<BackupSummary> {
  const ctx = createContext(deps);
  const summary: BackupSummary = { backedUp: [], alreadyStored: [], skipped: [], failed: [] };
  for (const [index, item] of items.entries()) {
    const outcome = deps.signal?.aborted ? "aborted" : await backupOne(item, ctx);
    if (isStopReason(outcome)) {
      summary.stoppedReason = outcome;
      break;
    }
    summary[outcome].push(item.gameId);
    deps.onProgress?.({ done: index + 1, total: items.length });
  }
  return summary;
}

function createContext(deps: BackupDeps): Ctx {
  return {
    deps,
    fetchImpl: deps.fetchImpl ?? ((input, init) => fetch(input, init)),
    sleep: deps.sleep ?? abortableSleep,
    random: deps.random ?? Math.random,
    now: deps.now ?? Date.now,
    maxAttempts: Math.max(1, deps.maxAttempts ?? DEFAULT_BACKUP_MAX_ATTEMPTS),
  };
}

async function backupOne(item: BackupItem, ctx: Ctx): Promise<ItemOutcome> {
  if (archiveMatches(item.replayArchive, item.digests)) return "alreadyStored";
  const size = item.digests.sizeBytes;
  if (size < REPLAY_BACKUP_MIN_BYTES || size > REPLAY_BACKUP_MAX_BYTES) return "skipped";
  // The digests describe the bytes that were parsed; a changed file would fail verification.
  if (item.file.blob.size !== size) return "skipped";
  const prepared = await withRetry(ctx, (refresh) => prepareAttempt(item, ctx, refresh));
  if (prepared.kind === "end") return prepared.outcome;
  if (prepared.value.kind === "alreadyStored") return "alreadyStored";
  const upload = prepared.value;
  const put = await withRetry(ctx, () => putAttempt(item, upload.url, upload.headers, ctx));
  if (put.kind === "end") return put.outcome;
  const done = await withRetry(ctx, (refresh) => completeAttempt(item, upload.uploadId, ctx, refresh));
  return done.kind === "end" ? done.outcome : "backedUp";
}

/**
 * Run one protocol step with bounded retries. `attempt(true)` means "the
 * previous try got a 401: fetch a fresh token" (done at most once).
 */
async function withRetry<T>(
  ctx: Ctx,
  attempt: (forceTokenRefresh: boolean) => Promise<Step<T>>,
): Promise<{ kind: "ok"; value: T } | { kind: "end"; outcome: ItemOutcome }> {
  let retries = 0;
  let refreshedAuth = false;
  let forceRefresh = false;
  for (;;) {
    if (ctx.deps.signal?.aborted) return { kind: "end", outcome: "aborted" };
    const step = await attempt(forceRefresh);
    forceRefresh = false;
    if (step.kind === "ok" || step.kind === "end") return step;
    if (step.kind === "auth") {
      if (refreshedAuth) return { kind: "end", outcome: "auth" };
      refreshedAuth = true;
      forceRefresh = true;
      continue;
    }
    retries += 1;
    if (retries >= ctx.maxAttempts) return { kind: "end", outcome: "failed" };
    if (!(await waitToRetry(retries - 1, step.retryAfterMs, ctx))) {
      return { kind: "end", outcome: "aborted" };
    }
  }
}

/** Back off before retry `attempt` (0-based); false when aborted. */
async function waitToRetry(attempt: number, retryAfterMs: number | null, ctx: Ctx): Promise<boolean> {
  const waitMs = backoffDelayMs(attempt, {
    baseMs: BACKUP_BACKOFF_BASE_MS,
    capMs: BACKUP_BACKOFF_CAP_MS,
    random: ctx.random,
    retryAfterMs,
  });
  try {
    await ctx.sleep(waitMs, ctx.deps.signal);
    return true;
  } catch (error) {
    if (isAbortError(error) || ctx.deps.signal?.aborted) return false;
    throw error;
  }
}

/** fetch that maps an abort to "aborted" and any other throw to a retry. */
async function send<T>(
  ctx: Ctx,
  url: string,
  init: RequestInit,
  classify: (res: Response) => Promise<Step<T>>,
): Promise<Step<T>> {
  let res: Response;
  try {
    res = await ctx.fetchImpl(url, { ...init, signal: ctx.deps.signal });
  } catch (error) {
    if (isAbortError(error) || ctx.deps.signal?.aborted) return { kind: "end", outcome: "aborted" };
    return { kind: "retry", retryAfterMs: null };
  }
  return classify(res);
}

async function apiInit(
  ctx: Ctx,
  body: unknown,
  forceTokenRefresh: boolean,
): Promise<RequestInit | null> {
  const token = await ctx.deps.getToken(forceTokenRefresh ? FORCE_TOKEN_REFRESH : undefined);
  if (!token) return null;
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  };
}

function uploadPath(gameId: string, suffix = ""): string {
  return `/v1/games/${encodeURIComponent(gameId)}/replay-upload${suffix}`;
}

async function prepareAttempt(
  item: BackupItem,
  ctx: Ctx,
  forceTokenRefresh: boolean,
): Promise<Step<Prepared>> {
  const body = {
    filename: sanitizeReplayFilename(item.file.name),
    sizeBytes: item.digests.sizeBytes,
    sha256: item.digests.sha256.trim().toLowerCase(),
    md5: item.digests.md5,
  };
  const init = await apiInit(ctx, body, forceTokenRefresh);
  if (!init) return { kind: "end", outcome: "auth" };
  return send(ctx, joinUrl(ctx.deps.apiBase, uploadPath(item.gameId)), init, async (res) => {
    if (res.ok) {
      const prepared = parsePrepared(await readJson(res));
      return prepared ? { kind: "ok", value: prepared } : { kind: "end", outcome: "failed" };
    }
    return classifyApiError(res, ctx, "prepare");
  });
}

async function putAttempt(
  item: BackupItem,
  url: string,
  headers: Record<string, string>,
  ctx: Ctx,
): Promise<Step<true>> {
  const init: RequestInit = { method: "PUT", headers: putHeaders(headers), body: item.file.blob };
  return send(ctx, url, init, async (res) => {
    if (res.ok) return { kind: "ok", value: true };
    if (isRetryableStatus(res.status)) {
      return { kind: "retry", retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after"), ctx.now()) };
    }
    return { kind: "end", outcome: "failed" };
  });
}

async function completeAttempt(
  item: BackupItem,
  uploadId: string,
  ctx: Ctx,
  forceTokenRefresh: boolean,
): Promise<Step<true>> {
  const init = await apiInit(ctx, { uploadId }, forceTokenRefresh);
  if (!init) return { kind: "end", outcome: "auth" };
  const url = joinUrl(ctx.deps.apiBase, uploadPath(item.gameId, "/complete"));
  return send(ctx, url, init, async (res) => {
    if (res.ok) {
      const body = await readJson(res);
      const available = isRecord(body) && body.replayAvailable === true;
      return available ? { kind: "ok", value: true } : { kind: "end", outcome: "failed" };
    }
    return classifyApiError(res, ctx, "complete");
  });
}

/** Shared non-2xx handling for prepare/complete. */
async function classifyApiError<T>(
  res: Response,
  ctx: Ctx,
  stage: "prepare" | "complete",
): Promise<Step<T>> {
  if (res.status === HTTP_UNAUTHORIZED) return { kind: "auth" };
  if (res.status === HTTP_FORBIDDEN) return { kind: "end", outcome: "auth" };
  const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"), ctx.now());
  const { code } = await readApiError(res);
  if (res.status === HTTP_SERVICE_UNAVAILABLE && code === STORAGE_UNAVAILABLE_CODE) {
    return { kind: "end", outcome: "unavailable" };
  }
  const busy = res.status === HTTP_CONFLICT && code === "replay_upload_busy";
  if (busy || isRetryableStatus(res.status)) return { kind: "retry", retryAfterMs };
  return { kind: "end", outcome: terminalOutcome(res.status, code, stage) };
}

/**
 * Invalid requests (400/413) and unknown games (404 `game_not_found`) at
 * prepare are "skipped" (nothing to back up); anything else is "failed".
 */
function terminalOutcome(
  status: number,
  code: string | null,
  stage: "prepare" | "complete",
): "skipped" | "failed" {
  if (stage !== "prepare") return "failed";
  const invalid = status === HTTP_BAD_REQUEST || status === HTTP_PAYLOAD_TOO_LARGE;
  const unknownGame = status === HTTP_NOT_FOUND && code === "game_not_found";
  return invalid || unknownGame ? "skipped" : "failed";
}

function isStopReason(outcome: ItemOutcome): outcome is BackupStopReason {
  return STOP_REASONS.some((reason) => reason === outcome);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringHeaders(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue === "string") headers[name] = headerValue;
  }
  return headers;
}

function parsePrepared(body: unknown): Prepared | null {
  if (!isRecord(body)) return null;
  if (body.alreadyStored === true) return { kind: "alreadyStored" };
  const { url, uploadId } = body;
  const headers = stringHeaders(body.headers);
  if (typeof url !== "string" || !HTTP_URL_RE.test(url)) return null;
  if (typeof uploadId !== "string" || uploadId === "" || !headers) return null;
  return { kind: "upload", url, headers, uploadId };
}

/**
 * Signed headers for the R2 PUT without `content-length`, a forbidden
 * request header the browser derives from the Blob body.
 *
 * Example:
 *   putHeaders({ "content-length": "9", "content-md5": "x" }); // -> { "content-md5": "x" }
 */
export function putHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "content-length") out[name] = value;
  }
  return out;
}
