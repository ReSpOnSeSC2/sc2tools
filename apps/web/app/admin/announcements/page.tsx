"use client";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { RequestError } from "@/components/ui/RequestError";
import { Banner, type SiteNotice } from "@/components/ui/Banner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

type Draft = { severity: SiteNotice["severity"]; audience: SiteNotice["audience"]; message: string; href: string; startsAt: string; endsAt: string };
const localTime = (value: string) => { const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const fresh = (): Draft => ({ severity: "info", audience: "all", message: "", href: "", startsAt: localTime(new Date().toISOString()), endsAt: localTime(new Date(Date.now() + 2 * 3600000).toISOString()) });
const TEMPLATES = [
  { title: "Upload outage", message: "Uploads are delayed. Keep your replay files and try again after the service recovers.", severity: "warning", audience: "all", href: "/help/desktop-app-overview" },
  { title: "Maintenance", message: "SC2 Tools is undergoing maintenance. Some pages may be temporarily unavailable. Your saved data is safe.", severity: "info", audience: "all", href: "/changelog" },
  { title: "Required agent update", message: "A desktop app update is required to keep syncing. Open the desktop app or download the latest version.", severity: "warning", audience: "agent", href: "/download" },
] as const;

export default function AnnouncementsPage() {
  const { getToken } = useAuth(); const query = useApi<{ banner: SiteNotice | null }>("/v1/admin/announcements");
  const [draft, setDraft] = useState<Draft>(fresh); const [revision, setRevision] = useState(0); const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<ClientApiError | null>(null); const [saved, setSaved] = useState(false); const [ending, setEnding] = useState(false);
  const lastEnd = useRef(false);
  useEffect(() => { if (dirty || !query.data) return; const banner = query.data.banner; setRevision(banner?.revision || 0); if (banner) setDraft({ ...banner, href: banner.href || "", startsAt: localTime(banner.startsAt), endsAt: localTime(banner.endsAt) }); }, [query.data, dirty]);
  function change(patch: Partial<Draft>) { setDraft((current) => ({ ...current, ...patch })); setDirty(true); setSaved(false); }
  async function save(end = false) {
    if (busy) return; lastEnd.current = end; setBusy(true); setError(null); setSaved(false);
    try {
      const body = end ? { expectedRevision: revision } : { ...draft, startsAt: new Date(draft.startsAt).toISOString(), endsAt: new Date(draft.endsAt).toISOString(), expectedRevision: revision };
      const response = await apiCall<{ banner: SiteNotice }>(getToken, "/v1/admin/announcements", { method: end ? "DELETE" : "PUT", body: JSON.stringify(body) });
      setDirty(false); setRevision(response.banner.revision); await query.mutate(response, { revalidate: false }); setSaved(true); setEnding(false);
    } catch (cause) { setError(cause as ClientApiError); }
    finally { setBusy(false); }
  }
  const validDates = Number.isFinite(Date.parse(draft.startsAt)) && Number.isFinite(Date.parse(draft.endsAt)) && Date.parse(draft.endsAt) > Date.parse(draft.startsAt);
  const preview: SiteNotice = { ...draft, href: draft.href.startsWith("/") && !draft.href.startsWith("//") && !/[\u0000-\u0020\u007f\\]/.test(draft.href) ? draft.href : null, hash: "preview", revision };
  return <div className="space-y-5"><PageHeader title="Announcements" description="Post a time-limited incident notice. The preview uses your draft; saving publishes it to the selected audience." />
    <details className="rounded-lg border border-border p-3 text-caption text-text-muted"><summary className="cursor-pointer font-semibold text-text">How to post a notice</summary><p className="mt-2">Describe the impact and what users should do. Set an end time and choose the narrowest audience. Critical notices cannot be dismissed. Check the preview, then save. See docs/runbooks/admin-operations.md → Posting an incident notice.</p></details>
    {query.error ? <RequestError error={query.error} onRetry={() => query.mutate()} /> : !query.data ? <Skeleton rows={4} /> : <Card>
      {error ? <RequestError error={error} onRetry={error.status === 409 ? () => { setError(null); setDirty(false); void query.mutate(); } : () => save(lastEnd.current)} /> : null}
      <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="space-y-4"><fieldset disabled={busy} className="space-y-4">
        <div className="flex flex-wrap gap-2" aria-label="Notice templates">{TEMPLATES.map(({ title, ...template }) => <Button key={title} variant="secondary" size="sm" onClick={() => change({ ...fresh(), ...template })}>{title}</Button>)}</div>
        <label className="block text-caption">Message<textarea value={draft.message} onChange={(event) => change({ message: event.target.value })} maxLength={240} required rows={3} className="mt-1 w-full rounded border border-border bg-bg-surface p-2 text-body text-text" /><span className="text-micro text-text-dim">{draft.message.length}/240</span></label>
        <div className="grid gap-4 sm:grid-cols-2"><label className="block text-caption">Severity<select value={draft.severity} onChange={(event) => change({ severity: event.target.value as Draft["severity"] })} className="ml-2 rounded border border-border bg-bg-surface p-2">{["info", "warning", "critical"].map((severity) => <option key={severity}>{severity}</option>)}</select></label><label className="block text-caption">Audience<select value={draft.audience} onChange={(event) => change({ audience: event.target.value as Draft["audience"] })} className="ml-2 rounded border border-border bg-bg-surface p-2">{["all", "website", "agent", "stream-studio", "guides"].map((audience) => <option key={audience}>{audience}</option>)}</select></label>
        <label className="block text-caption">Starts at<input type="datetime-local" required value={draft.startsAt} onChange={(event) => change({ startsAt: event.target.value })} className="mt-1 w-full rounded border border-border bg-bg-surface p-2" /></label><label className="block text-caption">Ends at (required)<input type="datetime-local" required value={draft.endsAt} onChange={(event) => change({ endsAt: event.target.value })} className="mt-1 w-full rounded border border-border bg-bg-surface p-2" /></label></div>
        <label className="block text-caption">More information link (optional, same site)<input value={draft.href} onChange={(event) => change({ href: event.target.value })} maxLength={300} placeholder="/help/notifications" className="mt-1 w-full rounded border border-border bg-bg-surface p-2" /></label>
        <div className="space-y-2"><p className="text-caption font-semibold">Live preview</p><Banner notice={preview} onDismiss={() => {}} /></div>
        <div className="flex flex-wrap items-center gap-3"><Button type="submit" disabled={!dirty || !draft.message.trim() || !validDates}>{busy ? "Saving…" : "Save notice"}</Button><Button variant="secondary" disabled={!revision} onClick={() => setEnding(true)}>End current notice</Button>{saved ? <span role="status" className="text-caption text-success">Notice saved</span> : null}</div>
      </fieldset></form>
    </Card>}
    <ConfirmDialog open={ending} onClose={() => setEnding(false)} onConfirm={() => save(true)} title="End this notice?" description="The notice will stop appearing after connected clients refresh. Cached copies may remain for up to one minute." confirmLabel="End notice" loading={busy} />
  </div>;
}
