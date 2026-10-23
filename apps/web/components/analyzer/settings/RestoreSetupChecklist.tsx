"use client";

import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { SettingsLoadError } from "./SettingsLoadError";

export function RestoreSetupChecklist() {
  const { getToken } = useAuth();
  const preferences = useApi<{ dismissedAt?: string | null }>("/v1/me/preferences/onboarding");
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  async function restore() {
    if (busy) return;
    setBusy(true);
    try {
      await apiCall(getToken, "/v1/me/preferences/onboarding", { method: "PUT", body: JSON.stringify({ dismissedAt: null }) });
      await preferences.mutate();
      toast.success("The setup checklist is back on your dashboard", { description: <Link href="/app" className="text-accent underline">Open your dashboard</Link> });
    } catch { toast.error("Couldn't restore the setup checklist", { description: "Your saved preferences haven't changed. Please try again." }); }
    finally { setBusy(false); }
  }
  return <div className="space-y-2 py-3">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-body font-medium">Setup checklist</h3><p className="text-caption text-text-muted">Bring back the dashboard's pairing and import steps.</p></div><Button variant="secondary" size="sm" loading={busy} disabled={!preferences.data || Boolean(preferences.error) || !preferences.data.dismissedAt || busy} onClick={() => { void restore(); }}>{preferences.data && !preferences.data.dismissedAt ? "It's already showing" : "Show the setup checklist again"}</Button></div>
    {preferences.error ? <SettingsLoadError tab="Setup checklist" error={preferences.error} retry={preferences.mutate} /> : null}
  </div>;
}
