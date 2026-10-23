"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { RefreshCw, WifiOff } from "lucide-react";
import {
  SWRConfig,
  unstable_serialize,
  useSWRConfig,
  type Middleware,
  type SWRConfiguration,
} from "swr";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { API_BASE } from "@/lib/clientApi";
import { isConnectivityError } from "@/lib/requestErrors";
import { isTokenAuthRoute } from "@/lib/tokenAuthRoutes";

/* ------------------------------------------------------------------
 * Connection status for the signed-in app.
 *
 * ConnectionStatusProvider wraps the app chrome in one SWRConfig:
 *   - keepPreviousData: a filter change keeps the last answer on screen
 *     while the new one loads (useApi limits this to the same account
 *     and resource, see lib/clientApi.ts).
 *   - a middleware that watches every SWR request and counts
 *     consecutive "can't reach the server" failures. Any answer from
 *     the server, even an error like 404, ends the streak.
 *
 * ConnectionBanner reads that state and shows "Reconnecting to SC2
 * Tools… your data is safe" when the browser is offline, or after
 * FAILURE_THRESHOLD connection failures in a row. A dropped connection
 * or a server restart can interrupt requests. While it shows,
 * it pings the API's no-database /v1/ping every PING_INTERVAL_MS; the
 * first answer hides the banner and retries every request that failed.
 * Never shown on the OBS overlay or dock pages.
 * ------------------------------------------------------------------ */

/** Consecutive connection failures before the banner appears. */
export const FAILURE_THRESHOLD = 3;

/** How often the banner checks whether the API is back. */
export const PING_INTERVAL_MS = 10_000;

type ConnectionState = {
  /** The browser is offline, or the API stopped answering. */
  reconnecting: boolean;
  offline: boolean;
  /** Record that the API answered; ends a failure streak. */
  markReachable: () => void;
};

const ConnectionContext = createContext<ConnectionState>({
  reconnecting: false,
  offline: false,
  markReachable: () => {},
});

export function useConnectionStatus(): ConnectionState {
  return useContext(ConnectionContext);
}

function subscribeOnline(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

function useBrowserOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    // The server can't know; assume online so markup matches on hydrate.
    () => true,
  );
}

export function ConnectionStatusProvider({ children }: { children: ReactNode }) {
  const online = useBrowserOnline();
  const failures = useRef(0);
  const [unreachable, setUnreachable] = useState(false);

  const markReachable = useCallback(() => {
    failures.current = 0;
    setUnreachable(false);
  }, []);

  const report = useCallback((error: unknown | null) => {
    if (error === null || !isConnectivityError(error)) {
      // The server answered (with data or a real error): it is up.
      failures.current = 0;
      setUnreachable(false);
      return;
    }
    failures.current += 1;
    if (failures.current >= FAILURE_THRESHOLD) setUnreachable(true);
  }, []);

  const swrConfig = useMemo<SWRConfiguration>(() => {
    // SWR middleware: every hook's fetcher reports how its request ended.
    const watchRequests: Middleware = (useSWRNext) =>
      function useWatchedRequest(key, fetcher, config) {
        // Same-origin proxies can return cached fallback data while the
        // API is down. Their response does not prove API connectivity.
        const observesApi = !(typeof key === "string" && key.startsWith("/api/"));
        const watched = fetcher && observesApi
          ? async (...args: unknown[]) => {
              try {
                const data = await fetcher(...args);
                report(null);
                return data;
              } catch (error) {
                report(error);
                throw error;
              }
            }
          : fetcher;
        return useSWRNext(key, watched, config);
      };
    return { keepPreviousData: true, use: [watchRequests] };
  }, [report]);

  const value = useMemo<ConnectionState>(
    () => ({ reconnecting: !online || unreachable, offline: !online, markReachable }),
    [online, unreachable, markReachable],
  );

  return (
    <ConnectionContext.Provider value={value}>
      <SWRConfig value={swrConfig}>{children}</SWRConfig>
    </ConnectionContext.Provider>
  );
}

/**
 * The strip under the app header while SC2 Tools is unreachable. Polite
 * live region: screen readers hear it once, without interrupting.
 */
export function ConnectionBanner() {
  const pathname = usePathname();
  const { reconnecting, offline, markReachable } = useConnectionStatus();
  const { cache, mutate } = useSWRConfig();
  const hidden = isTokenAuthRoute(pathname);

  // While the API is unreachable (but the browser is online), ping it.
  // The first answer ends the outage and retries every request that
  // failed, so sections recover without waiting for SWR's backoff.
  useEffect(() => {
    if (hidden || !reconnecting || offline) return;
    let stopped = false;
    const ping = async () => {
      try {
        const res = await fetch(`${API_BASE}/v1/ping`, { cache: "no-store" });
        if (stopped || !res.ok) return;
        markReachable();
        const failed = new Set<string>();
        for (const key of cache.keys()) {
          if (cache.get(key)?.error !== undefined) failed.add(key);
        }
        if (failed.size > 0) void mutate((key) => failed.has(unstable_serialize(key)));
      } catch {
        // Still unreachable; the next ping tries again.
      }
    };
    const timer = setInterval(() => void ping(), PING_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [hidden, reconnecting, offline, markReachable, cache, mutate]);

  if (hidden) return null;
  return (
    <div role="status" aria-live="polite" data-testid="connection-banner">
      {reconnecting ? (
        <div className="border-t border-warning/40 bg-warning/10">
          <div className="mx-auto flex w-full max-w-[1680px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-caption text-text sm:px-6 lg:px-8">
            {offline ? (
              <WifiOff className="h-4 w-4 shrink-0 text-warning" aria-hidden />
            ) : (
              <RefreshCw className="h-4 w-4 shrink-0 text-warning motion-safe:animate-spin" aria-hidden />
            )}
            <span className="min-w-0 flex-1 font-semibold">
              Reconnecting to SC2 Tools… your data is safe.
            </span>
            <LazyHelpLink slug="something-went-wrong" className="text-caption">
              Why?
            </LazyHelpLink>
          </div>
        </div>
      ) : null}
    </div>
  );
}
