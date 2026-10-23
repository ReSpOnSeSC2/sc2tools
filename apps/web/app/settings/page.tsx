"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import {
  SettingsShell,
  defaultTabVisibility,
  settingsTabFromParam,
  type SettingsTabId,
} from "@/components/analyzer/settings/SettingsShell";
import { SettingsFoundation } from "@/components/analyzer/settings/SettingsFoundation";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { Skeleton } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { useInstantImport } from "@/lib/instant/useInstantImport";

/*
 * Foundation is the default tab, so it ships with the page. Every other
 * tab is its own chunk, fetched the first time it opens (the overlay
 * editor, voice catalogue and import tools are most of Settings' code).
 * While one loads it shows the same skeleton as the page's Suspense
 * fallback.
 */
const SettingsProfile = dynamic(
  () => import("@/components/analyzer/settings/SettingsProfile").then((mod) => mod.SettingsProfile),
  { loading: () => <Skeleton rows={6} /> },
);
const SettingsOverlay = dynamic(
  () => import("@/components/analyzer/settings/SettingsOverlay").then((mod) => mod.SettingsOverlay),
  { loading: () => <Skeleton rows={6} /> },
);
const SettingsRandomizer = dynamic(
  () => import("@/components/analyzer/settings/SettingsRandomizer").then((mod) => mod.SettingsRandomizer),
  { loading: () => <Skeleton rows={6} /> },
);
const BuildCheckInSettings = dynamic(
  () => import("@/components/build-checkin/BuildCheckInSettings").then((mod) => mod.BuildCheckInSettings),
  { loading: () => <Skeleton rows={6} /> },
);
const SettingsVoice = dynamic(
  () => import("@/components/analyzer/settings/SettingsVoice").then((mod) => mod.SettingsVoice),
  { loading: () => <Skeleton rows={6} /> },
);
const SettingsImport = dynamic(
  () => import("@/components/analyzer/settings/SettingsImport").then((mod) => mod.SettingsImport),
  { loading: () => <Skeleton rows={6} /> },
);
const SettingsBackups = dynamic(
  () => import("@/components/analyzer/settings/SettingsBackups").then((mod) => mod.SettingsBackups),
  { loading: () => <Skeleton rows={6} /> },
);
const SettingsMisc = dynamic(
  () => import("@/components/analyzer/settings/SettingsMisc").then((mod) => mod.SettingsMisc),
  { loading: () => <Skeleton rows={6} /> },
);
const SettingsHelp = dynamic(
  () => import("@/components/analyzer/settings/SettingsHelp").then((mod) => mod.SettingsHelp),
  { loading: () => <Skeleton rows={6} /> },
);

/**
 * /settings — tabbed account settings. `?tab=<id>` opens a tab directly
 * (e.g. `/settings?tab=import` from the dashboard's "Import in your
 * browser" links), as does a registered alias (`?tab=streaming`);
 * unknown or hidden tabs fall back to Foundation. SettingsShell maps old
 * hash-only links (`#overlay` with no `?tab=`). The Import tab only
 * exists while the Instant Analysis flag is on.
 */
export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Configuration"
        title="Settings"
        description="Account, overlay tokens, voice notifications, and personal preferences. Edits stay in draft until you save."
        actions={
          // Lazy: HelpLink carries the help articles, which would otherwise
          // ride along with the Settings page's first load.
          <LazyHelpLink
            slug="settings-overview"
            className="inline-flex min-h-11 items-center text-caption font-semibold"
          >
            What each tab is for
          </LazyHelpLink>
        }
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
    case "checkin":
      return <BuildCheckInSettings />;
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
  const requested = settingsTabFromParam(useSearchParams()?.get("tab"));
  const instant = useInstantImport();
  const isTabVisible = (id: SettingsTabId): boolean =>
    id === "import" ? instant.enabled : defaultTabVisibility(id);
  // Wait for the admin check before deciding a deep link to the Import tab.
  if (requested === "import" && instant.loading) return <Skeleton rows={6} />;
  const initialTab = requested && isTabVisible(requested) ? requested : undefined;
  return (
    <SettingsShell
      initialTab={initialTab}
      isTabVisible={isTabVisible}
      renderTab={(id: SettingsTabId) => renderTab(id, origin)}
    />
  );
}
