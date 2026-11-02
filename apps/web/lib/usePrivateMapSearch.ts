"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { unstable_serialize, useSWRConfig } from "swr";
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
// The palette's own cache identity for the same GET /v1/maps; the hash is never sent.
const PALETTE_CATALOG_PATH = `${PRIVATE_MAP_CATALOG_PATH}#command-search`;

/**
 * Personal maps for the palette. The first valid private query of an opening,
 * after the debounce, reuses the list Arcade already loaded, or reads the
 * owner's GET /v1/maps once into the palette's own in-memory entry; typing
 * afterwards only filters in the browser.
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
  // Its own entry means closing the palette mid-read never cancels a read Arcade joined, and a palette
  // opened during Arcade's read keeps its own deadline. Its aborted read pauses SWR, so the entry stays clean.
  const { cache } = useSWRConfig();
  const loaded: unknown = armed && owner
    ? cache.get(unstable_serialize(["authenticated-api", owner, PRIVATE_MAP_CATALOG_PATH]))?.data : undefined;
  const retired = useRef(false);
  useLayoutEffect(() => { retired.current = false; return () => { retired.current = true; }; }, []);
  const config = useMemo(() => ({ ...CATALOG_READ, isPaused: () => retired.current }), []);
  const catalog = useApi<unknown>(armed && loaded === undefined ? PALETTE_CATALOG_PATH : null, config,
    { timeoutMs: PRIVATE_MAP_SEARCH_TIMEOUT_MS });
  const data = loaded ?? catalog.data;
  const decoded = useMemo(() => data === undefined ? null : decodePrivateMapCatalog(data), [data]);
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
    /** Reads the list again after a failure or a list the browser could not admit; never while a read is in flight. */
    retry: () => {
      if (!catalog.isValidating && (phase === "error" || (phase === "ready" && group?.status === "unavailable"))) void catalog.mutate();
    },
    selectionDraft: (choice: PrivateCommandChoice): PrivateCommandSelectionDraft | null => {
      if (phase !== "ready" || !snapshot.active || !snapshot.choices.includes(choice)) return null;
      return Object.freeze({ target: choice.target, href: choice.href, isCurrent: () => snapshot.active });
    },
  };
}
