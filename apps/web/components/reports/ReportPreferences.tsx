"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { browserTimeZone } from "@/lib/reports";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { RequestError } from "@/components/ui/RequestError";
import { Section } from "@/components/ui/Section";
import { Toggle } from "@/components/ui/Toggle";
import { useDirtyForm } from "@/components/ui/useDirtyForm";
import { useSaveSource } from "@/components/analyzer/settings/SettingsContext";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";

type ReportPrefs = { weekly: boolean; stream: boolean; timezone: string | null };
const DEFAULTS: ReportPrefs = { weekly: true, stream: true, timezone: null };

/** Settings > Preferences > Reports: the weekly and stream report switches. */
export function ReportPreferences() {
  const { userId } = useAuth();
  return userId ? <ReportPreferencesForm key={userId} /> : null;
}

function ReportPreferencesForm() {
  const { getToken } = useAuth();
  const query = useApi<ReportPrefs>("/v1/me/preferences/reports");
  const form = useDirtyForm(query.data, DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ClientApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const deviceZone = browserTimeZone();
  useSaveSource("preferences", { label: "report settings", dirty: form.dirty, save, reset: () => { form.reset(); setError(null); }, order: 3 }, "reports");
  const update = (patch: Partial<ReportPrefs>) => { form.setDraft((draft) => ({ ...draft, ...patch })); setSaved(false); };
  async function save(): Promise<boolean> {
    if (!form.dirty) return true;
    if (saving) return false; setSaving(true); setError(null); setSaved(false);
    try {
      const result = await apiCall<ReportPrefs>(getToken, "/v1/me/preferences/reports", { method: "PUT", body: JSON.stringify(form.draft) });
      await query.mutate(result, { revalidate: false }); form.markSaved(); setSaved(true);
      return true;
    } catch (cause) { setError(cause as ClientApiError); return false; }
    finally { setSaving(false); }
  }
  const zone = form.draft.timezone;
  return <Section id="reports" className="scroll-mt-28" title="Reports" description="A short summary of your week every Monday morning, and one after each stream you end in the Dock. Both arrive in your notifications.">
    {query.error && !query.data ? <RequestError error={query.error} onRetry={() => query.mutate()} /> : !query.data ? <Skeleton rows={3} /> : <Card>
      {error ? <RequestError error={error} /> : null}
      <div className="divide-y divide-border">
        <PrefRow id="report-weekly" title="Weekly report" description="Monday around 09:00: games, record by matchup, MMR, best map and build, compared with the week before. Weeks with fewer than five games are skipped.">
          <Toggle id="report-weekly" checked={form.draft.weekly} onChange={(weekly) => update({ weekly })} disabled={saving} aria-labelledby="report-weekly-title" />
        </PrefRow>
        <PrefRow id="report-stream" title="Stream reports" description="When you press End stream in the Dock, or after four hours without a game: record, MMR, maps, builds and Crystal Ball accuracy.">
          <Toggle id="report-stream" checked={form.draft.stream} onChange={(stream) => update({ stream })} disabled={saving} aria-labelledby="report-stream-title" />
        </PrefRow>
        <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-body font-semibold text-text">Report time zone</p>
            <p className="text-caption text-text-muted">{zone ? <>Weeks run Monday to Sunday in <strong>{zone.replaceAll("_", " ")}</strong>.</> : <>Not set yet, so weeks follow UTC.</>}</p>
          </div>
          {zone !== deviceZone ? <Button variant="secondary" size="sm" className="min-h-11 flex-shrink-0" disabled={saving} onClick={() => update({ timezone: deviceZone })}>Use this device&apos;s time zone ({deviceZone.replaceAll("_", " ")})</Button> : null}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {saved ? <span role="status" className="text-caption text-success">Report settings saved</span> : null}
        <Link href="/app/reports/weekly/latest" className="inline-flex min-h-11 items-center text-caption font-semibold text-accent-cyan underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Last week&apos;s report</Link>
        <Link href="/app/streams" className="inline-flex min-h-11 items-center text-caption font-semibold text-accent-cyan underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Stream reports</Link>
        <LazyHelpLink slug="weekly-report" className="inline-flex min-h-11 items-center text-caption font-semibold">How reports work</LazyHelpLink>
      </div>
    </Card>}
  </Section>;
}

function PrefRow({ id, title, description, children }: { id: string; title: string; description: string; children: React.ReactNode }) {
  return <div className="flex items-start justify-between gap-4 py-3">
    <div className="min-w-0"><p id={`${id}-title`} className="text-body font-semibold text-text">{title}</p><p className="text-caption text-text-muted">{description}</p></div>
    <div className="pt-1">{children}</div>
  </div>;
}
