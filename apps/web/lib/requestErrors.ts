import type { ClientApiError } from "./clientApi";

/**
 * Plain-language reading of a failed request, shared by RequestError
 * (the Retry panel), QueryState and the app-wide ConnectionBanner.
 *
 * Every data hook in the app throws a ClientApiError, but a component
 * can still meet a raw TypeError (a fetch that never reached the
 * server) or an Error from a hand-rolled fetch, so everything here
 * accepts `unknown`.
 */

/** What went wrong, from the user's side. */
export type RequestErrorKind =
  /** No answer at all: offline, DNS, CORS, or the server is restarting. */
  | "network"
  /** The request outlived its deadline. */
  | "timeout"
  /** The server answered "one heavy job at a time, try shortly" (503 / *_busy). */
  | "busy"
  /** The session expired (401). */
  | "signed_out"
  /** The account can't see this (403). */
  | "forbidden"
  /** The thing asked for doesn't exist (404). */
  | "not_found"
  /** Too many requests in a short time (429). */
  | "rate_limited"
  /** The server failed (5xx). */
  | "server"
  /** Anything else, e.g. a 400 with the server's own explanation. */
  | "other";

export interface RequestErrorCopy {
  title: string;
  body: string;
}

const NETWORK_CODES = new Set(["network_unavailable"]);

/** Gateway statuses Render's proxy returns while the API restarts. */
const GATEWAY_STATUSES = new Set([502, 504]);

/**
 * Coerce whatever a hook threw into the ClientApiError shape. A
 * TypeError is what fetch() rejects with when the request never got an
 * answer, so it reads as a network failure.
 *
 * Example: `toClientApiError(new TypeError("Failed to fetch"))` →
 * `{ status: 0, code: "network_unavailable", message: "…" }`.
 */
export function toClientApiError(error: unknown): ClientApiError {
  if (error instanceof TypeError) return networkUnavailableError();
  if (error && typeof error === "object") {
    const e = error as Partial<ClientApiError>;
    // A plain Error from a hand-rolled fetch has no status; -1 keeps it
    // out of the "no answer" bucket that status 0 means.
    const status = typeof e.status === "number" ? e.status : -1;
    const message = typeof e.message === "string" && e.message ? e.message : "Request failed.";
    return {
      status,
      message,
      ...(typeof e.code === "string" ? { code: e.code } : {}),
      ...(typeof e.requestId === "string" && e.requestId ? { requestId: e.requestId } : {}),
      ...(Array.isArray(e.details) ? { details: e.details } : {}),
    };
  }
  return { status: -1, message: typeof error === "string" && error ? error : "Request failed." };
}

/** The error a request that never reached the API turns into. */
export function networkUnavailableError(): ClientApiError {
  return {
    status: 0,
    code: "network_unavailable",
    message: "The API is unavailable or your connection was interrupted. Try again in a moment.",
  };
}

/**
 * Sort a failure into a {@link RequestErrorKind}.
 *
 * Example: `requestErrorKind({ status: 503, code: "opponent_profile_busy", message: "" })` → "busy".
 */
export function requestErrorKind(error: unknown): RequestErrorKind {
  const e = toClientApiError(error);
  const code = e.code ?? "";
  if (code === "request_timeout") return "timeout";
  if (NETWORK_CODES.has(code) || e.status === 0 || GATEWAY_STATUSES.has(e.status)) return "network";
  if (code.endsWith("_busy")) return "busy";
  // A bare 503 is the proxy's page while the API restarts; a 503 the
  // API sent itself carries a code ("replay_storage_unavailable").
  if (e.status === 503) return code ? "server" : "network";
  if (e.status === 401 || code === "unauthorized" || code === "auth_required") return "signed_out";
  if (e.status === 403 || code === "forbidden") return "forbidden";
  if (e.status === 404 || code === "not_found") return "not_found";
  if (e.status === 429 || code === "rate_limited") return "rate_limited";
  if (e.status >= 500) return "server";
  return "other";
}

/**
 * True for failures that mean "we can't reach SC2 Tools right now"
 * rather than "this one request is wrong": no answer at all, or the
 * proxy's gateway errors while the server restarts. The connection
 * banner counts these.
 */
export function isConnectivityError(error: unknown): boolean {
  return requestErrorKind(error) === "network";
}

/** True when the server says the requested record doesn't exist. */
export function isNotFoundError(error: unknown): boolean {
  return requestErrorKind(error) === "not_found";
}

const COPY: Record<Exclude<RequestErrorKind, "other">, RequestErrorCopy> = {
  network: {
    title: "Can't reach SC2 Tools",
    body: "Check your connection. If you're online, the server may be waking up, which takes about 30 seconds.",
  },
  timeout: {
    title: "This took too long to load",
    body: "The server didn't answer in time. Try again, or narrow the date range.",
  },
  busy: {
    title: "The server is busy",
    body: "Another heavy request is still running. Try again in a moment.",
  },
  signed_out: {
    title: "You're signed out",
    body: "Your session ended. Sign in again to load this.",
  },
  forbidden: {
    title: "You don't have access to this",
    body: "This belongs to another account, or your access changed.",
  },
  not_found: {
    title: "We couldn't find this",
    body: "It may have been deleted, or the link is out of date.",
  },
  rate_limited: {
    title: "Too many requests",
    body: "Wait a few seconds, then try again.",
  },
  server: {
    title: "Something went wrong on our side",
    body: "Try again in a moment. If it keeps happening, report it with the Error ID.",
  },
};

/**
 * Title and body for a failure. For a 4xx the API explained in its own
 * words ("name must be 3–40 characters"), the body is that message.
 *
 * Example: `requestErrorCopy({ status: 0, code: "network_unavailable", message: "" }).title` →
 * "Can't reach SC2 Tools".
 */
export function requestErrorCopy(error: unknown): RequestErrorCopy {
  const kind = requestErrorKind(error);
  if (kind !== "other") return COPY[kind];
  const e = toClientApiError(error);
  return {
    title: "Couldn't load this",
    body: e.status >= 400 && e.message && !/^HTTP \d+$/.test(e.message)
      ? e.message
      : "Something went wrong. Try again.",
  };
}
