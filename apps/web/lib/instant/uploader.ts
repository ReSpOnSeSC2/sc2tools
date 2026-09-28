/**
 * Signed-in browser upload of parsed games to `POST /v1/games`.
 *
 * Mirrors the desktop agent's wire behaviour while being a polite
 * guest on the API's single ingest slot:
 *
 *   1. `POST /v1/games/exists` (500 ids per call) drops games the
 *      account already has — no need to spend the upload budget on them.
 *   2. Each game's Python-produced JSON is tagged with browser
 *      provenance (its own `engineVersion` when it has one, else the
 *      caller's) and packed into ≤ 50-game / ≤ 4.5 MiB bodies.
 *   3. Batches go STRICTLY one at a time, each with a fresh Clerk token.
 *      Busy/timeout/5xx/network → retry the same batch after
 *      max(Retry-After, full-jitter exponential backoff), capped at 60 s;
 *      401 → one token refresh; 413 → split in half.
 *   4. Daily cap (429 `browser_ingest_daily_cap`): the server refuses a
 *      whole batch that would cross today's cap and reports how many
 *      games still fit (`remaining`), so that many are sent once as a
 *      smaller batch; then the run stops and the rest stay pending. The
 *      cap details (`limit`, `remaining`, `resetAt`) are kept in the
 *      summary so the UI can say when uploads resume.
 *   5. Per-game `retryable` rejections (and ids missing from the
 *      response) are requeued once into a later batch.
 *
 * Example:
 *   const summary = await uploadGames(parsed, {
 *     getToken, apiBase: API_BASE, engineVersion: INSTANT_ENGINE_VERSION,
 *     onProgress: (p) => setProgress(p), signal: controller.signal,
 *   });
 */
import { BrowserGameTagError, buildUploadBatches, tagBrowserGame } from "./batches";
import {
  FORCE_TOKEN_REFRESH,
  abortableSleep,
  backoffDelayMs,
  isAbortError,
  isRetryableStatus,
  joinUrl,
  parseRetryAfterMs,
  readJson,
  type Sleep,
  type TokenGetter,
} from "./httpRetry";
import { parseIngestResponse, type IngestResponse } from "./uploadResponse";
import type { UploadableGame } from "./types";

export type { AcceptedGame, IngestResponse, ReplayArchiveMarker } from "./uploadResponse";

/** `POST /v1/games/exists` accepts at most this many ids per call. */
export const EXISTS_CHUNK_SIZE = 500;
export const DEFAULT_MAX_ATTEMPTS_PER_BATCH = 8;
export const UPLOAD_BACKOFF_BASE_MS = 1000;
export const UPLOAD_BACKOFF_CAP_MS = 60_000;
/** Server sends `Retry-After: 5` on busy/timeout; used when it is unreadable. */
export const BUSY_RETRY_FALLBACK_MS = 5000;

const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVICE_UNAVAILABLE = 503;
const DAILY_CAP_CODE = "browser_ingest_daily_cap";

export type UploadStopReason = "daily_cap" | "auth" | "aborted" | "server";

/** What the daily-cap 429 said (null fields: missing from the body). */
export interface DailyCapInfo {
  /** Browser-uploaded games allowed per UTC day. */
  limit: number | null;
  /** Games that still fitted when the batch was refused. */
  remaining: number | null;
  /** Epoch ms when the cap resets. */
  resetAt: number | null;
}

export interface UploadSummary {
  accepted: IngestResponse["accepted"];
  rejected: Array<{ gameId: string; errors: string[] }>;
  skippedExisting: string[];
  oversized: string[];
  /** Games not settled because the run stopped early (upload later). */
  pending: string[];
  stoppedReason?: UploadStopReason;
  /** Set when the daily browser-upload cap was hit. */
  dailyCap?: DailyCapInfo;
}

export interface UploadProgress {
  phase: "checking" | "uploading" | "waiting" | "done";
  accepted: number;
  /** Games finished either way: accepted, already stored or refused. */
  settled: number;
  total: number;
  /** Set while waiting to retry a batch. */
  retryInMs?: number;
}

export interface UploadDeps {
  /** Clerk's `getToken` (called per request; `{ skipCache: true }` after a 401). */
  getToken: TokenGetter;
  apiBase: string;
  engineVersion: string;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
  random?: () => number;
  now?: () => number;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
  maxAttemptsPerBatch?: number;
}

interface Ctx {
  getToken: TokenGetter;
  apiBase: string;
  fetchImpl: typeof fetch;
  sleep: Sleep;
  random: () => number;
  now: () => number;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
  maxAttempts: number;
  total: number;
  summary: UploadSummary;
  settled: Set<string>;
}

interface PendingGame {
  gameId: string;
  json: string;
  requeued: boolean;
}

interface QueuedBatch {
  games: PendingGame[];
  body: string;
}

type BatchOutcome =
  | { kind: "response"; response: IngestResponse }
  | { kind: "split" }
  | { kind: "rejected_all"; errors: string[] }
  /** Daily cap hit; `cap.remaining` = games the server says still fit today. */
  | { kind: "cap"; cap: DailyCapInfo }
  | { kind: "stop"; reason: UploadStopReason };

interface QueueState {
  queue: QueuedBatch[];
  retryPool: PendingGame[];
  /** A cap-sized final batch was queued; stop once it is done. */
  capped: boolean;
}

type AttemptStep =
  | { kind: "done"; outcome: BatchOutcome }
  | { kind: "auth" }
  | { kind: "retry"; retryAfterMs: number | null };

/**
 * Upload parsed games (see module comment for the full protocol).
 * Never throws for HTTP/network problems; the summary says what happened.
 *
 * Example:
 *   const { accepted, stoppedReason } = await uploadGames(games, deps);
 */
export async function uploadGames(
  games: ReadonlyArray<UploadableGame>,
  deps: UploadDeps,
): Promise<UploadSummary> {
  const unique = dedupeById(games);
  const ctx = createContext(deps, unique.length);
  report(ctx, "checking");
  const existing = await findExisting(unique.map((game) => game.gameId), ctx);
  const fresh: UploadableGame[] = [];
  for (const game of unique) {
    if (!existing.has(game.gameId)) fresh.push(game);
    else settle(ctx, game.gameId, () => ctx.summary.skippedExisting.push(game.gameId));
  }
  if (!ctx.summary.stoppedReason) {
    report(ctx, "uploading"); // games already stored count as done right away
    await runQueue(tagAll(fresh, deps.engineVersion, ctx), ctx);
  }
  ctx.summary.pending = unique.map((game) => game.gameId).filter((id) => !ctx.settled.has(id));
  report(ctx, "done");
  return ctx.summary;
}

function createContext(deps: UploadDeps, total: number): Ctx {
  return {
    getToken: deps.getToken,
    apiBase: deps.apiBase,
    fetchImpl: deps.fetchImpl ?? ((input, init) => fetch(input, init)),
    sleep: deps.sleep ?? abortableSleep,
    random: deps.random ?? Math.random,
    now: deps.now ?? Date.now,
    onProgress: deps.onProgress,
    signal: deps.signal,
    maxAttempts: Math.max(1, deps.maxAttemptsPerBatch ?? DEFAULT_MAX_ATTEMPTS_PER_BATCH),
    total,
    summary: { accepted: [], rejected: [], skippedExisting: [], oversized: [], pending: [] },
    settled: new Set(),
  };
}

function dedupeById(games: ReadonlyArray<UploadableGame>): UploadableGame[] {
  const seen = new Set<string>();
  return games.filter((game) => {
    if (seen.has(game.gameId)) return false;
    seen.add(game.gameId);
    return true;
  });
}

function settle(ctx: Ctx, gameId: string, record: () => void): void {
  if (ctx.settled.has(gameId)) return;
  ctx.settled.add(gameId);
  record();
}

function rejectGame(ctx: Ctx, gameId: string, errors: string[]): void {
  settle(ctx, gameId, () => ctx.summary.rejected.push({ gameId, errors }));
}

function report(ctx: Ctx, phase: UploadProgress["phase"], retryInMs?: number): void {
  ctx.onProgress?.({
    phase,
    accepted: ctx.summary.accepted.length,
    settled: ctx.settled.size,
    total: ctx.total,
    ...(retryInMs === undefined ? {} : { retryInMs }),
  });
}

function authHeaders(token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json",
    authorization: `Bearer ${token}`,
  };
}

type ExistsResult =
  | { kind: "ok"; existing: string[] }
  | { kind: "unavailable" }
  | { kind: "stop"; reason: UploadStopReason };

/**
 * Ids the account already stores. A failing lookup only disables the
 * optimisation (uploads are idempotent upserts), except auth/abort.
 */
async function findExisting(ids: ReadonlyArray<string>, ctx: Ctx): Promise<Set<string>> {
  const existing = new Set<string>();
  for (let start = 0; start < ids.length; start += EXISTS_CHUNK_SIZE) {
    const result = await postExists(ids.slice(start, start + EXISTS_CHUNK_SIZE), ctx);
    if (result.kind === "stop") {
      ctx.summary.stoppedReason = result.reason;
      break;
    }
    if (result.kind === "unavailable") break;
    for (const id of result.existing) existing.add(id);
  }
  return existing;
}

async function postExists(chunk: string[], ctx: Ctx): Promise<ExistsResult> {
  for (let refreshed = false; ; refreshed = true) {
    const auth = await nextToken(ctx, refreshed);
    if ("stop" in auth) return { kind: "stop", reason: auth.stop };
    const res = await fetchExists(chunk, auth.token, ctx);
    if (!(res instanceof Response)) return res;
    if (res.status !== HTTP_UNAUTHORIZED) return readExists(res);
    if (refreshed) return { kind: "stop", reason: "auth" };
  }
}

/**
 * Bearer token for the next request (a forced, uncached one right after
 * a 401), or why the run has to stop instead.
 */
async function nextToken(
  ctx: Ctx,
  forceRefresh: boolean,
): Promise<{ token: string } | { stop: UploadStopReason }> {
  if (ctx.signal?.aborted) return { stop: "aborted" };
  const token = await ctx.getToken(forceRefresh ? FORCE_TOKEN_REFRESH : undefined);
  return token ? { token } : { stop: "auth" };
}

async function readExists(res: Response): Promise<ExistsResult> {
  return res.ok ? parseExistsBody(await readJson(res)) : { kind: "unavailable" };
}

/** One `/v1/games/exists` request; a network failure disables the lookup. */
async function fetchExists(
  chunk: string[],
  token: string,
  ctx: Ctx,
): Promise<Response | ExistsResult> {
  try {
    return await ctx.fetchImpl(joinUrl(ctx.apiBase, "/v1/games/exists"), {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ gameIds: chunk }),
      cache: "no-store",
      signal: ctx.signal,
    });
  } catch (error) {
    if (isAbortError(error) || ctx.signal?.aborted) return { kind: "stop", reason: "aborted" };
    return { kind: "unavailable" };
  }
}

function parseExistsBody(body: unknown): ExistsResult {
  if (typeof body !== "object" || body === null || !("existing" in body)) {
    return { kind: "unavailable" };
  }
  const list = body.existing;
  if (!Array.isArray(list)) return { kind: "unavailable" };
  return { kind: "ok", existing: list.filter((id): id is string => typeof id === "string") };
}

/** Tag each game with its own engine version when it has one (stored /try games). */
function tagAll(
  games: ReadonlyArray<UploadableGame>,
  engineVersion: string,
  ctx: Ctx,
): PendingGame[] {
  const pending: PendingGame[] = [];
  for (const game of games) {
    try {
      const json = tagBrowserGame(game.json, game.engineVersion ?? engineVersion);
      pending.push({ gameId: game.gameId, json, requeued: false });
    } catch (error) {
      if (!(error instanceof BrowserGameTagError)) throw error;
      rejectGame(ctx, game.gameId, ["invalid_game_json"]);
    }
  }
  return pending;
}

function planBatches(games: ReadonlyArray<PendingGame>, ctx: Ctx): QueuedBatch[] {
  const byId = new Map(games.map((game) => [game.gameId, game]));
  const plan = buildUploadBatches(games);
  for (const id of plan.oversized) settle(ctx, id, () => ctx.summary.oversized.push(id));
  return plan.batches.map((batch) => ({
    body: batch.body,
    games: batch.gameIds.flatMap((id) => byId.get(id) ?? []),
  }));
}

async function runQueue(initial: PendingGame[], ctx: Ctx): Promise<void> {
  const state: QueueState = { queue: planBatches(initial, ctx), retryPool: [], capped: false };
  for (let batch = state.queue.shift(); batch; batch = state.queue.shift()) {
    const outcome = await sendWithRetry(batch, ctx);
    const stop = applyOutcome(batch, outcome, state, ctx);
    report(ctx, "uploading");
    if (stop || (state.capped && state.queue.length === 0)) {
      ctx.summary.stoppedReason = stop ?? "daily_cap";
      return;
    }
    if (state.queue.length === 0 && state.retryPool.length > 0) {
      state.queue = planBatches(state.retryPool, ctx);
      state.retryPool = [];
    }
  }
}

/** Record one batch's outcome; returns a reason when the run must stop. */
function applyOutcome(
  batch: QueuedBatch,
  outcome: BatchOutcome,
  state: QueueState,
  ctx: Ctx,
): UploadStopReason | null {
  switch (outcome.kind) {
    case "stop":
      return outcome.reason;
    case "cap":
      ctx.summary.dailyCap = outcome.cap;
      return shrinkToDailyCap(batch, outcome.cap.remaining, state, ctx);
    case "split":
      state.queue = [...splitBatch(batch, ctx), ...state.queue];
      return null;
    case "rejected_all":
      rejectAll(batch, outcome.errors, ctx);
      return null;
    case "response":
      state.retryPool = [...state.retryPool, ...applyResponse(batch, outcome.response, ctx)];
      return null;
  }
}

/**
 * The server refused the whole batch because it would cross today's cap
 * but said how many games still fit: send exactly that many (once), drop
 * everything else from this run, and stop after them. Without a usable
 * `remaining` (older API, or nothing fits) stop right away.
 */
function shrinkToDailyCap(
  batch: QueuedBatch,
  remaining: number | null,
  state: QueueState,
  ctx: Ctx,
): UploadStopReason | null {
  const fits = remaining ?? 0;
  if (state.capped || fits <= 0 || fits >= batch.games.length) return "daily_cap";
  state.capped = true;
  state.queue = planBatches(batch.games.slice(0, fits), ctx);
  state.retryPool = [];
  return null;
}

function splitBatch(batch: QueuedBatch, ctx: Ctx): QueuedBatch[] {
  if (batch.games.length <= 1) {
    rejectAll(batch, ["payload_too_large"], ctx);
    return [];
  }
  const middle = Math.ceil(batch.games.length / 2);
  return [
    ...planBatches(batch.games.slice(0, middle), ctx),
    ...planBatches(batch.games.slice(middle), ctx),
  ];
}

function rejectAll(batch: QueuedBatch, errors: string[], ctx: Ctx): void {
  for (const game of batch.games) rejectGame(ctx, game.gameId, errors);
}

/** Record accepted/rejected items; return games to requeue once. */
function applyResponse(batch: QueuedBatch, response: IngestResponse, ctx: Ctx): PendingGame[] {
  const open = new Map(batch.games.map((game) => [game.gameId, game]));
  for (const item of response.accepted) {
    if (!open.delete(item.gameId)) continue;
    settle(ctx, item.gameId, () => ctx.summary.accepted.push(item));
  }
  const requeue: PendingGame[] = [];
  for (const item of response.rejected) {
    const game = item.gameId === null ? undefined : open.get(item.gameId);
    if (!game) continue;
    open.delete(game.gameId);
    if (item.retryable && !game.requeued) requeue.push({ ...game, requeued: true });
    else rejectGame(ctx, game.gameId, item.errors);
  }
  for (const game of open.values()) {
    if (!game.requeued) requeue.push({ ...game, requeued: true });
    else rejectGame(ctx, game.gameId, ["missing_from_response"]);
  }
  return requeue;
}

async function sendWithRetry(batch: QueuedBatch, ctx: Ctx): Promise<BatchOutcome> {
  let retries = 0;
  let refreshedAuth = false;
  let forceRefresh = false;
  for (;;) {
    // Right after a 401, bypass Clerk's token cache (one forced refresh).
    const auth = await nextToken(ctx, forceRefresh);
    if ("stop" in auth) return { kind: "stop", reason: auth.stop };
    forceRefresh = false;
    const step = await attemptBatch(batch, auth.token, ctx);
    if (step.kind === "done") return step.outcome;
    if (step.kind === "auth") {
      if (refreshedAuth) return { kind: "stop", reason: "auth" };
      refreshedAuth = true;
      forceRefresh = true;
      continue;
    }
    retries += 1;
    if (retries >= ctx.maxAttempts) return { kind: "stop", reason: "server" };
    if (!(await waitToRetry(retries - 1, step.retryAfterMs, ctx))) {
      return { kind: "stop", reason: "aborted" };
    }
  }
}

/**
 * Sleep before retry number `attempt` (0-based); false when aborted.
 * Reports the wait so the UI can show "retrying in N s".
 */
async function waitToRetry(attempt: number, retryAfterMs: number | null, ctx: Ctx): Promise<boolean> {
  const waitMs = backoffDelayMs(attempt, {
    baseMs: UPLOAD_BACKOFF_BASE_MS,
    capMs: UPLOAD_BACKOFF_CAP_MS,
    random: ctx.random,
    retryAfterMs,
  });
  report(ctx, "waiting", waitMs);
  try {
    await ctx.sleep(waitMs, ctx.signal);
    return true;
  } catch (error) {
    if (isAbortError(error) || ctx.signal?.aborted) return false;
    throw error;
  }
}

async function attemptBatch(batch: QueuedBatch, token: string, ctx: Ctx): Promise<AttemptStep> {
  let res: Response;
  try {
    res = await ctx.fetchImpl(joinUrl(ctx.apiBase, "/v1/games"), {
      method: "POST",
      headers: authHeaders(token),
      body: batch.body,
      cache: "no-store",
      signal: ctx.signal,
    });
  } catch (error) {
    if (isAbortError(error) || ctx.signal?.aborted) {
      return { kind: "done", outcome: { kind: "stop", reason: "aborted" } };
    }
    return { kind: "retry", retryAfterMs: null };
  }
  return classifyIngestResponse(res, ctx);
}

async function classifyIngestResponse(res: Response, ctx: Ctx): Promise<AttemptStep> {
  if (res.ok) return readAccepted(res);
  if (res.status === HTTP_UNAUTHORIZED) return { kind: "auth" };
  if (res.status === HTTP_FORBIDDEN) {
    return { kind: "done", outcome: { kind: "stop", reason: "auth" } };
  }
  if (res.status === HTTP_PAYLOAD_TOO_LARGE) return { kind: "done", outcome: { kind: "split" } };
  const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"), ctx.now());
  const { code, cap } = await readIngestError(res);
  if (res.status === HTTP_TOO_MANY_REQUESTS && code === DAILY_CAP_CODE) {
    return { kind: "done", outcome: { kind: "cap", cap } };
  }
  if (isRetryableStatus(res.status)) {
    return { kind: "retry", retryAfterMs: retryAfterMs ?? busyFallbackMs(res.status) };
  }
  const errors = [code ?? `http_${res.status}`];
  return { kind: "done", outcome: { kind: "rejected_all", errors } };
}

interface IngestError {
  code: string | null;
  /** Daily-cap 429 only: `limit`, `remaining` and `resetAt`. */
  cap: DailyCapInfo;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function integerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function instantOrNull(value: unknown): number | null {
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : null;
}

/**
 * The API error envelope `{ error: { code, limit?, remaining?, resetAt? } }`
 * (nulls for a plain-text or empty body, e.g. the rate limiter's).
 */
async function readIngestError(res: Response): Promise<IngestError> {
  const body = await readJson(res);
  const error = isRecord(body) ? body.error : null;
  if (!isRecord(error)) return { code: null, cap: { limit: null, remaining: null, resetAt: null } };
  return {
    code: typeof error.code === "string" ? error.code : null,
    cap: {
      limit: integerOrNull(error.limit),
      remaining: integerOrNull(error.remaining),
      resetAt: instantOrNull(error.resetAt),
    },
  };
}

/** A 2xx body; an unreadable one is retried (ingest is an idempotent upsert). */
async function readAccepted(res: Response): Promise<AttemptStep> {
  const response = parseIngestResponse(await readJson(res));
  return response
    ? { kind: "done", outcome: { kind: "response", response } }
    : { kind: "retry", retryAfterMs: null };
}

/** 503 busy / 408 body-timeout always come with `Retry-After: 5`. */
function busyFallbackMs(status: number): number | null {
  return status === HTTP_SERVICE_UNAVAILABLE || status === HTTP_REQUEST_TIMEOUT
    ? BUSY_RETRY_FALLBACK_MS
    : null;
}
