"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";
import { API_BASE } from "@/lib/clientApi";
import { createRealtimeClient, INITIAL_REALTIME, type RealtimeClient, type RealtimeHandlers } from "@/lib/realtime/client";

const RealtimeContext = createContext<{ client: RealtimeClient | null } | null>(null);
const emptySubscribe = () => () => {};

function useAuthClient(enabled = true) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const tokenRef = useRef(getToken); tokenRef.current = getToken;
  return useMemo(() => enabled && isLoaded && isSignedIn && userId
    ? createRealtimeClient(API_BASE, () => tokenRef.current()) : null, [enabled, isLoaded, isSignedIn, userId]);
}

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const client = useAuthClient();
  const value = useMemo(() => ({ client }), [client]);
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

function useClient() {
  const shared = useContext(RealtimeContext);
  // Standalone hooks retain their original local-socket fallback. Under the
  // provider no extra client is allocated or opened.
  const fallback = useAuthClient(shared === null);
  return shared ? shared.client : fallback;
}

function useSubscription(client: RealtimeClient | null, handlers: RealtimeHandlers | null, immediateGames: boolean): void {
  const activeClient = useRef(client); activeClient.current = client;
  const latest = useRef(handlers); latest.current = handlers;
  const names = handlers ? Object.keys(handlers).sort().join("\0") : null;
  useEffect(() => {
    if (!client || names === null) return;
    return client.subscribe(() => activeClient.current === client ? latest.current || {} : {}, immediateGames);
  }, [client, names, immediateGames]);
}

export function useRealtimeEvents(handlers: RealtimeHandlers | null, immediateGames = false): void {
  useSubscription(useClient(), handlers, immediateGames);
}

export function useRealtimeState(handlers: RealtimeHandlers | null = null, immediateGames = false) {
  const client = useClient();
  useSubscription(client, handlers, immediateGames);
  return useSyncExternalStore(client?.observe ?? emptySubscribe, client?.snapshot ?? (() => INITIAL_REALTIME), () => INITIAL_REALTIME);
}

export function useRealtimeStatus() {
  return useRealtimeState();
}
