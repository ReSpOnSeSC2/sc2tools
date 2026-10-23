"use client";

import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, type ClientApiError } from "@/lib/clientApi";
import { toClientApiError } from "@/lib/requestErrors";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/Field";
import { useToastOptional } from "@/components/ui/Toast";
import { consequence, targetHref, TARGET_LABEL, type ReportGroup } from "./moderationGroups";

type Action = "dismiss" | "remove";
type Failure = { error: ClientApiError; action: Action; note: string };

function useResolution(group: ReportGroup, onResolved: () => unknown) {
  const { getToken } = useAuth();
  const toast = useToastOptional();
  const [busy, setBusy] = useState<Action | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  async function resolve(action: Action, note: string) {
    if (busy) return;
    setBusy(action);
    setFailure(null);
    try {
      await apiCall(getToken, `/v1/community/admin/reports/${encodeURIComponent(group.reports[0].id)}`, {
        method: "POST", body: JSON.stringify({ action, note }),
      });
      try { await onResolved(); } catch { /* The queue owns its refresh error state. */ }
    } catch (err) {
      const error = toClientApiError(err);
      if (error.status === 404 && error.code === "report_not_found") {
        toast?.toast.success("Already resolved");
        try { await onResolved(); } catch { /* The queue owns its refresh error state. */ }
      } else setFailure({ error, action, note });
    } finally { setBusy(null); }
  }
  return { busy, failure, setFailure, resolve };
}

export function ReportGroupCard({ group, onResolved }: { group: ReportGroup; onResolved: () => unknown }) {
  const report = group.reports[0];
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState(false);
  const { busy, failure, setFailure, resolve } = useResolution(group, onResolved);
  const href = report.target ? targetHref(report) : null;
  return (
    <Card>
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="break-words font-semibold">{report.target?.title ?? report.targetId}</h2>
          <span className="rounded-full bg-bg-elevated px-2 text-caption">{TARGET_LABEL[report.targetType]}</span>
        </div>
        <p className="text-caption text-text-muted">{group.reports.length} {group.reports.length === 1 ? "report" : "reports"} · {group.tally} · Oldest {new Date(group.oldest).toLocaleString()}</p>
        <p className="break-words text-body">{report.target?.snippet || "Target no longer exists"}</p>
        {href ? <Link href={href} target="_blank" rel="noreferrer" className="text-accent-cyan underline">Open in context<span className="sr-only"> (opens in new tab)</span></Link> : null}
        <details><summary>Individual reports</summary><ul className="space-y-2">{group.reports.map((r) => <li key={r.id} className="break-words text-caption">
          {r.reason}{r.note ? ` · ${r.note}` : ""} · <Link className="text-accent-cyan underline" href={`/admin/users/${encodeURIComponent(r.reporterUserId)}`}>{r.reporterUserId}</Link> · {new Date(r.createdAt).toLocaleString()}
        </li>)}</ul></details>
        <details><summary>Add note</summary><ResolutionNote value={note} onChange={setNote} /></details>
        {failure ? <div role="alert" className="space-y-2 rounded-lg border border-danger p-3">
          <p>Couldn&apos;t {failure.action}: {failure.error.message}{failure.error.requestId ? ` · Error ID ${failure.error.requestId}` : ""}</p>
          <Button variant="secondary" size="sm" onClick={() => void resolve(failure.action, failure.note)}>Retry</Button>
          <Button variant="ghost" size="sm" onClick={() => setFailure(null)}>Dismiss error</Button>
        </div> : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" loading={busy === "dismiss"} disabled={busy !== null} onClick={() => void resolve("dismiss", note)}>{report.target?.hidden ? "Dismiss & restore" : "Dismiss"}</Button>
          <Button variant="danger" loading={busy === "remove"} disabled={busy !== null} onClick={() => setConfirm(true)}>Remove target</Button>
        </div>
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => { setConfirm(false); void resolve("remove", note); }} intent="danger"
        title={`Remove this ${report.targetType === "review_comment" ? "comment" : report.targetType === "review_request" ? "review" : report.targetType}?`} confirmLabel="Remove" description={consequence(report)}>
        <p className="mb-2 font-semibold">{report.target?.title ?? report.targetId}</p><p className="mb-3 break-words">{report.target?.snippet}</p>
        <ResolutionNote value={note} onChange={setNote} />
      </ConfirmDialog>
    </Card>
  );
}

function ResolutionNote({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <Field label="Resolution note (optional)" hint={`${value.length}/500 characters`}>
    <textarea value={value} maxLength={500} onChange={(e) => onChange(e.target.value)} className="min-h-24 rounded-lg border-2 border-line bg-bg-surface p-2 text-text" />
  </Field>;
}
