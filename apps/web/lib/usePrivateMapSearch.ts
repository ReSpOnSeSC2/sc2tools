"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useApi } from "./clientApi";
import {
  PRIVATE_COMMAND_SEARCH_DEBOUNCE_MS, privateCommandQuery, type PrivateCommandChoice, type PrivateSearchGroup,
  type PrivateSearchMap,
} from "./privateCommandSearch";
import {
  PRIVATE_MAP_CATALOG_PATH, PRIVATE_MAP_SEARCH_TIMEOUT_MS, decodePrivateMapCatalog, privateMapChoices, privateMapSearchGroup,
} from "./privateMapSearch";
import type { PrivateCommandSearchOptions, PrivateCommandSelectionDraft } from "./useOwnerCommandSearch";

export type PrivateMapSearchPhase = "idle" | "loading" | "ready" | "error";
const EMPTY_CHOICES: readonly PrivateCommandChoice[] = Object.freeze([]);
// Arcade's own read of the same list; no focus, reconnect or automatic retry.
const CATALOG_READ = { revalidateIfStale: false, revalidateOnFocus: false, revalidateOnReconnect: false,
  shouldRetryOnError: false, keepPreviousData: false } as const;

/**
 * Personal maps for the palette. The first valid private query of an opening,
 * after the debounce, reads the owner's GET /v1/maps once through the same
 * in-memory entry Arcade uses; typing afterwards only filters in the browser.
 * Signed out, the Guides scope and a closed palette never read it.
 */
export function usePrivateMapSearch(options: PrivateCommandSearchOptions) {
  const { userId, isLoaded, isSignedIn } = useAuth();
  const owner = isLoaded && isSignedIn && userId ? userId : null;
  const eligible = !!(owner && owner === options.ownerKey && options.open && options.scope === "all"
    && options.openingEpoch && options.routeEpoch);
  const query = privateCommandQuery(options.query);
  const [armedFor, setArmedFor] = useState<object | null>(null);
  useEffect(() => {
    if (!eligible || !query || armedFor === options.openingEpoch) return;
    const timer = setTimeout(() => setArmedFor(options.openingEpoch), PRIVATE_COMMAND_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [eligible, query, armedFor, options.openingEpoch]);
  const armed = eligible && armedFor !== null && armedFor === options.openingEpoch;
  // A palette closed mid-read must not write its abort into Arcade's shared entry.
  const retired = useRef(false);
  useLayoutEffect(() => { retired.current = false; return () => { retired.current = true; }; }, []);
  const config = useMemo(() => ({ ...CATALOG_READ, isPaused: () => retired.current }), []);
  const catalog = useApi<unknown>(armed ? PRIVATE_MAP_CATALOG_PATH : null, config, { timeoutMs: PRIVATE_MAP_SEARCH_TIMEOUT_MS });
  const decoded = useMemo(() => catalog.data === undefined ? null : decodePrivateMapCatalog(catalog.data), [catalog.data]);
  const group = useMemo<PrivateSearchGroup<PrivateSearchMap> | null>(
    () => decoded && query ? privateMapSearchGroup(decoded, query) : null, [decoded, query]);
  const choices = useMemo(() => group ? privateMapChoices(group) : EMPTY_CHOICES, [group]);
  const phase: PrivateMapSearchPhase = !eligible || !query ? "idle" : armed && group ? "ready"
    : armed && catalog.error && !catalog.isValidating ? "error" : "loading";
  // Drafts expire with the query, owner, opening, route and unmount.
  const snapshot = useMemo(() => ({ active: false, choices }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [choices, owner, options.openingEpoch, options.routeEpoch]);
  useLayoutEffect(() => { snapshot.active = true; return () => { snapshot.active = false; }; }, [snapshot]);
  return {
    phase,
    group: phase === "ready" ? group : null,
    partial: phase === "ready" && decoded?.status === "ready" && decoded.partial,
    choices: phase === "ready" ? choices : EMPTY_CHOICES,
    timedOut: phase === "error" && catalog.error?.code === "request_timeout",
    /** Reads the list again after a failure or a list the browser could not admit. */
    retry: () => { if (phase === "error" || (phase === "ready" && group?.status === "unavailable")) void catalog.mutate(); },
    selectionDraft: (choice: PrivateCommandChoice): PrivateCommandSelectionDraft | null => {
      if (phase !== "ready" || !snapshot.active || !snapshot.choices.includes(choice)) return null;
      return Object.freeze({ target: choice.target, href: choice.href, isCurrent: () => snapshot.active });
    },
  };
}
