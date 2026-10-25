"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useRef, useState } from "react";
import { boundedApiRequest } from "./clientApi";
import { claimPendingIntent, readPendingIntent, type IntentKind, type PendingIntent } from "./pendingIntent";
import { gaEvent } from "./analytics/gtag";

export interface IntentResumeContext {
  signal: AbortSignal;
  getToken: () => Promise<string | null>;
  isCurrent: () => boolean;
}

/** One claiming page instance executes the original action. The claim is
 * deferred through one microtask so StrictMode cleanup can abort before
 * consumption. Owner/path epochs fence even A→B→A and delayed JWT/body work. */
export function usePendingIntentResume<K extends IntentKind>(
  kind: K,
  path: string,
  ready: boolean,
  matches: (payload: PendingIntent<K>["payload"]) => boolean,
  resume: (intent: PendingIntent<K>, context: IntentResumeContext) => Promise<boolean>,
) {
  const auth = useAuth();
  const owner = auth.isLoaded && auth.isSignedIn && auth.userId ? auth.userId : null;
  const key = JSON.stringify([owner, kind, path]);
  const scope = useRef({ key }); if (scope.current.key !== key) scope.current = { key };
  const identity = scope.current;
  const callbacks = useRef({ matches, resume, getToken: auth.getToken }); callbacks.current = { matches, resume, getToken: auth.getToken };
  const active = useRef<AbortController | null>(null);
  const [state, setState] = useState<{ identity: typeof identity; status: "idle" | "running" | "complete" | "error" }>({ identity, status: "idle" });

  useEffect(() => {
    if (!owner || !ready) return;
    const controller = new AbortController(); active.current = controller;
    const isCurrent = () => scope.current === identity && active.current === controller && !controller.signal.aborted;
    void Promise.resolve().then(async () => {
      if (!isCurrent()) return;
      const pending = readPendingIntent(path, kind);
      if (!pending || !callbacks.current.matches(pending.payload)) return;
      const intent = claimPendingIntent(path, kind); if (!intent || intent.id !== pending.id) return;
      setState({ identity, status: "running" });
      const operation = callbacks.current.resume, token = callbacks.current.getToken;
      try {
        const completed = await boundedApiRequest(signal => operation(intent, {
          signal, isCurrent: () => isCurrent() && !signal.aborted,
          getToken: async () => {
            if (!isCurrent()) throw new DOMException("Sign-in changed", "AbortError");
            const jwt = await token();
            if (!isCurrent()) throw new DOMException("Sign-in changed", "AbortError");
            signal.throwIfAborted(); return jwt;
          },
        }), 20_000, controller.signal);
        if (!isCurrent()) return;
        setState({ identity, status: completed ? "complete" : "error" });
        if (completed) gaEvent("auth_intent_completed", { kind });
      } catch { if (isCurrent()) setState({ identity, status: "error" }); }
    });
    return () => { controller.abort(); if (active.current === controller) active.current = null; };
  }, [owner, identity, kind, path, ready]);

  const status = state.identity === identity ? state.status : "idle";
  return { running: status === "running", completed: status === "complete", error: status === "error" ? "Your sign-in action wasn’t completed. Use the action button to try again." : null };
}
