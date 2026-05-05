"use client";

// Client-side fetch helpers + SWR fetcher. Pulls Clerk JWT via the
// hook so it works inside React effects.

import { useAuth } from "@clerk/nextjs";
import useSWR, { type SWRConfiguration } from "swr";

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
};

/** SWR-style hook that auto-attaches the Clerk JWT. */
export function useApi<T>(
  path: string | null,
  config?: SWRConfiguration<T, ClientApiError>,
) {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const key = isLoaded && isSignedIn && path ? path : null;
  return useSWR<T, ClientApiError>(
    key,
    async (p) => {
      const token = await getToken();
      const res = await fetch(`${API_BASE}${p}`, {
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        cache: "no-store",
      });
      if (!res.ok) throw await buildApiError(res);
      return res.json();
    },
    config,
  );
}

/** For mutations. Returns the JSON or throws ClientApiError. */
export async function apiCall<T>(
  getToken: () => Promise<string | null>,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers || {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    cache: "no-store",
  });
  if (!res.ok) throw await buildApiError(res);
  if (res.status === 204) return null as unknown as T;
  return res.json();
}

/**
 * Translate an error response into a {@link ClientApiError} with a
 * human-friendly `message`. Recognizes the `{ error: { code, message,
 * requestId } }` envelope our API uses and falls back to status text.
 */
async function buildApiError(res: Response): Promise<ClientApiError> {
  const raw = await safeReadText(res);
  const parsed = tryParseEnvelope(raw);
  if (parsed) {
    return {
      status: res.status,
      code: parsed.code,
      requestId: parsed.requestId,
      message: humanizeMessage(res.status, parsed.code, parsed.message),
    };
  }
  return {
    status: res.status,
    message: raw || res.statusText || `HTTP ${res.status}`,
  };
}

function tryParseEnvelope(
  text: string,
): { code?: string; message?: string; requestId?: string } | null {
  if (!text || text[0] !== "{") return null;
  try {
    const obj = JSON.parse(text) as unknown;
    if (!obj || typeof obj !== "object") return null;
    const env = (obj as { error?: unknown }).error;
    if (!env || typeof env !== "object") return null;
    const e = env as { code?: unknown; message?: unknown; requestId?: unknown };
    return {
      code: typeof e.code === "string" ? e.code : undefined,
      message: typeof e.message === "string" ? e.message : undefined,
      requestId: typeof e.requestId === "string" ? e.requestId : undefined,
    };
  } catch {
    return null;
  }
}

function humanizeMessage(
  status: number,
  code: string | undefined,
  message: string | undefined,
): string {
  // If the server already gave a non-generic, non-code message, keep it.
  if (message && message !== code && message !== "internal_error") {
    return message;
  }
  switch (code) {
    case "auth_required":
    case "unauthorized":
      return "You need to sign in again.";
    case "forbidden":
      return "You don't have permission for that.";
    case "not_found":
      return "Not found.";
    case "rate_limited":
      return "Too many requests — try again in a moment.";
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
