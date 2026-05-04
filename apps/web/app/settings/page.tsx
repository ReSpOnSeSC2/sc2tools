"use client";

import { headers } from "next/headers";
import { SettingsShell, type SettingsTabId } from "@/components/analyzer/settings/SettingsShell";
import { SettingsFoundation } from "@/components/analyzer/settings/SettingsFoundation";
import { SettingsProfile } from "@/components/analyzer/settings/SettingsProfile";
import { SettingsFolders } from "@/components/analyzer/settings/SettingsFolders";
import { SettingsImportPanel } from "@/components/analyzer/settings/SettingsImportPanel";
import { SettingsBuilds } from "@/components/analyzer/settings/SettingsBuilds";
import { SettingsOverlay } from "@/components/analyzer/settings/SettingsOverlay";
import { SettingsVoice } from "@/components/analyzer/settings/SettingsVoice";
import { SettingsBackups } from "@/components/analyzer/settings/SettingsBackups";
import { SettingsMisc } from "@/components/analyzer/settings/SettingsMisc";

export default function SettingsPage() {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <SettingsShell
        renderTab={(id: SettingsTabId) => {
          switch (id) {
            case "foundation":
              return <SettingsFoundation />;
            case "profile":
              return <SettingsProfile />;
            case "folders":
              return <SettingsFolders />;
            case "import":
              return <SettingsImportPanel />;
            case "builds":
              return <SettingsBuilds />;
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
  );
}
