"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { boundedApiRequest } from "@/lib/clientApi";
import type { IntentResumeContext } from "@/lib/usePendingIntentResume";

const cancelled = () => new DOMException("Community action cancelled", "AbortError");

/** Manual and resumed actions share one owner/record deadline and cancellation
 * fence. An old JWT, body or cache callback cannot affect a new account. */
export function useCommunityAction(record: string) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const owner = isLoaded && isSignedIn && userId ? userId : null;
  const scope = JSON.stringify([owner, record]);
  const identity = useRef({ scope }); if (identity.current.scope !== scope) identity.current = { scope };
  const active = useRef<AbortController | null>(null), mounted = useRef(false);
  const [busy, setBusy] = useState({ scope, value: false });
  useLayoutEffect(() => {
    mounted.current = true; setBusy({ scope, value: false });
    return () => { mounted.current = false; active.current?.abort(); active.current = null; };
  }, [scope]);
  async function run<T>(operation: (context: IntentResumeContext) => Promise<T>, onError: (error: unknown) => void, supplied?: IntentResumeContext): Promise<T> {
    if (!owner || active.current || supplied && !supplied.isCurrent()) throw cancelled();
    const controller = new AbortController(), captured = identity.current;
    const abort = () => controller.abort(); supplied?.signal.addEventListener("abort", abort, { once: true });
    if (supplied?.signal.aborted) controller.abort(); active.current = controller;
    const valid = () => mounted.current && identity.current === captured && active.current === controller && !controller.signal.aborted && (!supplied || supplied.isCurrent());
    setBusy({ scope, value: true });
    try {
      return await boundedApiRequest(async signal => {
        const context: IntentResumeContext = { signal, isCurrent: () => valid() && !signal.aborted, getToken: async () => {
          if (!valid()) throw cancelled();
          const jwt = await (supplied?.getToken ?? getToken)();
          if (!valid()) throw cancelled(); signal.throwIfAborted(); return jwt;
        } };
        const value = await operation(context); if (!context.isCurrent()) throw cancelled(); return value;
      }, 20_000, controller.signal);
    } catch (error) { if (valid()) onError(error); throw error; }
    finally {
      supplied?.signal.removeEventListener("abort", abort);
      if (active.current === controller) { active.current = null; if (mounted.current && identity.current === captured) setBusy({ scope, value: false }); }
    }
  }
  return { owner, scope, authLoading: !isLoaded, running: busy.scope === scope && busy.value, run };
}
