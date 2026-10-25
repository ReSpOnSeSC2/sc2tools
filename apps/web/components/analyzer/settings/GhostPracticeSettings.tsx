"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useGhostPractice } from "@/lib/useGhostPractice";
import { GHOST_SYNC_EVENT } from "@/lib/ghostSyncModel";
import { assignGhostTarget, emptyGhostBuildConfig, readArmedGhostConfig, readArmedGhostTarget, readSavedGhostBuilds,
  type GhostBuildConfig, type GhostTarget, type SavedGhostBuild } from "@/lib/ghostBuild";
import { GhostLegacyMigration } from "./GhostLegacyMigration";
import { GhostMatchupManager } from "./GhostMatchupManager";

const migrationKey = (owner: string) => `sc2tools:ghost-build:migrated:v2:${owner}`;

export function GhostPracticeSettings() {
  const practice = useGhostPractice();
  const [browser, setBrowser] = useState<{ owner: string; legacy: GhostTarget | null; config: GhostBuildConfig | null; library: SavedGhostBuild[]; dismissed: boolean } | null>(null);
  useEffect(() => {
    const owner = practice.owner;
    if (!owner) { setBrowser(null); return; }
    const refresh = () => {
      let dismissed = false;
      try { dismissed = localStorage.getItem(migrationKey(owner)) === "1"; } catch { /* Optional preference. */ }
      setBrowser({ owner, legacy: readArmedGhostTarget(), config: readArmedGhostConfig(), library: readSavedGhostBuilds(), dismissed });
    };
    refresh(); window.addEventListener("storage", refresh); window.addEventListener(GHOST_SYNC_EVENT, refresh);
    return () => { window.removeEventListener("storage", refresh); window.removeEventListener(GHOST_SYNC_EVENT, refresh); };
  }, [practice.owner]);
  const local = browser?.owner === practice.owner ? browser : null;
  const dismiss = () => {
    if (!practice.owner) return;
    try { localStorage.setItem(migrationKey(practice.owner), "1"); } catch { /* Keep the dismissal for this visit. */ }
    setBrowser(previous => previous?.owner === practice.owner ? { ...previous, dismissed: true } : previous);
  };
  const move = async (config: GhostBuildConfig) => { if (await practice.migrate(config)) dismiss(); };
  const disabled = practice.loading || practice.saving || !!practice.readError;
  return <div id="ghost" className="min-w-0 scroll-mt-24 space-y-5">
    <p className="text-caption text-text-muted">Assignments are saved to your account. Your Ghost source URL stays the same when you change or clear a build. The desktop Companion&apos;s separate practice panel remains under its own controls.</p>
    {practice.loading ? <p role="status">Loading account assignments…</p> : null}
    {practice.readError ? <p role="status" className="text-caption text-warning">{practice.offline ? "Showing this account’s cached assignments. " : ""}Couldn&apos;t load account assignments. <button className="min-h-11 px-2 underline" onClick={practice.retry}>Try again</button></p> : null}
    {practice.error ? <p role="alert" className="text-caption text-danger">{practice.error}</p> : null}
    {local && !local.dismissed && local.config && Object.keys(local.config.slots).length ? <section className="rounded-lg border border-accent/40 bg-accent/10 p-4">
      <h3 className="font-semibold">Move this browser&apos;s assignments to your account</h3>
      <p className="mt-1 text-caption text-text-muted">Move {Object.keys(local.config.slots).length} matchup assignments so other browsers and your permanent Ghost URL can use them. Existing account slots are kept. Your browser library stays available.</p>
      <div className="mt-2 flex flex-wrap gap-2"><Button disabled={disabled} onClick={() => void move(local.config!)}>Move assignments</Button><Button variant="ghost" disabled={practice.saving} onClick={dismiss}>Keep on this browser</Button></div>
    </section> : null}
    {local && !local.dismissed && local.legacy ? <GhostLegacyMigration target={local.legacy} disabled={disabled} onMigrate={matchup => void move(assignGhostTarget(emptyGhostBuildConfig(), matchup, local.legacy!))} /> : null}
    <GhostMatchupManager loadout={practice.config} library={local?.library ?? []} disabled={disabled}
      onAssign={(matchup, build) => { void practice.assign(matchup, build.target); }} onClear={matchup => { void practice.assign(matchup, null); }} />
  </div>;
}
