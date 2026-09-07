"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Fingerprint, ShieldCheck } from "lucide-react";
import { apiCall, useApi } from "@/lib/clientApi";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/Field";
import { IdentityPlayerLabel, PlayerIdentityPicker, type IdentityPlayer } from "./PlayerIdentityPicker";

export type IdentityProposal = {
  id: string;
  source: IdentityPlayer;
  target: IdentityPlayer | null;
  reason: string;
  status: "pending" | "approved" | "rejected" | "removed";
  createdAt: string;
  reviewNote?: string | null;
  submitterUserId?: string;
  evidenceCount?: number;
  revision: number;
};

type IdentityContext = {
  isAdmin: boolean;
  eligible: boolean;
  source: IdentityPlayer;
  confirmed: { groupKey: string; displayName: string; target: IdentityPlayer; revision: number } | null;
  submission: IdentityProposal | null;
  replayCount: number;
  revision?: number;
};

export const IDENTITY_REASON_MIN = 10;
export const IDENTITY_REASON_MAX = 2000;
export const IDENTITY_TEXTAREA_CLASS = "block w-full resize-y rounded-lg border-2 border-line bg-bg-surface px-3 py-2 text-body text-text placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-50";
export function identityError(error: unknown): string {
  return (error as { message?: string } | null)?.message || "Please try again.";
}

export function IdentityStatus({ status }: { status: IdentityProposal["status"] }) {
  return <Badge variant={status === "pending" ? "warning" : status === "approved" ? "success" : "neutral"} size="sm">{status === "pending" ? "Awaiting review" : status === "approved" ? "Approved" : status === "removed" ? "Identity removed" : "Not approved"}</Badge>;
}

export function OpponentIdentitySubmission(props: { pulseId: string; onChanged?: () => void }) {
  return <IdentitySubmissionBody key={props.pulseId} {...props} />;
}

function IdentitySubmissionBody({ pulseId, onChanged }: { pulseId: string; onChanged?: () => void }) {
  const { getToken } = useAuth();
  const path = `/v1/opponents/${encodeURIComponent(pulseId)}/identity-submissions`;
  const { data, error, isLoading, mutate } = useApi<IdentityContext>(path, { revalidateOnFocus: false });
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState<IdentityPlayer | null>(null);
  const [reason, setReason] = useState("");
  const [revision, setRevision] = useState(0);
  const [submissionRevision, setSubmissionRevision] = useState<number | undefined>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  const [unlinkReason, setUnlinkReason] = useState("");
  const capturedInitialRevision = useRef(false);
  useEffect(() => {
    if (!data || capturedInitialRevision.current) return;
    capturedInitialRevision.current = true;
    setRevision(data.revision ?? data.confirmed?.revision ?? 0);
  }, [data]);

  function beginEdit() {
    setTarget(data?.submission?.target || data?.confirmed?.target || null);
    setReason(data?.submission?.reason || "");
    setRevision(data?.revision ?? data?.confirmed?.revision ?? 0);
    setSubmissionRevision(data?.submission?.revision);
    setSaveError(null); setNotice(null); setEditing(true);
  }

  async function save() {
    if (saving || !data || !target) return;
    const trimmed = reason.trim();
    if (trimmed.length < IDENTITY_REASON_MIN) { setSaveError("Explain the match in at least 10 characters."); return; }
    setSaving(true); setSaveError(null); setNotice(null);
    try {
      if (data.isAdmin) {
        const response = await apiCall<IdentityContext>(getToken, `/v1/opponents/${encodeURIComponent(pulseId)}/confirmed-identity`, {
          method: "PUT", body: JSON.stringify({ targetKey: target.key, reason: trimmed, revision: editing ? revision : data.revision ?? data.confirmed?.revision ?? 0 }),
        });
        await mutate(response, { revalidate: false });
        onChanged?.();
        setNotice("Identity confirmed for everyone.");
      } else {
        const response = await apiCall<IdentityContext>(getToken, path, { method: "POST", body: JSON.stringify({ targetKey: target.key, reason: trimmed, ...(submissionRevision !== undefined ? { submissionRevision } : {}) }) });
        await mutate(response, { revalidate: false });
        setNotice("Identity submitted for admin review. Your replay history is available to the reviewer.");
      }
      setEditing(false); setTarget(null); setReason("");
    } catch (err) { setSaveError(identityError(err)); }
    finally { setSaving(false); }
  }

  async function unlink() {
    if (saving || unlinkReason.trim().length < IDENTITY_REASON_MIN) return;
    setSaving(true); setSaveError(null);
    try {
      const response = await apiCall<IdentityContext>(getToken, `/v1/opponents/${encodeURIComponent(pulseId)}/confirmed-identity`, {
        method: "DELETE", body: JSON.stringify({ reason: unlinkReason.trim(), revision }),
      });
      await mutate(response, { revalidate: false });
      setRevision(response.revision ?? 0);
      setUnlinking(false); setEditing(false); setTarget(null); setReason("");
      setNotice("Confirmed identity removed for everyone."); onChanged?.();
    } catch (err) { setSaveError(identityError(err)); }
    finally { setSaving(false); }
  }

  if (isLoading) return <div role="status" aria-label="Loading player identity"><Skeleton rows={2} /></div>;
  if (error) return <Card><p role="alert" className="text-body text-danger">Couldn&apos;t load identity submissions. {error.message}</p><Button className="mt-3" variant="secondary" onClick={() => void mutate()}>Retry identity lookup</Button></Card>;
  if (!data || (!data.eligible && !data.confirmed && !data.submission)) return null;
  const canEdit = data.eligible;
  const showForm = canEdit && (editing || (!data.confirmed && !data.submission));

  return <Card>
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-h3 font-bold"><Fingerprint className="h-5 w-5 shrink-0 text-accent" aria-hidden />Player identity</h2>
          <p className="mt-1 text-body text-text-muted">{data.isAdmin ? "Identify this barcode by selecting a player and explaining the match. Your confirmation updates the shared identity immediately." : "Know who plays on this barcode? Select their known account and explain the match. An administrator checks the evidence before it becomes a shared identity."}</p>
        </div>
        {data.isAdmin ? <Badge size="sm" iconLeft={<ShieldCheck className="h-3.5 w-3.5" />}>Admin controls</Badge> : null}
      </div>
      {data.confirmed ? <div className="rounded-lg border border-success/30 bg-success/5 p-3">
        <p className="mb-2 text-caption font-semibold text-success">Confirmed identity · visible to everyone</p>
        <IdentityPlayerLabel player={{ ...data.confirmed.target, displayName: data.confirmed.displayName || data.confirmed.target.displayName }} />
      </div> : null}
      {data.submission ? <div className="space-y-2 rounded-lg border border-border bg-bg-elevated/30 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-caption font-semibold">Your submission</p><IdentityStatus status={data.submission.status} /></div>
        {data.submission.target ? <IdentityPlayerLabel player={data.submission.target} /> : null}
        <p className="whitespace-pre-wrap break-words text-caption text-text-muted">{data.submission.reason}</p>
        {data.submission.reviewNote ? <p className="border-t border-border pt-2 text-caption text-text-muted"><strong className="text-text">Review note: </strong>{data.submission.reviewNote}</p> : null}
      </div> : null}
      {showForm ? <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <PlayerIdentityPicker value={target} onChange={setTarget} disabled={saving} excludeKey={data.source.key} />
        <Field label="Why is this the same player?" hint={`At least ${IDENTITY_REASON_MIN} characters. Reference replay details, a stream, or other evidence that can be checked.`}>
          <textarea className={IDENTITY_TEXTAREA_CLASS} rows={4} maxLength={IDENTITY_REASON_MAX} value={reason} disabled={saving} onChange={(event) => { setReason(event.target.value); setSaveError(null); }} />
        </Field>
        <p className="text-caption text-text-dim">{data.replayCount.toLocaleString()} replay{data.replayCount === 1 ? "" : "s"} in your history available for review · {reason.length}/{IDENTITY_REASON_MAX} characters</p>
        {data.isAdmin ? <p className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-caption text-text-muted">Confirming applies this identity for all users immediately. Check the selected account and evidence before saving.</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!target || reason.trim().length < IDENTITY_REASON_MIN} loading={saving}>{data.isAdmin ? "Confirm identity" : data.submission ? "Update submission" : "Submit for review"}</Button>
          {editing ? <Button variant="ghost" disabled={saving} onClick={() => { setEditing(false); setTarget(null); setReason(""); setSaveError(null); }}>Cancel</Button> : null}
        </div>
      </form> : canEdit ? <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={saving} onClick={beginEdit}>{data.isAdmin ? data.confirmed ? "Change confirmed identity" : "Confirm an identity" : data.submission ? "Update submission" : "Suggest another identity"}</Button>
        {data.isAdmin && data.confirmed ? <Button variant="ghost" disabled={saving} className="text-danger" onClick={() => { setRevision(data.revision ?? data.confirmed!.revision); setUnlinkReason(""); setSaveError(null); setUnlinking(true); }}>Remove confirmed identity</Button> : null}
      </div> : null}
      {saveError && !unlinking ? <p role="alert" className="text-body text-danger">{saveError}</p> : null}
      {notice ? <p role="status" className="text-body text-success">{notice}</p> : null}
    </div>
    <Modal open={unlinking} onClose={() => { if (!saving) setUnlinking(false); }} title="Remove this confirmed identity?" description="This unlinks the barcode from the known player for all users. The original replay records remain available." size="sm" footer={<><Button variant="secondary" disabled={saving} onClick={() => setUnlinking(false)}>Cancel</Button><Button variant="danger" loading={saving} disabled={unlinkReason.trim().length < IDENTITY_REASON_MIN} onClick={() => void unlink()}>Remove identity</Button></>}>
      <Field label="Reason for removing the identity" hint="Explain the correction in at least 10 characters."><textarea className={IDENTITY_TEXTAREA_CLASS} rows={3} maxLength={IDENTITY_REASON_MAX} value={unlinkReason} disabled={saving} onChange={(event) => setUnlinkReason(event.target.value)} /></Field>
      {unlinkReason.trim().length < IDENTITY_REASON_MIN ? <p className="mt-2 text-caption text-text-muted">Add a reason before removing this identity.</p> : null}
      {saveError ? <p role="alert" className="mt-3 text-body text-danger">{saveError}</p> : null}
    </Modal>
  </Card>;
}
