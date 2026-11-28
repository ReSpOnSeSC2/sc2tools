"use client";

import { useCallback, useEffect, useState } from "react";
import { loadProBoard, type ProBoard } from "@/lib/ladder/proBoard";

export type ProBoardState =
  | { kind: "loading" }
  /** The server's gate: the board is not open yet. */
  | { kind: "closed" }
  | { kind: "error" }
  | { kind: "ready"; board: ProBoard; now: number };

/** The server refreshes every five minutes; asking more often only finds the same board. */
const POLL_MS = 2 * 60 * 1000;

/**
 * Loads the board, then quietly asks again every couple of minutes while the
 * tab is visible, so the ages stay true without the page flickering. A quiet
 * failure keeps the board on screen. `closed` starts the page in the closed
 * state (the server said so when it built the page), which asks for nothing.
 */
export function useProBoard(closed = false) {
  const [state, setState] = useState<ProBoardState>(closed ? { kind: "closed" } : { kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (closed) return undefined;
    const request = new AbortController();
    const load = (quiet: boolean) => {
      if (!quiet) setState({ kind: "loading" });
      loadProBoard(request.signal).then(
        answer => {
          if (request.signal.aborted) return;
          setState(answer.available ? { kind: "ready", board: answer, now: Date.now() } : { kind: "closed" });
        },
        () => { if (!request.signal.aborted && !quiet) setState({ kind: "error" }); },
      );
    };
    load(false);
    const timer = setInterval(() => { if (document.visibilityState === "visible") load(true); }, POLL_MS);
    return () => { clearInterval(timer); request.abort(); };
  }, [attempt, closed]);

  const retry = useCallback(() => setAttempt(previous => previous + 1), []);
  return { state, retry };
}
