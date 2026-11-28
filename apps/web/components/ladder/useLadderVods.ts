"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadLadderVods, type LadderFilters, type LadderVod } from "@/lib/ladder/vods";

export type MoreState = "idle" | "loading" | "error";
export type Ready = { kind: "ready"; results: LadderVod[]; next: string | null; more: MoreState; now: number };
export type LadderState =
  | { kind: "loading" }
  /** The server's gate: the finder is not open yet. */
  | { kind: "closed" }
  | { kind: "error" }
  | Ready;

/** The search being shown; `run` changes when the same filters are searched again. */
export type Applied = { filters: LadderFilters; run: number };

/** Loads the first page of the applied search, and further pages on request. A newer search cancels an older one. */
export function useLadderVods(applied: Applied) {
  const [state, setState] = useState<LadderState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(state);
  latest.current = state;
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    const request = new AbortController();
    pending.current = request;
    setState({ kind: "loading" });
    loadLadderVods(applied.filters, null, request.signal).then(
      answer => {
        if (request.signal.aborted) return;
        setState(answer.available
          ? { kind: "ready", results: answer.results, next: answer.next, more: "idle", now: Date.now() }
          : { kind: "closed" });
      },
      () => { if (!request.signal.aborted) setState({ kind: "error" }); },
    );
    return () => request.abort();
  }, [applied, attempt]);

  const retry = useCallback(() => setAttempt(previous => previous + 1), []);

  /** Appends the next page; resolves true while more pages remain. */
  const loadMore = useCallback(async (): Promise<boolean> => {
    const current = latest.current;
    const request = pending.current;
    if (current.kind !== "ready" || !current.next || current.more === "loading" || !request) return true;
    const patch = (change: Partial<Ready>) =>
      setState(previous => (previous.kind === "ready" ? { ...previous, ...change } : previous));
    patch({ more: "loading" });
    try {
      const answer = await loadLadderVods(applied.filters, current.next, request.signal);
      if (request.signal.aborted || !answer.available) return true;
      const known = new Set(current.results.map(vod => vod.id));
      patch({
        results: [...current.results, ...answer.results.filter(vod => !known.has(vod.id))],
        next: answer.next,
        more: "idle",
        now: Date.now(),
      });
      return answer.next !== null;
    } catch {
      if (!request.signal.aborted) patch({ more: "error" });
      return true;
    }
  }, [applied.filters]);

  return { state, retry, loadMore };
}
