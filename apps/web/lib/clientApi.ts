"use client";

// Client-side fetch helpers + SWR fetcher. Pulls Clerk JWT via the
// hook so it works inside React effects. Every failed request is also
// remembered (credentials stripped) so a bug report can include the
// last few: see lib/feedback/failedRequests.ts.

import { useLayoutEffect, useRef } from "react";
import { useAuth } from "@clerk/nextjs";
import useSWR, {
  unstable_serialize,
  useSWRConfig,
  type SWRConfiguration,
  type SWRResponse,
} from "swr";
import { recordFailedRequest } from "@/lib/feedback/failedRequests";
import { networkUnavailableError } from "./requestErrors";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8080";

export type ClientApiError = {
  status: number;
  /** Human-friendly message; never raw JSON. */
  message: string;
  /** API error code (e.g. "internal_error", "bad_request"). */
  code?: string;
  /** API request id, useful for support. */
  requestId?: string;
  /** Verbatim per-field error strings the API returned (validation errors). */
  details?: string[];
};

export type ClientApiRequestOptions = {
  /** Opt-in deadline for authentication, the response, and its body. */
  timeoutMs?: number;
};

/** What {@link useApi} returns: SWR's response plus two extras. */
export type ApiResponse<T> = SWRResponse<T, ClientApiError> & {
  /**
   * True while `data` is the answer to this hook's previous request: a
   * filter just changed and the new answer is on its way.
   */
  readonly isPreviousData: boolean;
  /** Send a request to the same resource with the same credentials. */
  request: <R = unknown>(init: RequestInit) => Promise<R>;
};

/** SWR-style hook that auto-attaches the Clerk JWT. */
export function useApi<T>(
  path: string | null,
  config?: SWRConfiguration<T, ClientApiError>,
  requestOptions?: ClientApiRequestOptions,
): ApiResponse<T> {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  // An authenticated response belongs to one Clerk account. Keeping userId in
  // the SWR identity prevents a late response or warm cache from account A
  // being read after the browser switches to account B. The request path sent
  // to the API remains unchanged.
  const key = isLoaded && isSignedIn && userId && path
    ? (["authenticated-api", userId, path] as const)
    : null;
  const result = useSWR<T, ClientApiError>(
    key,
    async ([, , requestPath]: readonly [string, string, string]) => {
      const fetchResource = async (signal?: AbortSignal) => {
        const token = await getToken();
        signal?.throwIfAborted();
        const res = await trackedFetch(requestPath, `${API_BASE}${requestPath}`, {
          headers: token ? { authorization: `Bearer ${token}` } : undefined,
          cache: "no-store",
          ...(signal ? { signal } : {}),
        });
        if (!res.ok) throw noteFailure(requestPath, await buildApiError(res));
        return res.json();
      };
      return requestOptions?.timeoutMs
        ? boundedApiRequest(fetchResource, requestOptions.timeoutMs)
        : fetchResource();
    },
    config,
  );
  const resolvePrevious = usePreviousDataScope(
    key,
    key ? `${key[1]} ${resourcePath(key[2])}` : null,
    config,
  );
  // Reuse the same authenticated resource path for explicit refresh actions.
  // Keeping the token closure here avoids duplicating auth in data consumers.
  return Object.assign(scopePreviousData(result, resolvePrevious), {
    request: <R = unknown>(init: RequestInit): Promise<R> => {
      if (!path) return Promise.reject(new Error("No resource selected."));
      if (!key) return Promise.reject(new Error("You need to sign in again."));
      return requestOptions?.timeoutMs
        ? boundedApiRequest((signal) => apiCall<R>(getToken, path, { ...init, signal }), requestOptions.timeoutMs, init.signal)
        : apiCall<R>(getToken, path, init);
    },
  });
}

type ScopedData = { data: unknown; isPreviousData: boolean };

/**
 * The app shell turns on SWR's `keepPreviousData`
 * (components/chrome/ConnectionStatus.tsx), so changing a filter keeps
 * the last answer on screen instead of flashing a skeleton. That is only
 * honest while the answer is about the same thing. Previous data is
 * kept while the account and the resource path (everything before "?"
 * or "#") stay the same, so a filter, page or revision change keeps it.
 * It is dropped when the account changes, the user signs out, or the
 * hook moves to another record (another opponent, another game).
 *
 * Returns a resolver for the data SWR hands back this render: data for
 * a key with no cache entry of its own is the previous key's, and is
 * only passed through when that key had the same scope.
 */
function usePreviousDataScope(
  key: readonly unknown[] | null,
  scope: string | null,
  config: SWRConfiguration | undefined,
): (data: unknown) => ScopedData {
  const { cache } = useSWRConfig();
  const hasOwnData = key !== null && cache.get(unstable_serialize(key))?.data !== undefined;
  // Scope of the last key this hook rendered its own data for. SWR moves
  // its "previous data" ref in a layout effect; this follows it. A null
  // key (a closed modal, a signed-out user) forgets it, so reopening on
  // another record of the same resource starts from the skeleton.
  const lastScope = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (key === null) lastScope.current = null;
    else if (hasOwnData) lastScope.current = scope;
  });
  // fallbackData is the caller's own answer for this key, never stale.
  const ownsFallback = config?.fallbackData !== undefined;
  const sameScope = scope !== null && lastScope.current === scope;
  return (data) => {
    if (data === undefined || hasOwnData || ownsFallback) {
      return { data, isPreviousData: false };
    }
    return sameScope
      ? { data, isPreviousData: true }
      : { data: undefined, isPreviousData: false };
  };
}

/**
 * Point `data` at the scoped value and add `isPreviousData`, keeping
 * SWR's lazy getters (a consumer that never reads `data` must not
 * re-render when it changes) and the response object itself.
 */
function scopePreviousData<T>(
  result: SWRResponse<T, ClientApiError>,
  resolve: (data: unknown) => ScopedData,
): SWRResponse<T, ClientApiError> & { readonly isPreviousData: boolean } {
  const swrData = Object.getOwnPropertyDescriptor(result, "data");
  const readSwrData = (): unknown =>
    swrData?.get ? swrData.get.call(result) : swrData?.value;
  Object.defineProperty(result, "data", {
    configurable: true,
    enumerable: true,
    get: () => {
      const scoped = resolve(readSwrData());
      // Legacy consumers may not inspect isPreviousData. Never hand them
      // another filter's answer after the current request has failed.
      return result.error && scoped.isPreviousData ? undefined : scoped.data;
    },
  });
  Object.defineProperty(result, "isPreviousData", {
    configurable: true,
    enumerable: true,
    get: () => resolve(readSwrData()).isPreviousData,
  });
  return result as SWRResponse<T, ClientApiError> & { readonly isPreviousData: boolean };
}

/**
 * The resource a request path names, without its query or hash.
 *
 * Example: `resourcePath("/v1/matchups?since=2026-01-01#3")` → "/v1/matchups".
 */
export function resourcePath(path: string): string {
  const end = path.search(/[?#]/);
  return end < 0 ? path : path.slice(0, end);
}

/** For mutations. Returns the JSON or throws ClientApiError. */
export async function apiCall<T>(
  getToken: () => Promise<string | null>,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await getToken();
  init.signal?.throwIfAborted();
  const res = await trackedFetch(path, `${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers || {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    cache: "no-store",
  });
  if (!res.ok) throw noteFailure(path, await buildApiError(res));
  if (res.status === 204) return null as unknown as T;
  return res.json();
}

/** Remember a failed response for bug reports, then hand the error back to throw. */
function noteFailure(path: string, error: ClientApiError): ClientApiError {
  recordFailedRequest({ path, status: error.status, code: error.code, requestId: error.requestId });
  return error;
}

/**
 * fetch() that also remembers a request that never got a response
 * (offline, DNS, CORS). Aborts are the caller's choice, not failures.
 */
async function trackedFetch(path: string, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (error instanceof TypeError) recordFailedRequest({ path, status: 0, code: "network_error" });
    throw error;
  }
}

/** A scoped deadline also settles a stalled token lookup or response body. */
export async function boundedApiRequest<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  callerSignal?: AbortSignal | null,
): Promise<T> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError: ClientApiError = {
    status: 0,
    code: "request_timeout",
    message: "The API took too long to respond. Try again, or narrow the date range and player selection.",
  };
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(timeoutError);
      }, timeoutMs);
    });
    // Promise.race retains rejection handlers on the operation after timeout.
    return await Promise.race([operation(controller.signal), deadline]);
  } catch (error) {
    if (timedOut) throw timeoutError;
    if (error instanceof TypeError) throw networkUnavailableError();
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

/**
 * Translate an error response into a {@link ClientApiError} with a
 * human-friendly `message`. Recognizes the `{ error: { code, message,
 * requestId } }` envelope our API uses and falls back to status text.
 */
export async function buildApiError(res: Response): Promise<ClientApiError> {
  const raw = await safeReadText(res);
  const parsed = tryParseEnvelope(raw);
  if (parsed) {
    return {
      status: res.status,
      code: parsed.code,
      requestId: parsed.requestId,
      details: parsed.details,
      message: humanizeMessage(
        res.status,
        parsed.code,
        parsed.message,
        parsed.details,
      ),
    };
  }
  return {
    status: res.status,
    // Reverse proxies may return an HTML error page, and older APIs may
    // return an unfamiliar JSON envelope. Neither is useful UI copy.
    message: /^\s*[<{\[]/.test(raw) || raw.length > 500
      ? humanizeMessage(res.status, undefined, undefined)
      : raw || res.statusText || `HTTP ${res.status}`,
  };
}

function tryParseEnvelope(text: string): {
  code?: string;
  message?: string;
  requestId?: string;
  details?: string[];
} | null {
  text = text.trim();
  if (!text || text[0] !== "{") return null;
  try {
    const obj = JSON.parse(text) as unknown;
    if (!obj || typeof obj !== "object") return null;
    const env = (obj as { error?: unknown }).error;
    if (!env || typeof env !== "object") return null;
    const e = env as {
      code?: unknown;
      message?: unknown;
      requestId?: unknown;
      details?: unknown;
    };
    let details: string[] | undefined;
    if (Array.isArray(e.details)) {
      const stringified = e.details
        .filter((d): d is string => typeof d === "string" && d.length > 0);
      if (stringified.length > 0) details = stringified;
    }
    return {
      code: typeof e.code === "string" ? e.code : undefined,
      message: typeof e.message === "string" ? e.message : undefined,
      requestId: typeof e.requestId === "string" ? e.requestId : undefined,
      details,
    };
  } catch {
    return null;
  }
}

function humanizeMessage(
  status: number,
  code: string | undefined,
  message: string | undefined,
  details?: string[],
): string {
  // If the server already gave a non-generic, non-code message, keep it.
  if (message && message !== code && message !== "internal_error") {
    return message;
  }
  // Validation-style errors often arrive with a code + details array but
  // no humanised message. Surface the first detail verbatim so the user
  // sees "name must match …" instead of a generic "Request failed".
  if (details && details.length > 0) {
    return details.length === 1 ? details[0] : details.join(" · ");
  }
  switch (code) {
    case "pairing_not_found":
      return "That code has expired or doesn't exist. Codes last 10 minutes and the app shows a new one automatically.";
    case "pairing_already_claimed":
      return "That code has already been linked. Use a fresh code shown in the SC2 Tools window on your PC.";
    case "pairing_failed":
      return "Couldn't link this PC. Check the code in the SC2 Tools window and try again.";
    case "unpair_failed":
      return "Couldn't unpair this PC. Please try again.";
    case "auth_required":
    case "unauthorized":
      return "You need to sign in again.";
    case "forbidden":
      return "You don't have permission for that.";
    case "not_found":
      return "Not found.";
    case "rate_limited":
      return "Too many requests — try again in a moment.";
    case "trends_busy":
      return "Another analysis is still running. Please try again shortly.";
    case "preview_unavailable":
      return "Live preview is temporarily unavailable.";
    case "bad_request":
    case "unprocessable":
      return "Some fields look invalid. Check your input and try again.";
    case "conflict":
      return "That conflicts with another resource.";
    case "internal_error":
      return "Something went wrong on our side. Try again in a moment.";
    default:
      if (status >= 500) {
        return "Something went wrong on our side. Try again in a moment.";
      }
      if (status >= 400) return `Request failed (HTTP ${status}).`;
      return message || `HTTP ${status}`;
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text || res.statusText;
  } catch {
    return res.statusText;
  }
}
