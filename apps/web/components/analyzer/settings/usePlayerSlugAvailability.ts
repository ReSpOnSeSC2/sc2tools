"use client";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useOwnerRequestScope, type ClientApiError } from "@/lib/clientApi";
type Availability = { slug: string; available: boolean; reason: string | null };
type Result = { slug: string | null; data?: Availability; error?: ClientApiError; checking: boolean };

/** Debounce before dispatch and abort on each resource/owner change. A→B→A
 * results cannot unlock a newer prefix or deliver a stale account message. */
export function usePlayerSlugAvailability(slug: string | null, needed: boolean) {
  const auth = useAuth(), owner = auth.isLoaded && auth.isSignedIn && auth.userId ? auth.userId : null;
  const runOwned = useOwnerRequestScope(owner, auth.getToken);
  const runOwnedRef = useRef(runOwned); runOwnedRef.current = runOwned;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result>({ slug: null, checking: false });
  const latest = useRef<object | null>(null);
  useEffect(() => {
    if (!owner || !slug || !needed) { latest.current = null; setResult({ slug: null, checking: false }); return; }
    const request = {}, controller = new AbortController(); latest.current = request;
    const runRequest = runOwnedRef.current;
    let active = true;
    setResult({ slug, checking: true });
    const timer = setTimeout(() => {
      void runRequest(owner, async (token, signal, assertCurrent) => {
        const value = await apiCall<Availability>(token, `/v1/me/public-profile/slug?slug=${encodeURIComponent(slug)}`, { signal });
        assertCurrent(); return value;
      }, 20_000, controller.signal).then(data => {
        if (active && latest.current === request && !controller.signal.aborted) setResult({ slug, data, checking: false });
      }).catch(error => {
        if (active && latest.current === request && !controller.signal.aborted) setResult({ slug, error, checking: false });
      });
    }, 300);
    return () => { active = false; clearTimeout(timer); controller.abort(); if (latest.current === request) latest.current = null; };
  }, [slug, needed, owner, attempt]);
  return { data: result.slug === slug ? result.data : undefined, error: result.slug === slug ? result.error : undefined,
    isValidating: needed && (result.slug !== slug || result.checking), mutate: () => setAttempt(value => value + 1) };
}
