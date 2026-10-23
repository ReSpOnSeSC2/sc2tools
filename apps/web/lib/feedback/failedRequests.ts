import { sanitiseRequestPath } from "./sanitise";

/**
 * The last few API requests that failed in this tab, kept so a bug
 * report can say what went wrong ("500 on /v1/games, ref req_123")
 * without the player copying anything. lib/clientApi.ts records every
 * failed request; the report form attaches the most recent ones, and
 * the player can untick them before sending.
 *
 * Memory only: nothing is stored, and a reload starts empty. Paths are
 * credential-free (lib/feedback/sanitise.ts) before they are kept.
 */
export interface FailedRequest {
  /** "/v1/games?limit=50", credentials redacted. */
  path: string;
  /** HTTP status; 0 when the request never got a response. */
  status: number;
  /** API error code, e.g. "internal_error". */
  code?: string;
  /** API request id, the reference an admin looks up in the logs. */
  requestId?: string;
}

/** How many failed requests a report carries. */
export const FAILED_REQUESTS_KEPT = 5;
const CODE_MAX = 64;
const REQUEST_ID_MAX = 64;
// Reports themselves are not diagnostics for the next report.
const IGNORED_PATHS = /^\/v1\/messages(?:[/?]|$)/u;

let buffer: FailedRequest[] = [];

function cleanToken(value: string | undefined, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, max);
  return trimmed || undefined;
}

/**
 * Remember a failed request, oldest dropped past FAILED_REQUESTS_KEPT.
 *
 * Example: `recordFailedRequest({ path: "/v1/games", status: 500, code: "internal_error" })`.
 */
export function recordFailedRequest(request: FailedRequest): void {
  const path = sanitiseRequestPath(request.path);
  if (!path || IGNORED_PATHS.test(path)) return;
  const status = Number.isInteger(request.status) && request.status >= 0 && request.status <= 599 ? request.status : 0;
  const entry: FailedRequest = { path, status };
  const code = cleanToken(request.code, CODE_MAX);
  if (code) entry.code = code;
  const requestId = cleanToken(request.requestId, REQUEST_ID_MAX);
  if (requestId) entry.requestId = requestId;
  buffer = [...buffer, entry].slice(-FAILED_REQUESTS_KEPT);
}

/** The remembered failed requests, oldest first. */
export function recentFailedRequests(): FailedRequest[] {
  return buffer.map((entry) => ({ ...entry }));
}

/** Forget every remembered failure (tests, and after a report is sent). */
export function clearFailedRequests(): void {
  buffer = [];
}
