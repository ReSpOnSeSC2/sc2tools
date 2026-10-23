"use client";

/**
 * Settings · Import — browser import without the desktop agent (shown only
 * while the Instant Analysis rollout flag is on for this account):
 *
 *   - the import panel (files, folders, .zip; analyzed in this tab),
 *   - Folder Sync (Chrome/Edge keep syncing a picked StarCraft II folder;
 *     other browsers get a one-off folder import),
 *   - an honest browser-vs-agent comparison with a link to /download.
 *
 * The panel and the Folder Sync card share one controller, so the panel's
 * "Sync a replay folder" button drives the card.
 *
 * Example:
 *   case "import": return <SettingsImport />;
 */
import { Section } from "@/components/ui/Section";
import { BrowserImportPanel } from "@/components/instant/BrowserImportPanel";
import { BrowserVsAgentTable } from "@/components/instant/BrowserVsAgentTable";
import { FolderSyncCard, useFolderSync } from "@/components/instant/FolderSyncCard";
import { useInstantImport } from "@/lib/instant/useInstantImport";
import { SettingsImportPanel } from "./SettingsImportPanel";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";

/**
 * The Import settings tab.
 *
 * Example:
 *   <SettingsImport />
 */
export function SettingsImport() {
  const instant = useInstantImport();
  return <div className="space-y-6"><LazyHelpLink slug="importing-replay-history">Importing your replay history</LazyHelpLink><SettingsImportPanel />{instant.enabled ? <BrowserSettingsImport /> : null}</div>;
}

function BrowserSettingsImport() {
  const folderSync = useFolderSync();
  return (
    <div className="space-y-6">
      <Section
        title="Browser import (no agent)"
        description="Analyze replays right here in your browser — on Windows, Mac, Chromebook or iPad — and upload the results to your account. Replay files stay on your device unless the backup option below is on (it starts on when backups are available)."
      >
        <BrowserImportPanel folderSync={folderSync} intro={false} />
      </Section>
      <FolderSyncCard controller={folderSync} />
      <BrowserVsAgentTable />
    </div>
  );
}
