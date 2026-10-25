"use client";
import { useEffect, useRef, useState } from "react";

export const dossierIsBusy = (error: unknown) => !!error && typeof error === "object" && (error as { status?: number }).status === 503 && (error as { code?: string }).code === "opponent_profile_busy";

/** A bounded retry schedule; ordinary failures keep their manual Retry action. */
export function useDossierBusyRetry(key: string, error: unknown, retry: () => Promise<unknown>) {
  const [attempt, setAttempt] = useState(0);
  const [inFlight, setInFlight] = useState(false);
  const generation = useRef({ id: 0 });
  useEffect(() => { const counter = generation.current; counter.id++; setAttempt(0); setInFlight(false); return () => { counter.id++; }; }, [key]);
  useEffect(() => { if (!error) setAttempt(0); }, [error]);
  useEffect(() => {
    if (!dossierIsBusy(error) || attempt >= 4 || inFlight) return;
    const scope = generation.current.id;
    const timer = window.setTimeout(() => {
      setAttempt(value => value + 1); setInFlight(true);
      void retry().catch(() => undefined).finally(() => { if (generation.current.id === scope) setInFlight(false); });
    }, 1000 * 2 ** attempt);
    return () => window.clearTimeout(timer);
  }, [key, error, retry, attempt, inFlight]);
  return dossierIsBusy(error) && attempt < 4;
}
