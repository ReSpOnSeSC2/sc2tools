"use client";

import { useLayoutEffect, useRef } from "react";
import { useAuth } from "@clerk/nextjs";
import { useApi } from "@/lib/clientApi";

/** Always admit a fresh response for this owner/path lifetime, including A→B→A.
 * Any error (especially 409) wins over SWR's warm successful data. */
export function useSessionRequest<T>(path: string | null) {
  const auth = useAuth();
  const owner = auth.isLoaded && auth.isSignedIn ? auth.userId : null;
  const response = useApi<T>(path, {
    keepPreviousData: false, revalidateOnMount: true, dedupingInterval: 0,
    compare: (left, right) => left === right, revalidateOnFocus: false,
    revalidateOnReconnect: false, shouldRetryOnError: false,
  }, { timeoutMs: 15_000 });
  const key = JSON.stringify([owner, path]);
  const admission = useRef({ key, initial: response.data, active: true });
  if (admission.current.key !== key) {
    admission.current.active = false;
    admission.current = { key, initial: response.data, active: true };
  }
  const lifetime = admission.current;
  useLayoutEffect(() => {
    lifetime.active = true;
    return () => { lifetime.active = false; };
  }, [lifetime]);
  const current = () => lifetime.active && admission.current === lifetime;
  const waiting = response.data === lifetime.initial || response.isPreviousData || response.isValidating;
  const data = owner && path && !response.error && !waiting ? response.data : undefined;
  const retry = () => current() ? response.mutate() : undefined;
  return { data, error: response.error, mutate: retry, current, key, owner };
}
