"use client";

import { useId, useRef, useState } from "react";
import { SignedIn, SignedOut, useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { AlertOctagon, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { apiCall } from "@/lib/clientApi";
import { signInHref } from "@/lib/authLinks";

const REASONS = ["Spam or advertising", "Offensive or abusive", "Broken or wrong steps", "Copied without credit"];

/** Reporting stays reachable on phones, independently from the desktop vote card. */
export function CommunityBuildReport({ slug }: { slug: string }) {
  const { getToken } = useAuth();
  const noteId = useId();
  const [reportOpen, setReportOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [reportPending, setReportPending] = useState(false);
  const reporting = useRef(false);
  const [status, setStatus] = useState<string | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  async function submitReport() {
    if (!reason || reporting.current) return;
    reporting.current = true; setReportPending(true); setStatus(null); setReportError(null);
    try {
      const answer = await apiCall<{ alreadyReported: boolean }>(getToken, "/v1/community/reports", {
        method: "POST", body: JSON.stringify({ targetType: "build", targetId: slug, reason, note: note.slice(0, 280) }),
      });
      setStatus(answer.alreadyReported ? "You've already reported this build — thanks." : "Thanks — a moderator will review this build.");
      setReportOpen(false); setReason(""); setNote("");
    } catch { setReportError("Couldn't send your report. Try again."); }
    finally { reporting.current = false; setReportPending(false); }
  }
  return <div className="space-y-3">
    <p className="text-caption text-text-muted">Something wrong with this build? Report it.</p>
    <SignedIn>
      {reportOpen ? <div className="space-y-3 rounded-lg border border-warning/30 bg-warning/5 p-3">
        <fieldset disabled={reportPending} className="space-y-1"><legend className="mb-2 text-caption font-medium text-text">Why are you reporting this build?</legend>
          {REASONS.map((option) => <label key={option} className="flex min-h-11 items-center gap-2 text-caption text-text"><input type="radio" name={`build-report-${slug}`} value={option} checked={reason === option} onChange={() => setReason(option)} />{option}</label>)}
        </fieldset>
        <label className="block text-caption text-text">Add details (optional)<textarea value={note} onChange={(event) => setNote(event.target.value.slice(0, 280))} maxLength={280} rows={3} disabled={reportPending} aria-describedby={noteId} className="mt-1 block w-full rounded-lg border-2 border-line bg-bg-surface p-2 text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" /></label>
        <p id={noteId} aria-live="polite" className="text-right text-caption text-text-muted">{note.length}/280</p>
        <div className="flex flex-wrap justify-end gap-2"><Button variant="ghost" disabled={reportPending} onClick={() => { setReportOpen(false); setReason(""); setNote(""); }}>Cancel</Button><Button variant="danger" disabled={!reason || reportPending} loading={reportPending} onClick={() => void submitReport()}>Submit report</Button></div>
      </div> : <Button variant="ghost" fullWidth onClick={() => { setStatus(null); setReportError(null); setReportOpen(true); }} iconLeft={<AlertOctagon className="h-4 w-4" aria-hidden />}>Report</Button>}
    </SignedIn>
    <SignedOut><Link href={signInHref(`/community/builds/${encodeURIComponent(slug)}`)} className="inline-flex min-h-11 items-center text-caption font-semibold text-accent underline">Sign in to report</Link></SignedOut>
    {reportError ? <p role="alert" className="flex items-center gap-2 text-caption text-danger"><AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />{reportError}</p> : null}
    {status ? <p role="status" className="text-caption text-success">{status}</p> : null}
  </div>;
}