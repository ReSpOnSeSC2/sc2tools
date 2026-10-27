"use client";

import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { useAuth } from "@clerk/nextjs";
import { useLocalStorageState } from "./useLocalStorageState";
import type { MatrixRace } from "./strategyMatrix";

const isMatrixRace = (raw: unknown): raw is MatrixRace => raw === "P" || raw === "T" || raw === "Z" || raw === "all";

/** Remember an explicit matrix choice for this owner, independently of the
 * shared analyzer cohort. No choice preserves the measured first-visit default. */
export function useStrategyMatrixRace() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const owner = isLoaded && isSignedIn && userId ? userId : null;
  const frame = useMemo(() => ({ owner }), [owner]);
  const current = useRef<typeof frame | null>(null);
  useLayoutEffect(() => {
    current.current = frame;
    return () => { if (current.current === frame) current.current = null; };
  }, [frame]);
  const [race, saveRace] = useLocalStorageState<MatrixRace | null>(
    `analyzer.strategies.matrixRace:${owner ? encodeURIComponent(owner) : "unavailable"}`, null, isMatrixRace,
  );
  const chooseRace = useCallback((next: MatrixRace) => {
    if (frame.owner && current.current === frame) saveRace(next);
  }, [frame, saveRace]);
  return [owner ? race : null, chooseRace] as const;
}
