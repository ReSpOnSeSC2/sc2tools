"use client";

import {
  SettingsShell,
  type SettingsTabId,
} from "@/components/analyzer/settings/SettingsShell";
import { SettingsFoundation } from "@/components/analyzer/settings/SettingsFoundation";
import { SettingsProfile } from "@/components/analyzer/settings/SettingsProfile";
import { SettingsOverlay } from "@/components/analyzer/settings/SettingsOverlay";
import { SettingsVoice } from "@/components/analyzer/settings/SettingsVoice";
import { SettingsBackups } from "@/components/analyzer/settings/SettingsBackups";
import { SettingsMisc } from "@/components/analyzer/settings/SettingsMisc";
import { PageHeader } from "@/components/ui/PageHeader";
import { ToastProvider } from "@/components/ui/Toast";

export default function SettingsPage() {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return (
    <ToastProvider>
      <div className="space-y-6">
        <PageHeader
          eyebrow="Configuration"
          title="Settings"
          description="Account, overlay tokens, voice notifications, and personal preferences. Edits stay in draft until you save."
        />
        <SettingsShell
          renderTab={(id: SettingsTabId) => {
            switch (id) {
              case "foundation":
                return <SettingsFoundation />;
              case "profile":
                return <SettingsProfile />;
              case "overlay":
                return <SettingsOverlay origin={origin} />;
              case "voice":
                return <SettingsVoice />;
              case "backups":
                return <SettingsBackups />;
              case "misc":
                return <SettingsMisc />;
              default:
                return null;
            }
          }}
        />
      </div>
    </ToastProvider>
  );
}
