"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { SettingsShell } from "@/components/analyzer/settings/SettingsShell";
import { defaultTabVisibility, settingsTabFromParam, type SettingsTabId } from "@/lib/settingsRegistry";
import { SettingsFoundation } from "@/components/analyzer/settings/SettingsFoundation";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { Skeleton } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";

/*
 * Account is the default tab, so it ships with the page. Every other
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
const SettingsStreamingTokenOwner = dynamic(
  () => import("@/components/analyzer/settings/SettingsStreamingTokenOwner").then(mod => mod.SettingsStreamingTokenOwner),
  { loading: () => <Skeleton rows={6} /> },
);
const SettingsChat = dynamic(
  () => import("@/components/analyzer/settings/SettingsChat").then(mod => mod.SettingsChat),
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
 * unknown or hidden tabs fall back to Account. SettingsShell maps old
 * hash-only links (`#overlay` with no `?tab=`). Import is available to every
 * signed-in user; its browser tools follow the Instant Analysis flag.
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
    case "account":
      return <SettingsFoundation />;
    case "profile":
      return <SettingsProfile />;
    case "overlay":
      return <SettingsOverlay origin={origin} />;
    case "chat":
      return <SettingsChat origin={origin} />;
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
    case "preferences":
      return <SettingsMisc />;
    case "help":
      return <SettingsHelp />;
    default:
      return null;
  }
}

function SettingsTabs() {
  const { userId, isLoaded, isSignedIn } = useAuth();
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const search = useSearchParams();
  const requested = settingsTabFromParam(search?.get("tab"));
  const isTabVisible = defaultTabVisibility;
  const initialTab = requested && isTabVisible(requested) ? requested : undefined;
  return (
    <SettingsShell
      initialTab={initialTab}
      isTabVisible={isTabVisible}
      requestedSearch={search?.toString() ?? ""}
      ownerKey={isLoaded && isSignedIn ? userId : null}
      renderStreaming={(children, section) => <SettingsStreamingTokenOwner section={section}>{children}</SettingsStreamingTokenOwner>}
      renderTab={(id: SettingsTabId) => renderTab(id, origin)}
    />
  );
}
