"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { loadBalanceEvidence, type BalanceEvidence } from "@/lib/balance/evidence";
import { readReplayVerdict, type ReplayVerdict } from "@/lib/balance/verdictShare";
import { BalanceVerdictCredit, ReplayVerdictCard } from "./ReplayVerdictCard";

type State =
  | { kind: "loading" | "invalid" | "unavailable" }
  | { kind: "ready"; summary: ReplayVerdict; evidence: BalanceEvidence };

export function SharedReplayVerdict() {
  const [state, setState] = useState<State>({ kind: "loading" });
  useEffect(() => {
    let controller: AbortController | undefined;
    function read() {
      controller?.abort();
      const summary = readReplayVerdict(window.location.hash);
      if (!summary) {
        setState({ kind: "invalid" });
        return;
      }
      const next = new AbortController();
      controller = next;
      setState({ kind: "loading" });
      loadBalanceEvidence({ season: summary.season, asOf: summary.asOf }, next.signal).then(evidence => {
        if (!next.signal.aborted) setState(evidence ? { kind: "ready", summary, evidence } : { kind: "unavailable" });
      }).catch(() => {
        if (!next.signal.aborted) setState({ kind: "unavailable" });
      });
    }
    read();
    window.addEventListener("hashchange", read);
    return () => {
      controller?.abort();
      window.removeEventListener("hashchange", read);
    };
  }, []);
  if (state.kind === "ready") return <ReplayVerdictCard summary={state.summary} evidence={state.evidence} shared />;
  if (state.kind === "loading") return <p role="status" className="text-body text-text-muted">Loading the shared snapshot…</p>;
  return (
    <div className="space-y-3 rounded-xl border border-line bg-bg-surface p-4">
      <p role="status" className="text-body text-text-muted">{state.kind === "invalid" ? "Open a verdict link shared by a player to see their result." : "The ladder snapshot pinned to this verdict is unavailable."}</p>
      <div className="flex flex-wrap gap-x-4">
        <Link href="/try#balance-court" className="inline-flex min-h-11 items-center text-accent underline underline-offset-4">Review your own loss</Link>
        <Link href="/balance" className="inline-flex min-h-11 items-center text-accent underline underline-offset-4">Browse ladder balance</Link>
      </div>
      <BalanceVerdictCredit />
    </div>
  );
}
