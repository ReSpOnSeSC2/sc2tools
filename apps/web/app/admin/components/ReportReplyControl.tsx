"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, type ClientApiError } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";
import { RequestError } from "@/components/ui/RequestError";
import { REPORT_STATUS_LABELS, type MyReport } from "@/components/notifications/MyReports";

type ReportState = { status: MyReport["status"]; revision: number; updates?: Array<{ id: string; reply: string; createdAt: string }> };
export function ReportReplyControl({ eventId, report, linkedUser, onReload }: { eventId: string; report?: ReportState; linkedUser: boolean; onReload?: () => unknown }) {
  const { getToken } = useAuth();
  const [current, setCurrent] = useState<ReportState>(report || { status: "new", revision: 0 });
  const [status, setStatus] = useState(current.status);
  const [reply, setReply] = useState("");
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ClientApiError | null>(null);
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  useEffect(() => { if (report && report.revision > current.revision) { setCurrent(report); setStatus(report.status); } }, [report, current.revision]);
  async function save() {
    if (saving) return;
    const text = reply.trim(); const fingerprint = JSON.stringify([status, text, current.revision]);
    if (!request.current || request.current.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
    setSaving(true); setError(null);
    try {
      const result = await apiCall<MyReport>(getToken, `/v1/admin/messages/${encodeURIComponent(eventId)}`, { method: "PATCH", body: JSON.stringify({ status, ...(text ? { reply: text } : {}), expectedRevision: current.revision, requestId: request.current.id }) });
      setCurrent({ status: result.status, revision: result.revision, updates: result.replies.map((item) => ({ id: item.id, reply: item.message, createdAt: item.createdAt })) }); setReply(""); setOpen(false); request.current = null; void onReload?.();
    } catch (cause) { setError(cause as ClientApiError); }
    finally { setSaving(false); }
  }
  return <div className="mt-3 space-y-2">
    <div className="flex flex-wrap items-center gap-2"><span className="text-caption text-accent-cyan">Status: {REPORT_STATUS_LABELS[current.status]}</span><Button size="sm" variant="secondary" onClick={() => setOpen((value) => !value)}>{open ? "Close reply" : "Status / Reply"}</Button></div>
    {open ? <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="space-y-3 rounded-lg border border-border p-3">
      {error ? <RequestError error={error} onRetry={error.status === 409 ? onReload : save} /> : null}
      {current.updates?.some((item) => item.reply) ? <ol className="space-y-2">{current.updates.filter((item) => item.reply).map((item) => <li key={item.id} className="rounded border border-border p-2"><time className="text-micro text-text-dim" dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time><p className="whitespace-pre-wrap break-words text-caption text-text-muted">{item.reply}</p></li>)}</ol> : null}
      <fieldset disabled={saving} className="space-y-3"><label className="block text-caption">Report status<select className="ml-2 rounded border border-border bg-bg-surface px-2 py-1 text-text" value={status} onChange={(event) => setStatus(event.target.value as MyReport["status"])}>{Object.entries(REPORT_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {linkedUser ? <label className="block text-caption">Reply to the user<textarea value={reply} onChange={(event) => setReply(event.target.value)} maxLength={2000} rows={3} className="mt-1 w-full rounded border border-border bg-bg-surface p-2 text-body text-text" /></label> : <p className="text-caption text-text-muted">This email report has no linked account. In-app replies are unavailable.</p>}
        <p className="text-micro text-text-muted">Replies appear in the user's My reports section and notification inbox.</p>
        <Button type="submit" disabled={saving || (status === current.status && !reply.trim())}>{saving ? "Saving…" : reply.trim() ? "Save and send reply" : "Save status"}</Button>
      </fieldset>
    </form> : null}
  </div>;
}
