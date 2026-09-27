"use client";

import { useAuth } from "@clerk/nextjs";
import useSWR, { type SWRConfiguration } from "swr";
import { API_BASE, type ClientApiError } from "./clientApi";

type PublicApiOptions = {
  /**
   * Attach the viewer's token when they are signed in, so the API can
   * personalise the response (your votes, your capabilities). The read
   * starts anonymously right away and refetches once Clerk reports a
   * signed-in user — it never WAITS for Clerk, so a visitor whose Clerk
   * script is blocked still gets the public data.
   */
  personalized?: boolean;
};

/**
 * SWR for PUBLIC API reads (review pages, the review board).
 *
 * ``useApi`` is inert for signed-out visitors by design; public pages
 * still need data for them. The account is part of the SWR key, so a
 * warm anonymous response is never shown as a signed-in viewer's (or
 * the reverse).
 */
export function usePublicApi<T>(
  path: string | null,
  config?: SWRConfiguration<T, ClientApiError>,
  options: PublicApiOptions = {},
) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const viewer = options.personalized && isLoaded && isSignedIn && userId ? userId : "anonymous";
  const key = path ? (["public-api", viewer, path] as const) : null;
  return useSWR<T, ClientApiError>(
    key,
    async ([, who, requestPath]: readonly [string, string, string]) => {
      const token = who === "anonymous" ? null : await getToken();
      const res = await fetch(`${API_BASE}${requestPath}`, {
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        cache: "no-store",
      });
      if (!res.ok) {
        let code: string | undefined;
        let message = `Request failed (HTTP ${res.status}).`;
        try {
          const body = (await res.json()) as { error?: { code?: string; message?: string } };
          code = body?.error?.code;
          if (body?.error?.message) message = body.error.message;
        } catch {
          /* non-JSON error page */
        }
        throw { status: res.status, code, message } satisfies ClientApiError;
      }
      return (await res.json()) as T;
    },
    config,
  );
}
