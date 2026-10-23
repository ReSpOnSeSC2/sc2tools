"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useUserSocket } from "@/lib/useUserSocket";

/**
 * One realtime source for every build check-in surface (header chip,
 * queue, game page card, settings). The provider owns a single user
 * socket and turns `build-intent:changed` pings — plus `games:changed`,
 * which is how freshly uploaded games join the pending queue — into a
 * `revision` number that consumers fold into their SWR keys. A ping that
 * carries `{ prefs: true }` (the switches changed, e.g. in the desktop
 * app) also bumps `prefsRevision`, which the Settings tab follows.
 *
 * The socket is only open while at least one mounted consumer asks for
 * live updates, so a user with check-ins switched off pays nothing.
 */

/** A check-in write elsewhere: refresh almost immediately. */
const INTENT_PING_DELAY_MS = 150;

interface BuildCheckInContextValue {
  revision: number;
  prefsRevision: number;
  bump: () => void;
  subscribe: () => () => void;
}

const BuildCheckInContext = createContext<BuildCheckInContextValue | null>(null);

export function BuildCheckInProvider({ children }: { children: ReactNode }) {
  const [revision, setRevision] = useState(0);
  const [prefsRevision, setPrefsRevision] = useState(0);
  const [listeners, setListeners] = useState(0);
  const timerRef = useRef<number | null>(null);
  const dueAtRef = useRef(0);

  const bump = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setRevision((value) => value + 1);
  }, []);

  // A pending refresh that is already due sooner is kept, so a burst of
  // pings never postpones the first refresh.
  const schedule = useCallback(
    (delayMs: number) => {
      const dueAt = Date.now() + delayMs;
      if (timerRef.current != null && dueAtRef.current <= dueAt) return;
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      dueAtRef.current = dueAt;
      timerRef.current = window.setTimeout(bump, delayMs);
    },
    [bump],
  );

  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const live = listeners > 0;
  const handlers = useMemo(
    () =>
      live
        ? {
            "build-intent:changed": (payload: unknown) => {
              if (isPrefsPing(payload)) setPrefsRevision((value) => value + 1);
              schedule(INTENT_PING_DELAY_MS);
            },
            "games:changed": bump,
          }
        : null,
    [live, schedule, bump],
  );
  useUserSocket(handlers);

  const subscribe = useCallback(() => {
    setListeners((count) => count + 1);
    return () => setListeners((count) => Math.max(0, count - 1));
  }, []);

  const value = useMemo(
    () => ({ revision, prefsRevision, bump, subscribe }),
    [revision, prefsRevision, bump, subscribe],
  );
  return (
    <BuildCheckInContext.Provider value={value}>
      {children}
    </BuildCheckInContext.Provider>
  );
}

function isPrefsPing(payload: unknown): boolean {
  return (
    Boolean(payload) &&
    typeof payload === "object" &&
    (payload as { prefs?: unknown }).prefs === true
  );
}

const NOOP = () => {};

/** Keep the shared socket open while `active` and this component is mounted. */
export function useBuildCheckInLive(active: boolean): void {
  const subscribe = useContext(BuildCheckInContext)?.subscribe;
  useEffect(() => {
    if (!subscribe || !active) return undefined;
    return subscribe();
  }, [subscribe, active]);
}

/**
 * The current check-in revision. `live` (default true) keeps the shared
 * socket open while this consumer is mounted. `bump` refreshes every
 * consumer right away — call it after a local write. Outside a provider
 * the revision stays 0 and `bump` does nothing.
 */
export function useBuildCheckInRevision(live = true): {
  revision: number;
  bump: () => void;
} {
  const context = useContext(BuildCheckInContext);
  useBuildCheckInLive(live);
  return { revision: context?.revision ?? 0, bump: context?.bump ?? NOOP };
}

/**
 * Changes whenever the check-in switches change elsewhere (the desktop
 * app's Settings or its cards). Keeps the shared socket open while the
 * caller is mounted; 0 outside a provider.
 */
export function useBuildCheckInPrefsRevision(): number {
  const context = useContext(BuildCheckInContext);
  useBuildCheckInLive(true);
  return context?.prefsRevision ?? 0;
}
