/**
 * Small HTTP helpers shared by the browser uploader and replay backup:
 * the bearer-token getter type (with a forced refresh after a 401),
 * `Retry-After` parsing, capped exponential backoff with full jitter,
 * an abortable sleep and typed reading of the API error envelope
 * (`{ error: { code, message, retryable } }`).
 *
 * Example:
 *   const token = await getToken(refreshed ? FORCE_TOKEN_REFRESH : undefined);
 *   const wait = backoffDelayMs(attempt, { baseMs: 1000, capMs: 60_000, random: Math.random,
 *     retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after"), Date.now()) });
 *   await abortableSleep(wait, signal);
 */

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/**
 * Bearer-token source. Clerk's `useAuth().getToken` fits as-is: callers
 * pass `{ skipCache: true }` after a 401 to force a freshly minted
 * session token instead of the cached one.
 */
export type TokenGetter = (options?: { skipCache?: boolean }) => Promise<string | null>;

/** Options for the token request that follows a 401 (one forced refresh). */
export const FORCE_TOKEN_REFRESH = Object.freeze({ skipCache: true });

export interface BackoffOptions {
  baseMs: number;
  capMs: number;
  /** Uniform [0, 1) source; injected for deterministic tests. */
  random: () => number;
  /** Server-requested minimum wait, if any. */
  retryAfterMs?: number | null;
}

const MS_PER_SECOND = 1000;
const HAS_LETTER_RE = /[A-Za-z]/;
const INTEGER_SECONDS_RE = /^\d+$/;

/**
 * `Retry-After` as milliseconds from `nowMs`: integer seconds or an
 * HTTP-date. Null when absent or unreadable (e.g. not CORS-exposed).
 *
 * Example:
 *   parseRetryAfterMs("5", Date.now()); // -> 5000
 */
export function parseRetryAfterMs(value: string | null | undefined, nowMs: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (INTEGER_SECONDS_RE.test(trimmed)) return Number(trimmed) * MS_PER_SECOND;
  // Every HTTP-date form names a weekday or month; V8's Date.parse would
  // otherwise read junk such as "1.5" or "-1" as a year-2001 date.
  if (!HAS_LETTER_RE.test(trimmed)) return null;
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - nowMs);
}

/**
 * Wait before retry `attempt` (0-based): full-jitter exponential
 * backoff `random() * min(cap, base * 2^attempt)`, never shorter than
 * the server's `Retry-After`, and never longer than `capMs`.
 *
 * Example:
 *   backoffDelayMs(3, { baseMs: 1000, capMs: 60_000, random: () => 0.5 }); // -> 4000
 */
export function backoffDelayMs(attempt: number, options: BackoffOptions): number {
  const exponential = Math.min(options.capMs, options.baseMs * 2 ** Math.max(0, attempt));
  const jittered = options.random() * exponential;
  const floor = options.retryAfterMs ?? 0;
  return Math.round(Math.min(options.capMs, Math.max(floor, jittered)));
}

/**
 * The DOMException fetch throws when its signal aborts.
 *
 * Example:
 *   throw abortError();
 */
export function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * True for an abort, from fetch, a sleep or `signal.throwIfAborted()`.
 *
 * Example:
 *   catch (e) { if (isAbortError(e)) return "aborted"; }
 */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

/**
 * `setTimeout` sleep that rejects with an AbortError when `signal`
 * aborts (immediately if it already has).
 *
 * Example:
 *   await abortableSleep(5000, controller.signal);
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface ApiErrorInfo {
  code: string | null;
  retryable: boolean | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parse the API error envelope from a response body (never throws; a
 * non-JSON body such as the rate limiter's plain text yields nulls).
 *
 * Example:
 *   const { code } = await readApiError(res); // "replay_ingest_busy"
 */
export async function readApiError(res: Response): Promise<ApiErrorInfo> {
  let body: unknown = null;
  try {
    body = JSON.parse(await res.text());
  } catch {
    // Plain-text or empty error bodies carry no code; callers fall back
    // to the HTTP status.
    return { code: null, retryable: null };
  }
  const error = isRecord(body) ? body.error : null;
  if (!isRecord(error)) return { code: null, retryable: null };
  return {
    code: typeof error.code === "string" ? error.code : null,
    retryable: typeof error.retryable === "boolean" ? error.retryable : null,
  };
}

/**
 * Read a JSON body as `unknown` (null when it is not JSON).
 *
 * Example:
 *   const body = await readJson(res);
 */
export async function readJson(res: Response): Promise<unknown> {
  try {
    return JSON.parse(await res.text());
  } catch {
    // An unparseable success body is treated like a transient failure by
    // callers (they validate the shape and retry).
    return null;
  }
}

const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_MIN = 500;

/**
 * 408, 429 and 5xx are worth retrying; other statuses are not.
 *
 * Example:
 *   isRetryableStatus(503); // -> true
 */
export function isRetryableStatus(status: number): boolean {
  return (
    status === HTTP_REQUEST_TIMEOUT ||
    status === HTTP_TOO_MANY_REQUESTS ||
    status >= HTTP_SERVER_ERROR_MIN
  );
}

/**
 * Join an API base URL and a path without doubling slashes.
 *
 * Example:
 *   joinUrl("https://api.example/", "/v1/games"); // -> "https://api.example/v1/games"
 */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}
