"use client";

import { useEffect, useMemo, useState } from "react";
import type { CommandSearchItem } from "./commandSearch";
import {
  COMMUNITY_COMMAND_DEBOUNCE_MS, COMMUNITY_COMMAND_TIMEOUT_MS, communityCommandItems, communityCommandQuery,
  requestCommunityCommandSearch,
} from "./communityCommandSearch";

export type CommunityCommandSearchOptions = Readonly<{
  open: boolean;
  scope: "all" | "guides";
  query: string;
  /** False for a query the palette was opened with: only an explicit edit may send one. */
  typed: boolean;
  /** Authentication has loaded with no user. A null user while it loads is not signed out. */
  signedOut: boolean;
}>;
type Answer = Readonly<{
  attempt: object; phase: "loading" | "ready" | "error";
  items: readonly CommandSearchItem[]; hasMore: boolean;
}>;
const EMPTY: readonly CommandSearchItem[] = Object.freeze([]);

/**
 * Community builds for a signed-out viewer: after an explicit edit leaves 2-80
 * valid code points and 200 ms pass without another, one anonymous request with
 * a five-second deadline. A newer edit, close or sign-in aborts it, and a late
 * answer never publishes. Retry is explicit; nothing is cached or stored.
 */
export function useCommunityCommandSearch(options: CommunityCommandSearchOptions) {
  const query = communityCommandQuery(options.query);
  const eligible = options.open && options.scope === "all" && options.signedOut && options.typed && query !== null;
  const [retry, setRetry] = useState(0);
  const attempt = useMemo(() => ({}),
    // A new attempt for every query, eligibility change and Retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, eligible, retry]);
  const [answer, setAnswer] = useState<Answer | null>(null);
  useEffect(() => {
    if (!eligible || query === null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setAnswer({ attempt, phase: "loading", items: EMPTY, hasMore: false });
      const deadline = setTimeout(() => controller.abort(), COMMUNITY_COMMAND_TIMEOUT_MS);
      requestCommunityCommandSearch(query, controller.signal).then(data => {
        if (!controller.signal.aborted) setAnswer({ attempt, phase: "ready", items: communityCommandItems(data), hasMore: data.hasMore });
      }, () => {
        // An abort after the deadline is a failure; an abort from cleanup is not current any more.
        if (controller.signal.reason !== "retired") setAnswer({ attempt, phase: "error", items: EMPTY, hasMore: false });
      }).finally(() => clearTimeout(deadline));
    }, COMMUNITY_COMMAND_DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort("retired"); };
  }, [attempt, eligible, query]);
  const current = eligible && answer?.attempt === attempt ? answer : null;
  return {
    phase: !eligible ? "idle" as const : current ? current.phase : "debouncing" as const,
    items: current?.phase === "ready" ? current.items : EMPTY,
    hasMore: current?.phase === "ready" && current.hasMore,
    retry: () => { if (current?.phase === "error") setRetry(value => value + 1); },
  };
}
