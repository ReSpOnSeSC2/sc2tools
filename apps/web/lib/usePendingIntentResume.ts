"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { boundedApiRequest } from "./clientApi";
import { claimPendingIntent, readPendingIntent, type IntentKind, type PendingIntent } from "./pendingIntent";
import { gaEvent } from "./analytics/gtag";

// Responsive copies share admission/busy state. A hidden claiming view must
// also disable a visible copy until its automatic action settles or aborts.
const inFlight = new Map<string, AbortController>();
type FailedIntent = { intent: PendingIntent; expiresAt: number };
const failures = new Map<string, FailedIntent>();
const subscribers = new Set<() => void>();
const subscribe = (listener: () => void) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; };
const changed = () => { for (const listener of subscribers) listener(); };

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
  const sharedRunning = useSyncExternalStore(subscribe, () => !!owner && inFlight.has(key), () => false);
  const failure = useSyncExternalStore(subscribe, () => owner ? failures.get(key) ?? null : null, () => null);
  const scope = useRef({ key }); if (scope.current.key !== key) scope.current = { key };
  const identity = scope.current;
  const callbacks = useRef({ matches, resume, getToken: auth.getToken }); callbacks.current = { matches, resume, getToken: auth.getToken };
  const active = useRef<AbortController | null>(null);
  const [state, setState] = useState<{ identity: typeof identity; status: "idle" | "running" | "complete" | "error" }>({ identity, status: "idle" });

  useEffect(() => {
    if (!failure) return;
    const timer = setTimeout(() => { if (failures.get(key) === failure) { failures.delete(key); changed(); } }, Math.max(0, failure.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [failure, key]);

  useEffect(() => {
    if (!owner || !ready) return;
    const controller = new AbortController(); active.current = controller;
    const isCurrent = () => scope.current === identity && active.current === controller && !controller.signal.aborted;
    void Promise.resolve().then(async () => {
      if (!isCurrent()) return;
      const pending = readPendingIntent(path, kind);
      if (!pending || !callbacks.current.matches(pending.payload)) return;
      if (inFlight.has(key) || inFlight.size >= 64) return;
      const intent = claimPendingIntent(path, kind); if (!intent || intent.id !== pending.id) return;
      failures.delete(key); inFlight.set(key, controller); changed();
      setState({ identity, status: "running" });
      const operation = callbacks.current.resume, token = callbacks.current.getToken;
      const failed = () => {
        for (const [old, value] of failures) if (value.expiresAt <= Date.now()) failures.delete(old);
        if (failures.size >= 64) failures.delete(failures.keys().next().value!);
        failures.set(key, { intent, expiresAt: Date.now() + 120_000 }); changed();
      };
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
        else failed();
      } catch { if (isCurrent()) { setState({ identity, status: "error" }); failed(); } }
      finally { if (inFlight.get(key) === controller) { inFlight.delete(key); changed(); } }
    });
    return () => {
      controller.abort(); if (active.current === controller) active.current = null;
      if (inFlight.get(key) === controller) { inFlight.delete(key); changed(); }
    };
  }, [owner, identity, kind, path, ready, key]);

  const status = state.identity === identity ? state.status : "idle";
  const matchingFailure = failure && failure.expiresAt > Date.now() && failure.intent.kind === kind && callbacks.current.matches((failure.intent as PendingIntent<K>).payload);
  return { running: status === "running" || sharedRunning, completed: status === "complete",
    error: matchingFailure ? "Your sign-in action wasn’t completed. Use the action button to try again." : null,
    clearError: () => { if (failures.delete(key)) changed(); },
  };
}
