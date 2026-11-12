"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";
import { RequestError } from "@/components/ui/RequestError";
import { Section } from "@/components/ui/Section";
import { NOTIFICATION_KINDS, notificationFocus } from "./notificationModel";
import { useDirtyForm } from "@/components/ui/useDirtyForm";
import { useSaveSource } from "@/components/analyzer/settings/SettingsContext";

type NotificationPrefs = { muted: string[]; milestones?: boolean };
const DEFAULT_PREFS: NotificationPrefs = { muted: [], milestones: false };
export function NotificationPreferences() {
  const { userId } = useAuth();
  return userId ? <NotificationPreferencesForm key={userId} /> : null;
}

function NotificationPreferencesForm() {
  const { getToken } = useAuth();
  const query = useApi<NotificationPrefs>("/v1/me/preferences/notifications");
  const form = useDirtyForm(query.data, DEFAULT_PREFS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ClientApiError | null>(null);
  const [saved, setSaved] = useState(false);
  // Saved with the rest of Preferences through the tab's one SaveBar.
  useSaveSource("preferences", { label: "notifications", dirty: form.dirty, save, reset: () => { form.reset(); setError(null); }, order: 2 }, "notifications");
  async function save(): Promise<boolean> {
    if (!form.dirty) return true;
    if (saving) return false; setSaving(true); setError(null); setSaved(false);
    try { const result = await apiCall<NotificationPrefs>(getToken, "/v1/me/preferences/notifications", { method: "PUT", body: JSON.stringify(form.draft) }); await query.mutate(result, { revalidate: false }); form.markSaved(); setSaved(true); return true; }
    catch (cause) { setError(cause as ClientApiError); return false; }
    finally { setSaving(false); }
  }
  return <Section id="notifications" className="scroll-mt-28" title="Notifications" description="Choose which in-app updates you receive. Muting affects future notifications; existing rows stay in your inbox for up to 90 days.">
    {query.error && !query.data ? <RequestError error={query.error} onRetry={() => query.mutate()} /> : !query.data ? <Skeleton rows={3} /> : <Card>
      {error ? <RequestError error={error} /> : null}
      <fieldset disabled={saving} className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="flex min-h-11 items-center gap-2 text-caption">
            <input
              type="checkbox"
              className={notificationFocus}
              aria-describedby="notification-milestones-description"
              checked={form.draft.milestones === true}
              onChange={(event) => {
                const milestones = event.target.checked;
                form.setDraft((draft) => ({ ...draft, milestones }));
                setSaved(false);
              }}
            />
            Milestones
          </label>
          <p id="notification-milestones-description" className="text-caption text-text-muted">Get private bell notifications for ladder milestones from newly synced games.</p>
        </div>
        {NOTIFICATION_KINDS.map(([kind, label]) => <label key={kind} className="flex min-h-11 items-center gap-2 text-caption"><input type="checkbox" checked={!form.draft.muted.includes(kind)} onChange={(e) => { const enabled = e.target.checked; form.setDraft((draft) => ({ ...draft, muted: enabled ? draft.muted.filter((item) => item !== kind) : [...draft.muted, kind] })); setSaved(false); }} />{label}</label>)}
      </fieldset>
      {saved ? <p role="status" className="mt-4 text-caption text-success">Notification preferences saved</p> : null}
    </Card>}
  </Section>;
}
