"use client";
import dynamic from "next/dynamic";
import { Card } from "@/components/ui/Card";
import type { OpponentRetryPulseResp } from "./OpponentDiagnosticsPanel";
const Submission = dynamic(() => import("./OpponentIdentitySubmission").then(module => module.OpponentIdentitySubmission));
const Candidates = dynamic(() => import("./OpponentIdentityCandidates").then(module => module.OpponentIdentityCandidates));
const Diagnostics = dynamic(() => import("./OpponentDiagnosticsPanel").then(module => module.OpponentDiagnosticsPanel));

export function DossierIdentitySection({ pulseId, open, onOpenChange, diagnosticsOpen, submission, candidates, race, onChanged, onRetried }: {
  pulseId: string; open: boolean; onOpenChange: (open: boolean) => void; diagnosticsOpen: boolean; submission: boolean; candidates: boolean; race?: string;
  onChanged: () => void; onRetried: (response: OpponentRetryPulseResp) => Promise<void>;
}) {
  return <section id="dossier-identity" tabIndex={-1} className="scroll-mt-32 space-y-3"><h2 className="text-h3 font-semibold">Identity</h2><Card><details open={open} onToggle={event => onOpenChange(event.currentTarget.open)}><summary className="min-h-11 cursor-pointer rounded-lg py-2 text-body font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Identity &amp; data quality</summary>{open ? <div className="mt-4 space-y-5">
    {submission ? <Submission pulseId={pulseId} onChanged={onChanged} /> : null}
    <Candidates pulseId={pulseId} enabled={candidates} race={race} />
    {diagnosticsOpen ? <Diagnostics diagnosticsPath={`/v1/opponents/${encodeURIComponent(pulseId)}/diagnostics`} retryPath={`/v1/opponents/${encodeURIComponent(pulseId)}/retry-pulse`} onRetried={onRetried} /> : null}
  </div> : null}</details></Card></section>;
}
