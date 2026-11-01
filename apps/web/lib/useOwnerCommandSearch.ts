"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useOwnerRequestScope } from "./clientApi";
import {
  PRIVATE_COMMAND_SEARCH_DEBOUNCE_MS, PRIVATE_COMMAND_SEARCH_TIMEOUT_MS,
  PrivateCommandSearchError, type PrivateCommandChoice, type PrivateCommandTarget,
  type PrivateCommandSearchErrorCode,
} from "./privateCommandSearch";

/** One owner-scoped search source: the private POST, or recent games. A module
 * constant, so its identity never restarts a query. */
export type OwnerCommandSearchAdapter<D> = Readonly<{
  /** The literal query this source sends, or null when it cannot search it. */
  query: (raw: unknown) => string | null;
  request: (query: string, getToken: () => Promise<string | null>, signal: AbortSignal,
    assertCurrent: () => void) => Promise<D>;
  choices: (data: D) => readonly PrivateCommandChoice[];
  /** Fixed messages; no response, query or exception text. */
  slow: string;
  failed: string;
}>

export type PrivateCommandSearchOptions = Readonly<{
  open: boolean;
  scope: "all" | "guides";
  query: string;
  ownerKey: string | null;
  /** Stable only within one palette opening / one route entry respectively.
   * A→B→A must supply new objects, even when strings are equal again. */
  openingEpoch: object | null;
  routeEpoch: object | null;
}>;
export type PrivateCommandSelectionDraft = Readonly<{
  target: PrivateCommandTarget;
  href: string;
  isCurrent: () => boolean;
}>;
type Failure = Readonly<{ code: PrivateCommandSearchErrorCode; message: string }>;
type Attempt = { active: boolean; controller: AbortController; choices: readonly PrivateCommandChoice[] };
type Scope = {
  options: PrivateCommandSearchOptions; owner: string | null; query: string | null;
  active: boolean; attempt: Attempt | null;
};
type Snapshot<D> = {
  scope: Scope | null; attempt: Attempt | null; phase: "debouncing" | "loading" | "ready" | "error";
  data: D | null; error: Failure | null;
};
const EMPTY_CHOICES: readonly PrivateCommandChoice[] = Object.freeze([]);
const retired = () => new DOMException("Private search is no longer current.", "AbortError");
function failure(error: unknown, messages: Pick<OwnerCommandSearchAdapter<unknown>, "slow" | "failed">): Failure {
  const timeout = error && typeof error === "object" && "code" in error && error.code === "request_timeout";
  return Object.freeze({ code: timeout ? "request_timeout" : error instanceof PrivateCommandSearchError ? error.code : "unavailable",
    message: timeout ? messages.slow : messages.failed });
}

/** Ephemeral, intent-only owner search for one source. No SWR, previous answer,
 * storage or completed cache. This hook does not navigate or record private recents. */
export function useOwnerCommandSearch<D>(options: PrivateCommandSearchOptions, source: OwnerCommandSearchAdapter<D>) {
  const { userId, isLoaded, isSignedIn, getToken } = useAuth();
  const owner = isLoaded && isSignedIn && userId ? userId : null;
  const authEpoch = useMemo(() => ({ owner }), [owner]);
  const committedAuth = useRef<typeof authEpoch | null>(null);
  const committedToken = useRef<{ epoch: typeof authEpoch; getToken: typeof getToken } | null>(null);
  const [requestOwner, setRequestOwner] = useState(owner);
  const getCommittedToken = useCallback(async () => {
    const epoch = committedAuth.current, getter = committedToken.current;
    if (!epoch?.owner || getter?.epoch !== epoch) throw retired();
    const token = await getter.getToken();
    if (committedAuth.current !== epoch) throw retired();
    return token;
  }, []);
  // Feed the actual owner hook only a COMMITTED auth transition. Its inherited
  // render-time invalidation must not retire A because a B render suspends and
  // is abandoned. The token delegate likewise never publishes speculative JWT
  // callbacks. Committed changes still fence the epoch in the layout phase.
  const runOwned = useOwnerRequestScope(requestOwner, getCommittedToken);
  const latestRun = useRef<{ owner: string | null; run: typeof runOwned } | null>(null);
  useLayoutEffect(() => {
    committedAuth.current = authEpoch;
    return () => { if (committedAuth.current === authEpoch) committedAuth.current = null; };
  }, [authEpoch]);
  useLayoutEffect(() => {
    const getter = { epoch: authEpoch, getToken }; committedToken.current = getter;
    return () => { if (committedToken.current === getter) committedToken.current = null; };
  }, [authEpoch, getToken]);
  useLayoutEffect(() => { if (requestOwner !== owner) setRequestOwner(owner); }, [owner, requestOwner]);
  useLayoutEffect(() => {
    const runner = { owner: requestOwner, run: runOwned }; latestRun.current = runner;
    return () => { if (latestRun.current === runner) latestRun.current = null; };
  }, [requestOwner, runOwned]);
  const scopeRef = useRef<Scope | null>(null);
  const scope = useMemo<Scope>(() => {
    const query = source.query(options.query);
    return { options: { ...options }, owner, query, active: false, attempt: null };
    // Only values identifying a lifetime participate. A new options wrapper or
    // token function on an ordinary render must not restart the current query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, owner, options.open, options.scope, options.query, options.ownerKey, options.openingEpoch, options.routeEpoch]);
  const eligible = !!(scope.owner && scope.owner === options.ownerKey && options.open && options.scope === "all"
    && options.openingEpoch && options.routeEpoch && scope.query);
  const [retrySequence, setRetrySequence] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot<D>>({ scope: null, attempt: null, phase: "debouncing", data: null, error: null });
  const current = (attempt?: Attempt) => scopeRef.current === scope && scope.active
    && (!attempt || (scope.attempt === attempt && attempt.active && !attempt.controller.signal.aborted));

  useLayoutEffect(() => {
    scopeRef.current = scope;
    scope.active = eligible;
    return () => {
      scope.active = false; scope.attempt?.controller.abort();
      if (scopeRef.current === scope) scopeRef.current = null;
    };
  }, [scope, eligible]);

  useEffect(() => {
    if (!eligible || !scope.owner || !scope.query || requestOwner !== scope.owner) {
      setSnapshot({ scope, attempt: null, phase: "debouncing", data: null, error: null });
      return;
    }
    const attempt: Attempt = { active: true, controller: new AbortController(), choices: EMPTY_CHOICES };
    scope.attempt = attempt;
    const assertCurrent = () => { if (!current(attempt)) throw retired(); };
    setSnapshot({ scope, attempt, phase: "debouncing", data: null, error: null });
    const timer = setTimeout(() => {
      if (!current(attempt)) return;
      const runner = latestRun.current;
      if (!runner || runner.owner !== scope.owner) return;
      setSnapshot({ scope, attempt, phase: "loading", data: null, error: null });
      void runner.run(scope.owner!, (scopedToken, signal, assertOwner) =>
        source.request(scope.query!, scopedToken, signal, () => { assertOwner(); assertCurrent(); }),
      PRIVATE_COMMAND_SEARCH_TIMEOUT_MS, attempt.controller.signal).then(data => {
        if (!current(attempt)) return;
        attempt.choices = source.choices(data);
        setSnapshot({ scope, attempt, phase: "ready", data, error: null });
      }, error => {
        if (!current(attempt)) return;
        setSnapshot({ scope, attempt, phase: "error", data: null, error: failure(error, source) });
      });
    }, PRIVATE_COMMAND_SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(timer); attempt.active = false; attempt.controller.abort(); };
    // current and latestRun are deliberately read through the captured scope /
    // current ref. Their render identities must not restart the debounce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, eligible, requestOwner, retrySequence]);

  const ownsSnapshot = eligible && current() && snapshot.scope === scope
    && snapshot.attempt !== null && current(snapshot.attempt);
  const ready = ownsSnapshot && snapshot.phase === "ready";
  return {
    phase: !eligible ? "idle" as const : ownsSnapshot ? snapshot.phase : "debouncing" as const,
    data: ready ? snapshot.data : null,
    choices: ready ? snapshot.attempt!.choices : EMPTY_CHOICES,
    error: ownsSnapshot && snapshot.phase === "error" ? snapshot.error : null,
    retry: () => {
      if (!eligible || !current()) return;
      if (scope.attempt) { scope.attempt.active = false; scope.attempt.controller.abort(); }
      setSnapshot({ scope, attempt: null, phase: "debouncing", data: null, error: null });
      setRetrySequence(sequence => sequence + 1);
    },
    /** A draft expires even on intentional Modal close/unmount. Integration must
     * validate and transfer it into a provider-owned guarded handoff BEFORE
     * closing; this leaf cannot authorize navigation after it is retired. */
    selectionDraft: (choice: PrivateCommandChoice): PrivateCommandSelectionDraft | null => {
      const attempt = snapshot.attempt;
      if (!ready || !attempt || !current(attempt) || !attempt.choices.includes(choice)) return null;
      return Object.freeze({ target: choice.target, href: choice.href, isCurrent: () => current(attempt) });
    },
  };
}
