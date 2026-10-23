"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { RequestError } from "@/components/ui/RequestError";
import { Section } from "@/components/ui/Section";
import { NOTIFICATION_KINDS } from "./notificationModel";
import { useDirtyForm } from "@/components/ui/useDirtyForm";
import { usePublishDirty } from "@/components/analyzer/settings/SettingsContext";

const DEFAULT_PREFS = { muted: [] as string[] };
export function NotificationPreferences() {
  const { userId } = useAuth();
  return userId ? <NotificationPreferencesForm key={userId} /> : null;
}

function NotificationPreferencesForm() {
  const { getToken } = useAuth();
  const query = useApi<{ muted: string[] }>("/v1/me/preferences/notifications");
  const form = useDirtyForm(query.data, DEFAULT_PREFS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ClientApiError | null>(null);
  const [saved, setSaved] = useState(false);
  usePublishDirty("misc", form.dirty);
  async function save() {
    if (saving) return; setSaving(true); setError(null); setSaved(false);
    try { const result = await apiCall<{ muted: string[] }>(getToken, "/v1/me/preferences/notifications", { method: "PUT", body: JSON.stringify(form.draft) }); await query.mutate(result, { revalidate: false }); form.markSaved(); setSaved(true); }
    catch (cause) { setError(cause as ClientApiError); }
    finally { setSaving(false); }
  }
  return <Section title="Notifications" description="Choose which in-app updates you receive. Muting affects future notifications; existing rows stay in your inbox for up to 90 days.">
    {query.error && !query.data ? <RequestError error={query.error} onRetry={() => query.mutate()} /> : !query.data ? <Skeleton rows={3} /> : <Card>
      {error ? <RequestError error={error} onRetry={save} /> : null}
      <fieldset disabled={saving} className="grid gap-3 sm:grid-cols-2">{NOTIFICATION_KINDS.map(([kind, label]) => <label key={kind} className="flex min-h-11 items-center gap-2 text-caption"><input type="checkbox" checked={!form.draft.muted.includes(kind)} onChange={(e) => { const enabled = e.target.checked; form.setDraft((draft) => ({ muted: enabled ? draft.muted.filter((item) => item !== kind) : [...draft.muted, kind] })); setSaved(false); }} />{label}</label>)}</fieldset>
      <div className="mt-4 flex flex-wrap items-center gap-3"><Button disabled={saving || !form.dirty} onClick={save}>{saving ? "Saving…" : "Save notification preferences"}</Button><Button variant="secondary" disabled={saving || !form.dirty} onClick={form.reset}>Reset</Button>{saved ? <span role="status" className="text-caption text-success">Notification preferences saved</span> : null}</div>
    </Card>}
  </Section>;
}
