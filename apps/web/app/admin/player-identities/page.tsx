"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { ArrowRight, ExternalLink, Fingerprint, RefreshCw } from "lucide-react";
import { apiCall, useApi } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { IdentityPlayerLabel, PlayerIdentityPicker, type IdentityPlayer } from "@/components/analyzer/PlayerIdentityPicker";
import { IDENTITY_REASON_MAX, IDENTITY_REASON_MIN, IDENTITY_TEXTAREA_CLASS, IdentityStatus, identityError, type IdentityProposal } from "@/components/analyzer/OpponentIdentitySubmission";
import { ForbiddenCard } from "../components/AdminFragments";

type ReviewList = { items: IdentityProposal[]; nextCursor: string | null };
type EvidenceGame = { gameId: string; date: string | null; map: string | null; result: string | null; durationSec: number | null; opponentName: string | null; hasReplay: boolean };
type ReviewDetail = { submission: IdentityProposal; evidence: EvidenceGame[]; nextCursor: string | null };

function formatDate(date: string | null) {
  const value = date ? new Date(date) : null;
  return value && !Number.isNaN(value.getTime()) ? value.toLocaleString() : "Date unavailable";
}

export default function AdminPlayerIdentitiesPage() {
  const [status, setStatus] = useState<IdentityProposal["status"]>("pending");
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const cursor = cursors[cursors.length - 1];
  const path = `/v1/admin/player-identities?status=${status}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const { data, error, isLoading, mutate } = useApi<ReviewList>(path, { keepPreviousData: false });
  const close = useCallback(() => setSelected(null), []);
  if (error?.status === 403) return <ForbiddenCard />;

  return <div className="space-y-6">
    <header className="space-y-2"><h1 className="text-3xl font-bold">Player identities</h1><p className="max-w-3xl text-body text-text-muted">Review community submissions that identify barcode accounts. Check the suggested player and the submitter&apos;s replays before confirming a shared identity.</p></header>
    <Card><div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <Field label="Submission status" className="sm:min-w-60"><Select value={status} onChange={(event) => { setStatus(event.target.value as IdentityProposal["status"]); setCursors([null]); }}><option value="pending">Awaiting review</option><option value="approved">Approved</option><option value="rejected">Not approved</option><option value="removed">Identity removed</option></Select></Field>
      <Button variant="secondary" iconLeft={<RefreshCw className="h-4 w-4" aria-hidden />} onClick={() => void mutate()}>Refresh submissions</Button>
    </div></Card>
    {notice ? <p role="status" className="rounded-lg border border-success/30 bg-success/5 p-3 text-body text-success">{notice}</p> : null}
    {error ? <Card><p role="alert" className="text-body text-danger">Couldn&apos;t load submissions. {error.message}</p><Button variant="secondary" className="mt-3" onClick={() => void mutate()}>Retry submissions</Button></Card>
      : isLoading ? <div role="status" aria-label="Loading identity submissions"><Skeleton rows={4} /></div>
      : !data?.items.length ? <Card><div className="space-y-2 py-8 text-center"><Fingerprint className="mx-auto h-8 w-8 text-accent" aria-hidden /><h2 className="text-h3 font-semibold">{status === "pending" ? "No identities awaiting review" : "No submissions in this view"}</h2><p className="text-body text-text-muted">{status === "pending" ? "New barcode identity submissions will appear here." : "Choose another submission status to continue."}</p></div></Card>
      : <ul className="space-y-4" aria-label="Identity submissions">{data.items.map((submission) => <li key={submission.id}><Card>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center"><IdentityPlayerLabel player={submission.source} /><ArrowRight className="hidden h-4 w-4 shrink-0 text-text-dim sm:block" aria-hidden /><div className="min-w-0"><p className="mb-1 text-micro text-text-dim">{submission.target ? "Suggested identity" : "Confirmed identity removed"}</p>{submission.target ? <IdentityPlayerLabel player={submission.target} /> : null}</div></div>
            <p className="line-clamp-3 whitespace-pre-wrap break-words text-body text-text-muted">{submission.reason}</p>
            <p className="text-caption text-text-dim">Submitted {formatDate(submission.createdAt)} · {(submission.evidenceCount ?? 0).toLocaleString()} replay{(submission.evidenceCount ?? 0) === 1 ? "" : "s"}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 lg:flex-col lg:items-end"><IdentityStatus status={submission.status} /><Button variant={submission.status === "pending" ? "primary" : "secondary"} onClick={() => setSelected(submission.id)} aria-label={`${submission.status === "pending" ? "Review" : "View"} submission for ${submission.source.displayName}`}>{submission.status === "pending" ? "Review evidence" : "View review"}</Button></div>
        </div>
      </Card></li>)}</ul>}
    {!error && !isLoading && (cursors.length > 1 || data?.nextCursor) ? <nav aria-label="Identity submission pages" className="flex items-center justify-between gap-3"><Button variant="secondary" size="sm" disabled={cursors.length <= 1} onClick={() => setCursors((current) => current.slice(0, -1))}>Previous</Button><p className="text-caption text-text-dim">Page {cursors.length}</p><Button variant="secondary" size="sm" disabled={!data?.nextCursor} onClick={() => { if (data?.nextCursor) setCursors((current) => [...current, data.nextCursor]); }}>Next</Button></nav> : null}
    {selected ? <IdentityReviewDialog key={selected} id={selected} onClose={close} onReviewed={async (submission) => { close(); setNotice(submission.status === "approved" ? "Identity approved and shared with everyone." : "Submission reviewed. The suggested identity was not published."); await mutate(); }} /> : null}
  </div>;
}

function IdentityReviewDialog({ id, onClose, onReviewed }: { id: string; onClose: () => void; onReviewed: (submission: IdentityProposal) => Promise<void> }) {
  const { getToken } = useAuth();
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const cursor = cursors[cursors.length - 1];
  const base = `/v1/admin/player-identities/${encodeURIComponent(id)}`;
  const { data, error, isLoading, mutate } = useApi<ReviewDetail>(`${base}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { revalidateOnFocus: false });
  const [target, setTarget] = useState<IdentityPlayer | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const initial = useRef<IdentityProposal | null>(null);
  useEffect(() => {
    if (initial.current || !data?.submission) return;
    initial.current = data.submission;
    setTarget(data.submission.target);
    setReviewNote(data.submission.reviewNote || "");
  }, [data]);
  const submission = initial.current || data?.submission;
  const dirty = Boolean(submission && (target?.key !== submission.target?.key || reviewNote !== (submission.reviewNote || "") || decision !== "approved"));
  const close = useCallback(() => { if (busy) return; if (dirty) setDiscarding(true); else onClose(); }, [busy, dirty, onClose]);
  const canReview = submission?.status === "pending";
  const noteValid = reviewNote.trim().length <= IDENTITY_REASON_MAX && (decision === "approved" || reviewNote.trim().length >= IDENTITY_REASON_MIN);

  async function review() {
    if (busy || !submission || !canReview || !noteValid || (decision === "approved" && !target)) return;
    setBusy(true); setSaveError(null);
    try {
      const response = await apiCall<{ submission: IdentityProposal }>(getToken, `${base}/review`, { method: "POST", body: JSON.stringify({ decision, ...(decision === "approved" ? { targetKey: target!.key } : {}), reviewNote: reviewNote.trim() || "Identity confirmed by administrator.", revision: submission.revision }) });
      await onReviewed(response.submission);
    } catch (err) { setSaveError(identityError(err)); }
    finally { setBusy(false); }
  }

  return <Modal open onClose={close} title={discarding ? "Discard your review changes?" : "Review player identity"} description={discarding ? "Your changes have not been submitted." : "Compare the source account, suggested identity, and replay evidence."} size="xl" disableScrimClose footer={discarding ? <><Button variant="secondary" onClick={() => setDiscarding(false)}>Keep reviewing</Button><Button variant="danger" onClick={onClose}>Discard changes</Button></> : <><Button variant="secondary" onClick={close} disabled={busy}>{canReview ? "Cancel" : "Close"}</Button>{canReview ? <Button variant={decision === "rejected" ? "danger" : "primary"} loading={busy} disabled={!noteValid || !target} onClick={() => void review()}>{decision === "approved" ? "Approve identity" : "Reject submission"}</Button> : null}</>}>
    {discarding ? <p className="text-body text-text-muted">Keep reviewing to save your decision, or discard to leave this submission unchanged.</p>
      : error ? <div><p role="alert" className="text-body text-danger">Couldn&apos;t load the submission evidence. {error.message}</p><Button className="mt-3" variant="secondary" onClick={() => void mutate()}>Retry evidence</Button></div>
      : isLoading ? <div role="status" aria-label="Loading replay evidence"><Skeleton rows={3} /></div>
      : submission ? <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2"><IdentityStatus status={submission.status} /><p className="text-caption text-text-dim">Submitted {formatDate(submission.createdAt)}</p></div>
        <div className="rounded-lg border border-border bg-bg-elevated/30 p-3"><p className="mb-2 text-caption font-semibold">Source account</p><IdentityPlayerLabel player={submission.source} /></div>
        <div><h3 className="text-caption font-semibold">Submitter&apos;s evidence</h3><p className="mt-2 whitespace-pre-wrap break-words text-body text-text-muted">{submission.reason}</p></div>
        {canReview ? <PlayerIdentityPicker value={target} onChange={setTarget} disabled={busy} excludeKey={submission.source.key} label="Confirm as this player" /> : submission.target ? <div><p className="mb-2 text-caption font-semibold">Suggested identity</p><IdentityPlayerLabel player={submission.target} /></div> : null}
        <section aria-label="Replay evidence" className="space-y-3 border-y border-border py-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-h4 font-semibold">Replay evidence</h3>{submission.submitterUserId ? <Link href={`/admin/users/${encodeURIComponent(submission.submitterUserId)}/opponents/${encodeURIComponent(submission.source.pulseId)}`} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1.5 text-caption font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Inspect full replay history<ExternalLink className="h-3.5 w-3.5" aria-hidden /></Link> : null}</div>
          {!data?.evidence.length ? <p className="text-body text-text-muted">No replay evidence is available on this page.</p> : <ul className="divide-y divide-border rounded-lg border border-border">{data.evidence.map((game) => <li key={game.gameId} className="space-y-1 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold text-text">{game.map || "Map unavailable"}</p><p className="text-caption text-text-muted">{formatDate(game.date)}</p></div><p className="text-caption text-text-muted">{game.opponentName || submission.source.displayName} · {game.result || "Result unavailable"}{typeof game.durationSec === "number" ? ` · ${Math.floor(game.durationSec / 60)}:${String(Math.floor(game.durationSec % 60)).padStart(2, "0")}` : ""}</p><p className="text-micro text-text-dim">{game.hasReplay ? "Replay file available" : "Replay file unavailable"}</p></li>)}</ul>}
          {cursors.length > 1 || data?.nextCursor ? <nav aria-label="Replay evidence pages" className="flex items-center justify-between gap-3"><Button variant="ghost" size="sm" disabled={busy || cursors.length <= 1} onClick={() => setCursors((current) => current.slice(0, -1))}>Previous evidence</Button><p className="text-micro text-text-dim">Page {cursors.length}</p><Button variant="ghost" size="sm" disabled={busy || !data?.nextCursor} onClick={() => { if (data?.nextCursor) setCursors((current) => [...current, data.nextCursor]); }}>Next evidence</Button></nav> : null}
        </section>
        {canReview ? <fieldset disabled={busy} className="min-w-0 space-y-4"><Field label="Review decision"><Select value={decision} onChange={(event) => { setDecision(event.target.value as "approved" | "rejected"); setSaveError(null); }}><option value="approved">Approve shared identity</option><option value="rejected">Reject submission</option></Select></Field><Field label="Review note" hint={decision === "approved" ? "Optional context for the submitter and future reviewers." : "Explain the decision in at least 10 characters so the submitter can improve their evidence."}><textarea className={IDENTITY_TEXTAREA_CLASS} rows={3} maxLength={IDENTITY_REASON_MAX} value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} /></Field><p className="text-caption text-text-muted">{decision === "approved" ? "Approval applies the selected identity for every user." : "Rejection leaves the shared player identity unchanged."}</p></fieldset> : submission.reviewNote ? <p className="whitespace-pre-wrap break-words text-body text-text-muted"><strong className="text-text">Review note: </strong>{submission.reviewNote}</p> : null}
        {saveError ? <p role="alert" className="text-body text-danger">{saveError}</p> : null}
      </div> : null}
  </Modal>;
}
