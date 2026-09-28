"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import {
  SettingsShell,
  defaultTabVisibility,
  isSettingsTabId,
  type SettingsTabId,
} from "@/components/analyzer/settings/SettingsShell";
import { SettingsFoundation } from "@/components/analyzer/settings/SettingsFoundation";
import { SettingsProfile } from "@/components/analyzer/settings/SettingsProfile";
import { SettingsOverlay } from "@/components/analyzer/settings/SettingsOverlay";
import { SettingsRandomizer } from "@/components/analyzer/settings/SettingsRandomizer";
import { SettingsVoice } from "@/components/analyzer/settings/SettingsVoice";
import { SettingsImport } from "@/components/analyzer/settings/SettingsImport";
import { SettingsBackups } from "@/components/analyzer/settings/SettingsBackups";
import { SettingsMisc } from "@/components/analyzer/settings/SettingsMisc";
import { SettingsHelp } from "@/components/analyzer/settings/SettingsHelp";
import { Skeleton } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { useInstantImport } from "@/lib/instant/useInstantImport";

/**
 * /settings — tabbed account settings. `?tab=<id>` opens a tab directly
 * (e.g. `/settings?tab=import` from the dashboard's "Import in your
 * browser" links); unknown or hidden tabs fall back to Foundation. The
 * Import tab only exists while the Instant Analysis flag is on.
 */
export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Configuration"
        title="Settings"
        description="Account, overlay tokens, voice notifications, and personal preferences. Edits stay in draft until you save."
      />
      {/* useSearchParams needs a Suspense boundary for static rendering. */}
      <Suspense fallback={<Skeleton rows={6} />}>
        <SettingsTabs />
      </Suspense>
    </div>
  );
}

function renderTab(id: SettingsTabId, origin: string) {
  switch (id) {
    case "foundation":
      return <SettingsFoundation />;
    case "profile":
      return <SettingsProfile />;
    case "overlay":
      return <SettingsOverlay origin={origin} />;
    case "randomizer":
      return <SettingsRandomizer />;
    case "voice":
      return <SettingsVoice />;
    case "import":
      return <SettingsImport />;
    case "backups":
      return <SettingsBackups />;
    case "misc":
      return <SettingsMisc />;
    case "help":
      return <SettingsHelp />;
    default:
      return null;
  }
}

function SettingsTabs() {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const requested = useSearchParams()?.get("tab") ?? null;
  const instant = useInstantImport();
  const isTabVisible = (id: SettingsTabId): boolean =>
    id === "import" ? instant.enabled : defaultTabVisibility(id);
  // Wait for the admin check before deciding a deep link to the Import tab.
  if (requested === "import" && instant.loading) return <Skeleton rows={6} />;
  const initialTab =
    isSettingsTabId(requested) && isTabVisible(requested) ? requested : undefined;
  return (
    <SettingsShell
      initialTab={initialTab}
      isTabVisible={isTabVisible}
      renderTab={(id: SettingsTabId) => renderTab(id, origin)}
    />
  );
}
