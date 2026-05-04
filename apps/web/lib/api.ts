// Server-side helpers for talking to the cloud API. Always pulls a
// fresh Clerk session token via auth() — never caches it.

import { auth } from "@clerk/nextjs/server";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8080";

export type ApiResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; status: number; error: string };

/**
 * Server-side fetch with the user's Clerk JWT attached. For use inside
 * server components, route handlers, and server actions.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) {
    return { ok: false, status: 401, error: "not_signed_in" };
  }
  const url = `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers || {}),
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      cache: "no-store",
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : "network_error",
    };
  }
  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `http_${res.status}`;
    return { ok: false, status: res.status, error: message };
  }
  return { ok: true, status: res.status, data: body as T };
}
