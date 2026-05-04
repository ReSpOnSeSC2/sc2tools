"use client";

// Client-side fetch helpers + SWR fetcher. Pulls Clerk JWT via the
// hook so it works inside React effects.

import { useAuth } from "@clerk/nextjs";
import useSWR, { type SWRConfiguration } from "swr";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8080";

export type ClientApiError = {
  status: number;
  message: string;
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
      if (!res.ok) {
        throw {
          status: res.status,
          message: await safeReadText(res),
        } satisfies ClientApiError;
      }
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
  if (!res.ok) {
    throw {
      status: res.status,
      message: await safeReadText(res),
    } satisfies ClientApiError;
  }
  if (res.status === 204) return null as unknown as T;
  return res.json();
}

async function safeReadText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text || res.statusText;
  } catch {
    return res.statusText;
  }
}
