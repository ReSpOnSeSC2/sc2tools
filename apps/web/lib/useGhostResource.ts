"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useRef } from "react";
import useSWR from "swr";
import { apiCall, boundedApiRequest, type ClientApiError } from "./clientApi";

/** Ghost reads use the ordinary owner-keyed SWR cache, with an additional
 * request epoch around token/body awaits. An A-B-A transition cannot publish
 * a new account's token/body into the first A request's cache entry. */
export function useGhostResource<T>(path: string, read?: (getToken: () => Promise<string | null>, signal: AbortSignal) => Promise<T>) {
  const { userId, isLoaded, isSignedIn, getToken } = useAuth();
  const owner = isLoaded && isSignedIn && userId ? userId : null;
  const scope = useRef({ owner });
  if (scope.current.owner !== owner) scope.current = { owner };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return useSWR<T, ClientApiError>(owner ? ["authenticated-api", owner, path] : null, async ([, requestedOwner]: readonly [string, string, string]) => {
    const captured = scope.current;
    const check = () => {
      if (!mounted.current || scope.current !== captured || captured.owner !== requestedOwner) throw new DOMException("Sign-in changed", "AbortError");
    };
    return boundedApiRequest(async signal => {
      check(); const token = await getToken(); signal.throwIfAborted(); check();
      if (!token) throw new Error("Sign in again to read practice assignments.");
      const result = await (read ? read(() => Promise.resolve(token), signal) : apiCall<T>(() => Promise.resolve(token), path, { signal }));
      signal.throwIfAborted(); check(); return result;
    }, 20_000);
  }, { keepPreviousData: false, revalidateOnFocus: true, shouldRetryOnError: error => (error as unknown as { name?: string }).name !== "AbortError" });
}
