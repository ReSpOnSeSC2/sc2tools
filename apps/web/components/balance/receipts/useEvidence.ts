import { useEffect, useState } from "react";
import { loadBalanceEvidence, type BalanceEvidence, type BalancePin } from "@/lib/balance/evidence";

type Result = { kind: "loading" } | { kind: "unavailable" } | { kind: "ready"; bundle: BalanceEvidence };

export function useEvidence(pin: BalancePin | undefined, enabled = true) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; attempt: number; value: Result }>();
  const season = pin?.season;
  const asOf = pin?.asOf;
  const key = season && asOf ? `${season}/${asOf}` : "latest";

  useEffect(() => {
    if (!enabled) return;
    const request = new AbortController();
    loadBalanceEvidence(season && asOf ? { season, asOf } : undefined, request.signal).then(
      bundle => { if (!request.signal.aborted) setResult({ key, attempt, value: { kind: "ready", bundle } }); },
      () => { if (!request.signal.aborted) setResult({ key, attempt, value: { kind: "unavailable" } }); },
    );
    return () => request.abort();
  }, [asOf, attempt, enabled, key, season]);

  const value: Result = result?.key === key && result.attempt === attempt ? result.value : { kind: "loading" };
  return { value, retry: () => setAttempt(previous => previous + 1) };
}
